/**
 * 条目池 + 会话授权（poolVersion 2）的测试。
 *
 * 旧版「全局/工作区/会话」三层切片已废除。现在的语义：
 *  - 统一条目池：软件 / 脚本 / 目录都是条目，每个条目带 sessions[] 授权列表；
 *  - 管理面（设置页，无作用域）看全部条目；
 *  - Agent 工具（withAgentScope）只看到 sessions 里有自己会话 id 的条目；
 *  - 全局授权目录废除：目录也是条目，未授权任何会话 = 谁都用不了；
 *  - 旧数据一次性迁移：切片授权折进 sessions，全局目录变成未授权条目。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LauncherRuntime } from '../lib/runtime.mjs'
import { createScopeStore, mergeDirs } from '../lib/scopes.mjs'

const tmpDirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scope-test-'))
  tmpDirs.push(dir)
  return dir
}

let passed = 0
const failures = []
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed += 1
    console.log(`  ok  ${name}`)
  }).catch((error) => {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  })
}
function section(title) { console.log(`\n=== ${title} ===`) }

const ALWAYS_EXISTS = () => ({ exists: true, isDirectory: false })

function makeRuntime(seed, dir) {
  return new LauncherRuntime({
    seed: { sampleCacheMs: 0, ...seed },
    deps: {
      sysinfo: {
        queryGpu: async () => ({ utilPct: 3, usedMiB: 100, totalMiB: 16303, freeMiB: 16203 }),
        queryGpuName: async () => 'Fake',
        queryGpuProcesses: async () => [],
        queryCpuLoad: async () => 5,
      },
      status: { probeReady: async () => ({ ready: false, byProcess: false }), listeningPids: async () => [] },
      programs: { listeningPids: async () => [], killProcessTree: async () => ({ ok: true }), processExePath: async () => null },
      edit: { probe: ALWAYS_EXISTS },
    },
    dataDir: dir,
  })
}

/** 预写旧版 config.json / scopes.json（模拟从 poolVersion 1 升级）。 */
function writeLegacy(dir, config, scopes) {
  mkdirSync(dir, { recursive: true })
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
  if (scopes) writeFileSync(join(dir, 'scopes.json'), JSON.stringify(scopes, null, 2), 'utf8')
}

const PROGRAM_A = { id: 'app-a', name: 'AppA', launch: { exe: 'C:\\a.exe' } }

// ---------- 纯函数 ----------

section('目录合并语义')

await test('mergeDirs 并集去重（大小写/斜杠不敏感）', () => {
  const merged = mergeDirs(['C:\\A'], ['C:\\B', 'c:/a'], ['D:\\C'])
  assert.deepEqual(merged, ['C:\\A', 'C:\\B', 'D:\\C'])
})

await test('mergeDirs 容忍 undefined / 空层', () => {
  assert.deepEqual(mergeDirs(undefined, ['C:\\A'], undefined), ['C:\\A'])
  assert.deepEqual(mergeDirs(), [])
})

// ---------- 审计存储 ----------

section('scopes 存储（审计 + 旧切片迁移读取）')

await test('旧切片可读出，consume 后清空且落盘', () => {
  const dir = tempDir()
  writeLegacy(dir, null, {
    version: 1,
    workspaces: { 'D:\\proj': { allowedDirs: ['D:\\m'], programs: [] } },
    sessions: { 's1': { allowedDirs: ['E:\\t'], programs: [] } },
    grants: [],
  })
  const store = createScopeStore({ dataDir: dir })
  assert.equal(store.hasLegacySlices(), true)
  const legacy = store.legacySlices()
  assert.deepEqual(legacy.sessions.s1.allowedDirs, ['E:\\t'])
  assert.deepEqual(legacy.workspaces['D:\\proj'].allowedDirs, ['D:\\m'])

  store.consumeLegacySlices()
  assert.equal(store.hasLegacySlices(), false)
  const reopened = createScopeStore({ dataDir: dir })
  assert.equal(reopened.hasLegacySlices(), false, '重启后仍记得已迁移')
  assert.deepEqual(reopened.legacySlices().sessions, {})
})

await test('授权记录新→旧，默认 scope=entry，limit 生效', () => {
  const dir = tempDir()
  const store = createScopeStore({ dataDir: dir })
  store.addGrant({ scopeKey: 'app-a', action: 'add', target: 's1' })
  store.addGrant({ scopeKey: 'app-a', action: 'remove', target: 's1' })
  const grants = store.grants(10)
  assert.equal(grants.length, 2)
  assert.equal(grants[0].action, 'remove', '最新的在最前')
  assert.equal(grants[0].scope, 'entry')
  assert.equal(grants[0].scopeKey, 'app-a')
  assert.equal(store.grants(1).length, 1)
})

// ---------- 可见性 ----------

section('条目级会话授权：可见性')

const POOL_SEED = {
  programs: [
    { ...PROGRAM_A, sessions: ['s1'] },
    { id: 'app-b', name: 'AppB', launch: { exe: 'C:\\b.exe' }, sessions: ['s2'] },
    { id: 'app-c', name: 'AppC', launch: { exe: 'C:\\c.exe' }, sessions: [] },
    { id: 'dir-x', name: 'DirX', kind: 'directory', path: 'E:\\models', sessions: ['s1'] },
  ],
}

await test('管理面（无作用域）看到全部条目，包括未授权的', () => {
  const rt = makeRuntime(POOL_SEED, tempDir())
  const ids = rt.visiblePrograms().map((p) => p.id)
  assert.deepEqual(ids.sort(), ['app-a', 'app-b', 'app-c'])
  assert.equal(rt.scopeContext(), null)
})

await test('会话只看到授权给自己的条目', () => {
  const rt = makeRuntime(POOL_SEED, tempDir())
  rt.withScope({ sessionId: 's1' }, () => {
    assert.deepEqual(rt.visiblePrograms().map((p) => p.id), ['app-a'])
  })
  rt.withScope({ sessionId: 's2' }, () => {
    assert.deepEqual(rt.visiblePrograms().map((p) => p.id), ['app-b'])
  })
  rt.withScope({ sessionId: 's3' }, () => {
    assert.deepEqual(rt.visiblePrograms(), [], '没授权任何条目的会话什么都看不到')
  })
})

await test('空 sessionId fail-closed：不退化成管理面', () => {
  const rt = makeRuntime(POOL_SEED, tempDir())
  rt.withScope({ sessionId: '' }, () => {
    assert.deepEqual(rt.visiblePrograms(), [])
    assert.deepEqual(rt.visibleDirectories(), [])
  })
})

await test('withAgentScope 从 exec.agent.id 取会话；缺失时 fail-closed', async () => {
  const rt = makeRuntime(POOL_SEED, tempDir())
  await rt.withAgentScope({ agent: { id: 's1' } }, async () => {
    assert.deepEqual(rt.visiblePrograms().map((p) => p.id), ['app-a'])
  })
  await rt.withAgentScope({}, async () => {
    assert.deepEqual(rt.visiblePrograms(), [], '拿不到会话 id 时宁可全拒')
  })
  assert.equal(rt.scopeContext(), null, '作用域用完即还原')
})

await test('directory 条目不进 visiblePrograms，只进 visibleDirectories', () => {
  const rt = makeRuntime(POOL_SEED, tempDir())
  rt.withScope({ sessionId: 's1' }, () => {
    assert.equal(rt.visiblePrograms().some((p) => p.kind === 'directory'), false)
    const dirs = rt.visibleDirectories()
    assert.deepEqual(dirs.map((d) => d.id), ['dir-x'])
    assert.equal(dirs[0].path, 'E:\\models')
  })
})

await test('allowedDirsOf = 程序自身目录 + 本会话可见的目录条目', () => {
  const seed = {
    programs: [
      { ...PROGRAM_A, sessions: ['s1'], allowedDirs: ['F:\\own'] },
      { id: 'dir-x', name: 'DirX', kind: 'directory', path: 'E:\\models', sessions: ['s1'] },
      { id: 'dir-y', name: 'DirY', kind: 'directory', path: 'E:\\other', sessions: ['s2'] },
    ],
  }
  const rt = makeRuntime(seed, tempDir())
  rt.withScope({ sessionId: 's1' }, () => {
    const dirs = rt.allowedDirsOf('app-a')
    assert.ok(dirs.includes('F:\\own'), '程序自己的目录')
    assert.ok(dirs.includes('E:\\models'), '授权给本会话的目录条目')
    assert.equal(dirs.includes('E:\\other'), false, '别的会话的目录条目不可见')
  })
  // 管理面：所有目录条目都在
  const adminDirs = rt.allowedDirsOf('app-a')
  assert.ok(adminDirs.includes('E:\\models') && adminDirs.includes('E:\\other'))
})

await test('快照缓存按作用域分键：管理面与会话不互用', async () => {
  const rt = makeRuntime({ ...POOL_SEED, sampleCacheMs: 60000 }, tempDir())
  const admin = await rt.snapshot()
  assert.ok(admin.programs.some((p) => p.id === 'app-c'), '管理面含未授权条目')
  const scoped = await rt.withScope({ sessionId: 's1' }, () => rt.snapshot())
  assert.deepEqual(scoped.programs.map((p) => p.id), ['app-a'], '会话快照不能复用管理面缓存')
  assert.deepEqual(scoped.directories.map((d) => d.id), ['dir-x'])
})

// ---------- 授权编辑与审计 ----------

section('授权编辑与审计')

await test('setEntrySessions 授权/收回，并记录 add/remove 审计', () => {
  const rt = makeRuntime(POOL_SEED, tempDir())
  rt.setEntrySessions('app-c', ['s9'], '测试授权')
  rt.withScope({ sessionId: 's9' }, () => {
    assert.ok(rt.visiblePrograms().some((p) => p.id === 'app-c'))
  })
  rt.setEntrySessions('app-c', [], '收回')
  rt.withScope({ sessionId: 's9' }, () => {
    assert.equal(rt.visiblePrograms().some((p) => p.id === 'app-c'), false)
  })
  const grants = rt.grants(10)
  assert.equal(grants[0].action, 'remove')
  assert.equal(grants[0].scopeKey, 'app-c')
  assert.equal(grants[0].target, 's9')
  assert.ok(grants.some((g) => g.action === 'add' && g.target === 's9'))
})

await test('setEntrySessions 未知条目报错', () => {
  const rt = makeRuntime(POOL_SEED, tempDir())
  assert.throws(() => rt.setEntrySessions('no-such', ['s1']), /找不到条目/)
})

await test('currentConfig 暴露 poolVersion/unauthCount，且不再有 allowedDirs', () => {
  const rt = makeRuntime(POOL_SEED, tempDir())
  const cfg = rt.currentConfig()
  assert.equal(cfg.poolVersion, 2)
  assert.equal(cfg.unauthCount, 1, '只有 app-c 未授权任何会话')
  assert.deepEqual(cfg.migrationPending, [])
  assert.equal('allowedDirs' in cfg, false, '全局授权目录字段已移除')
})

await test('setGlobal 拒绝写 allowedDirs（全局授权已废除）', () => {
  const rt = makeRuntime(POOL_SEED, tempDir())
  assert.throws(() => rt.setGlobal({ allowedDirs: ['C:\\x'] }), /全局授权目录已废除/)
})

await test('条目 CRUD 带 kind/sessions/path 落盘再读回', () => {
  const dir = tempDir()
  const rt = makeRuntime({ programs: [] }, dir)
  rt.addEntry({ name: '我的目录', kind: 'directory', path: 'H:\\models', sessions: ['s1'] })
  rt.addEntry({ name: '跑脚本', kind: 'script', launch: { exe: 'D:\\run.ps1' }, sessions: ['s2'] })

  const reopened = makeRuntime({ programs: [] }, dir)
  const entries = reopened.currentConfig().programs
  const dirEntry = entries.find((e) => e.kind === 'directory')
  assert.equal(dirEntry.path, 'H:\\models')
  assert.deepEqual(dirEntry.sessions, ['s1'])
  const scriptEntry = entries.find((e) => e.kind === 'script')
  assert.equal(scriptEntry.launch.exe, 'D:\\run.ps1')
  assert.deepEqual(scriptEntry.sessions, ['s2'])

  reopened.setEntrySessions(dirEntry.id, ['s1', 's3'])
  reopened.removeEntry(scriptEntry.id)
  const again = makeRuntime({ programs: [] }, dir)
  const left = again.currentConfig().programs
  assert.equal(left.length, 1)
  assert.deepEqual(left[0].sessions, ['s1', 's3'])
})

// ---------- 旧数据迁移 ----------

section('poolVersion 1 → 2 迁移')

await test('全局目录/会话切片折叠为条目级授权，切片清空', () => {
  const dir = tempDir()
  writeLegacy(dir, {
    enabled: true,
    allowedDirs: ['C:\\GlobalDir'],
    programs: [PROGRAM_A],
  }, {
    version: 1,
    workspaces: {},
    sessions: {
      'sess-1': {
        allowedDirs: ['E:\\SessionDir'],
        programs: [PROGRAM_A, { id: 'sess-tool', name: 'SessTool', launch: { exe: 'C:\\t.exe' } }],
      },
    },
    grants: [],
  })
  const rt = makeRuntime({ programs: [] }, dir)
  const cfg = rt.currentConfig()
  assert.equal(cfg.poolVersion, 2)

  const entries = cfg.programs
  const appA = entries.find((e) => e.id === 'app-a')
  assert.deepEqual(appA.sessions, ['sess-1'], '旧会话切片的程序授权折进 sessions')
  const sessTool = entries.find((e) => e.id === 'sess-tool')
  assert.deepEqual(sessTool.sessions, ['sess-1'], '切片独有条目补进池并带授权')

  const dirs = entries.filter((e) => e.kind === 'directory')
  assert.equal(dirs.length, 2)
  const globalDir = dirs.find((d) => d.path === 'C:\\GlobalDir')
  assert.deepEqual(globalDir.sessions, [], '全局目录不预授权任何会话（收缩的本意）')
  const sessionDir = dirs.find((d) => d.path === 'E:\\SessionDir')
  assert.deepEqual(sessionDir.sessions, ['sess-1'])

  assert.equal(rt.scopes.hasLegacySlices(), false, '切片已消费')
  assert.ok(rt.grants(20).some((g) => g.action === 'migrate'))

  // 重启后不再重复迁移
  const reopened = makeRuntime({ programs: [] }, dir)
  assert.equal(reopened.currentConfig().programs.length, entries.length)
})

await test('迁移后会话可见性立即生效', () => {
  const dir = tempDir()
  writeLegacy(dir, { allowedDirs: [], programs: [PROGRAM_A] }, {
    version: 1, workspaces: {},
    sessions: { 'sess-1': { allowedDirs: [], programs: [PROGRAM_A] } },
    grants: [],
  })
  const rt = makeRuntime({ programs: [] }, dir)
  rt.withScope({ sessionId: 'sess-1' }, () => {
    assert.deepEqual(rt.visiblePrograms().map((p) => p.id), ['app-a'])
  })
  rt.withScope({ sessionId: 'sess-2' }, () => {
    assert.deepEqual(rt.visiblePrograms(), [])
  })
})

await test('resetConfig 后仍是 poolVersion 2（重跑迁移不回落）', () => {
  const rt = makeRuntime({ programs: [{ ...PROGRAM_A, sessions: ['s1'] }] }, tempDir())
  const cfg = rt.resetConfig()
  assert.equal(cfg.poolVersion, 2)
  assert.ok(Array.isArray(cfg.programs))
})

// ---------- 收尾 ----------

for (const dir of tmpDirs) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.log(`\nFAILED: ${name}\n${error?.stack ?? error}`)
  process.exit(1)
}