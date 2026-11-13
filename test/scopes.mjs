/**
 * 三级作用域授权的测试：全局 / 工作区 / 会话。
 *
 * 重点验证「生效范围 = 三层并集」与「同 id 后者覆盖前者」这两条语义。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LauncherRuntime } from '../lib/runtime.mjs'
import { createScopeStore, mergeDirs, mergePrograms } from '../lib/scopes.mjs'

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

// ---------- 纯函数 ----------

section('scopes 合并语义')

await test('mergeDirs 三层并集去重（大小写/斜杠不敏感）', () => {
  const merged = mergeDirs(['C:\\A'], ['C:\\B', 'c:/a'], ['D:\\C'])
  assert.deepEqual(merged, ['C:\\A', 'C:\\B', 'D:\\C'])
})

await test('mergeDirs 容忍 undefined / 空层', () => {
  assert.deepEqual(mergeDirs(undefined, ['C:\\A'], undefined), ['C:\\A'])
  assert.deepEqual(mergeDirs(), [])
})

await test('mergePrograms 同 id 后者覆盖前者，并记录来源', () => {
  const global = [{ id: 'app', name: 'Global' }, { id: 'g2', name: 'G2' }]
  const ws = [{ id: 'app', name: 'Workspace' }]
  const ss = [{ id: 's1', name: 'S1' }]
  const { programs, origin } = mergePrograms(global, ws, ss)
  const ids = programs.map((p) => p.id)
  assert.ok(ids.includes('app') && ids.includes('g2') && ids.includes('s1'))
  assert.equal(programs.find((p) => p.id === 'app').name, 'Workspace', '会话/工作区覆盖全局')
  assert.equal(origin.get('app'), 'workspace')
  assert.equal(origin.get('g2'), 'global')
  assert.equal(origin.get('s1'), 'session')
})

// ---------- 存储 ----------

section('scopes 存储')

await test('每层独立存储，互不影响', () => {
  const dir = tempDir()
  const store = createScopeStore({ dataDir: dir })
  store.setSlice('workspace', 'D:\\proj', { allowedDirs: ['D:\\proj\\models'], programs: [] })
  store.setSlice('session', 'sess-1', { allowedDirs: ['E:\\tmp'], programs: [] })

  assert.deepEqual(store.slice('workspace', 'D:\\proj').allowedDirs, ['D:\\proj\\models'])
  assert.deepEqual(store.slice('session', 'sess-1').allowedDirs, ['E:\\tmp'])
  assert.deepEqual(store.slice('workspace', 'D:\\other').allowedDirs, [], '未授权的工作区为空')
})

await test('落盘后新实例能读回（模拟重启）', () => {
  const dir = tempDir()
  createScopeStore({ dataDir: dir }).setSlice('workspace', 'D:\\proj', { allowedDirs: ['D:\\m'], programs: [] })
  const reopened = createScopeStore({ dataDir: dir })
  assert.deepEqual(reopened.slice('workspace', 'D:\\proj').allowedDirs, ['D:\\m'])
})

await test('清空后该层从文件里消失（不堆积空壳）', () => {
  const dir = tempDir()
  const store = createScopeStore({ dataDir: dir })
  store.setSlice('session', 's1', { allowedDirs: ['C:\\A'], programs: [] })
  assert.equal(JSON.stringify(store.keys()).includes('s1'), true)
  store.clearSlice('session', 's1')
  assert.equal(JSON.stringify(store.keys()).includes('s1'), false)
})

await test('授权记录按新→旧返回，并保留作用域信息', () => {
  const dir = tempDir()
  const store = createScopeStore({ dataDir: dir })
  store.addGrant({ scope: 'global', kind: 'dir', action: 'add', target: 'C:\\A' })
  store.addGrant({ scope: 'session', scopeKey: 's1', kind: 'program', action: 'add', target: 'tool' })
  const grants = store.grants(10)
  assert.equal(grants.length, 2)
  assert.equal(grants[0].scope, 'session', '最新的在最前')
  assert.equal(grants[0].scopeKey, 's1')
  assert.equal(grants[1].scope, 'global')
})

// ---------- runtime 集成 ----------

section('runtime 作用域生效')

const GLOBAL_SEED = {
  programs: [{ id: 'global-app', name: 'GlobalApp', launch: { exe: 'C:\\a.exe' } }],
  allowedDirs: ['C:\\GlobalDir'],
}

await test('scopeInfo 的三层结构与计数正确', () => {
  const dir = tempDir()
  const rt = makeRuntime(GLOBAL_SEED, dir)
  rt.setScopeSlice('workspace', 'D:\\proj', { allowedDirs: ['D:\\ws'], programs: [] })
  rt.setScopeSlice('session', 's1', { allowedDirs: ['E:\\ss'], programs: [] })

  const info = rt.scopeInfo({ workspacePath: 'D:\\proj', sessionId: 's1' })
  assert.equal(info.layers.global.allowedDirs.length, 1)
  assert.equal(info.layers.workspace.allowedDirs.length, 1)
  assert.equal(info.layers.session.allowedDirs.length, 1)
  assert.equal(info.effective.allowedDirs.length, 3, '三层并集')
  assert.equal(info.counts.effectiveDirs, 3)
})

await test('只配工作区时，其它工作区不受影响', () => {
  const dir = tempDir()
  const rt = makeRuntime(GLOBAL_SEED, dir)
  rt.setScopeSlice('workspace', 'D:\\proj', { allowedDirs: ['D:\\proj\\models'], programs: [] })

  const mine = rt.scopeInfo({ workspacePath: 'D:\\proj' })
  const other = rt.scopeInfo({ workspacePath: 'D:\\other' })
  assert.ok(mine.effective.allowedDirs.includes('D:\\proj\\models'))
  assert.equal(other.effective.allowedDirs.includes('D:\\proj\\models'), false, '别的工区看不到')
})

await test('会话级条目覆盖全局同 id 程序', () => {
  const dir = tempDir()
  const rt = makeRuntime(GLOBAL_SEED, dir)
  rt.setScopeSlice('session', 's1', {
    allowedDirs: [],
    programs: [{ id: 'global-app', name: 'Overridden', launch: { exe: 'C:\\b.exe' } }],
  })
  const info = rt.scopeInfo({ sessionId: 's1' })
  const entry = info.effective.programs.find((p) => p.id === 'global-app')
  assert.equal(entry.origin, 'session', '会话级覆盖生效')
})

await test('会话级新增的程序在 visiblePrograms 里可见', () => {
  const dir = tempDir()
  const rt = makeRuntime(GLOBAL_SEED, dir)
  rt.setScopeSlice('session', 's1', {
    allowedDirs: [],
    programs: [{ id: 'session-tool', name: 'SessionTool', launch: { exe: 'C:\\t.exe' } }],
  })
  rt.withScope({ sessionId: 's1' }, () => {
    const ids = rt.visiblePrograms().map((p) => p.id)
    assert.ok(ids.includes('session-tool'), '本会话可见')
    assert.ok(ids.includes('global-app'), '全局的也在')
  })
  // 换个会话就看不到
  rt.withScope({ sessionId: 's2' }, () => {
    const ids = rt.visiblePrograms().map((p) => p.id)
    assert.equal(ids.includes('session-tool'), false, '别的会话看不到')
  })
})

await test('allowedDirsOf 把三层目录合并进来', () => {
  const dir = tempDir()
  const rt = makeRuntime(GLOBAL_SEED, dir)
  rt.setScopeSlice('workspace', 'D:\\proj', { allowedDirs: ['D:\\ws'], programs: [] })
  rt.setScopeSlice('session', 's1', { allowedDirs: ['E:\\ss'], programs: [] })

  rt.withScope({ workspacePath: 'D:\\proj', sessionId: 's1' }, () => {
    const dirs = rt.allowedDirsOf('global-app')
    assert.ok(dirs.includes('C:\\GlobalDir'))
    assert.ok(dirs.includes('D:\\ws'))
    assert.ok(dirs.includes('E:\\ss'))
  })
})

await test('清空作用域后条目不再可见', () => {
  const dir = tempDir()
  const rt = makeRuntime(GLOBAL_SEED, dir)
  rt.setScopeSlice('session', 's1', {
    allowedDirs: [],
    programs: [{ id: 'tmp-app', name: 'Tmp', launch: { exe: 'C:\\t.exe' } }],
  })
  rt.clearScope('session', 's1')
  rt.withScope({ sessionId: 's1' }, () => {
    assert.equal(rt.visiblePrograms().map((p) => p.id).includes('tmp-app'), false)
  })
})

await test('scope 写入会记录授权（可审计）', () => {
  const dir = tempDir()
  const rt = makeRuntime(GLOBAL_SEED, dir)
  rt.setScopeSlice('workspace', 'D:\\proj', { allowedDirs: ['D:\\x'], programs: [] }, '测试用')
  const grants = rt.grants(10)
  assert.ok(grants.length >= 1)
  assert.equal(grants[0].scope, 'workspace')
  assert.equal(grants[0].scopeKey, 'D:\\proj')
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
