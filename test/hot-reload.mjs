/**
 * 热加载测试：授权写入后，**同一个 runtime 实例**下次调用立即可见。
 *
 * 这是核心承诺：不需要重开会话、不需要重启宿主、不需要重建 runtime。
 * poolVersion 2 的授权写入 = setEntrySessions / addEntry / updateEntry / removeEntry。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LauncherRuntime } from '../lib/runtime.mjs'

const tmpDirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hot-test-'))
  tmpDirs.push(dir)
  return dir
}

function makeRuntime(dir, seed = {}) {
  return new LauncherRuntime({
    seed: { sampleCacheMs: 0, ...seed },
    deps: {
      sysinfo: {
        queryGpu: async () => ({ utilPct: 3, usedMiB: 100, totalMiB: 16303, freeMiB: 16203 }),
        queryGpuName: async () => 'Fake', queryGpuProcesses: async () => [], queryCpuLoad: async () => 5,
      },
      status: { probeReady: async () => ({ ready: false, byProcess: false }), listeningPids: async () => [] },
      programs: { listeningPids: async () => [], killProcessTree: async () => ({ ok: true }), processExePath: async () => null },
      edit: { probe: () => ({ exists: true, isDirectory: false }) },
    },
    dataDir: dir,
  })
}

let passed = 0
const fails = []
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ok  ' + name) }
  else { fails.push(name); console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')) }
}

const rt = makeRuntime(tempDir(), {
  programs: [{ id: 'app-a', name: 'AppA', launch: { exe: 'C:\\a.exe' }, sessions: [] }],
})

/** 模拟一次 tool 调用：执行时进入 exec.agent 的作用域。 */
const toolCall = (sessionId, fn) => rt.withAgentScope({ agent: { id: sessionId } }, fn)

console.log('=== 授权前 ===')
const before = await toolCall('sess-A', () => rt.visiblePrograms().map((p) => p.id))
check('未授权的会话什么都看不到', before.length === 0, JSON.stringify(before))

console.log('\n=== 写入会话授权（同一个 runtime 实例，不重建） ===')
rt.setEntrySessions('app-a', ['sess-A'])

console.log('\n=== 授权后：立刻可见（无需重启/重开会话） ===')
const after = await toolCall('sess-A', () => rt.visiblePrograms().map((p) => p.id))
check('立刻看到被授权的程序', after.includes('app-a'), JSON.stringify(after))

console.log('\n=== 别的会话不受影响 ===')
const other = await toolCall('sess-B', () => rt.visiblePrograms().map((p) => p.id))
check('sess-B 看不到授给 sess-A 的程序', !other.includes('app-a'), JSON.stringify(other))

console.log('\n=== 目录条目授权也是热加载 ===')
rt.addEntry({ name: '模型目录', kind: 'directory', path: 'E:\\models', sessions: ['sess-A'] })
const dirsAfter = await toolCall('sess-A', () => rt.allowedDirsOf('app-a'))
check('立刻看到新授权的目录', dirsAfter.includes('E:\\models'), JSON.stringify(dirsAfter))
const dirsB = await toolCall('sess-B', () => rt.allowedDirsOf('app-a'))
check('sess-B 看不到该目录', !dirsB.includes('E:\\models'), JSON.stringify(dirsB))

console.log('\n=== 新增条目热加载 ===')
rt.addEntry({ name: '新软件', launch: { exe: 'C:\\new.exe' }, sessions: ['sess-A'] })
const added = await toolCall('sess-A', () => rt.visiblePrograms().map((p) => p.id))
check('新增条目立刻可见', added.some((id) => id !== 'app-a'), JSON.stringify(added))

console.log('\n=== 撤销后立刻消失（同样是热加载） ===')
rt.setEntrySessions('app-a', [])
const revoked = await toolCall('sess-A', () => rt.visiblePrograms().map((p) => p.id))
check('撤销后看不到该程序', !revoked.includes('app-a'), JSON.stringify(revoked))

console.log('\n=== 删除条目热加载 ===')
const newId = rt.currentConfig().programs.find((p) => p.launch?.exe === 'C:\\new.exe').id
rt.removeEntry(newId)
const removed = await toolCall('sess-A', () => rt.visiblePrograms().map((p) => p.id))
check('删除后立刻消失', !removed.includes(newId), JSON.stringify(removed))

console.log('\n=== 快照缓存不会挡住授权变更 ===')
{
  const dir = tempDir()
  const cached = makeRuntime(dir, {
    sampleCacheMs: 60000,
    programs: [{ id: 'c-app', name: 'C', launch: { exe: 'C:\\c.exe' }, sessions: [] }],
  })
  const snap1 = await cached.withAgentScope({ agent: { id: 'sess-X' } }, () => cached.snapshot())
  check('授权前快照为空', snap1.programs.length === 0)
  cached.setEntrySessions('c-app', ['sess-X'])
  const snap2 = await cached.withAgentScope({ agent: { id: 'sess-X' } }, () => cached.snapshot())
  check('授权后快照立刻更新（缓存已失效）', snap2.programs.some((p) => p.id === 'c-app'),
    JSON.stringify(snap2.programs.map((p) => p.id)))
}

console.log('\n=== 全局开关热加载：tool 挂载/卸载 ===')
{
  let mounted = 0
  let unmounted = 0
  const dir = tempDir()
  const toggled = new LauncherRuntime({
    seed: { sampleCacheMs: 0, enabled: true, programs: [] },
    deps: {
      sysinfo: {
        queryGpu: async () => null, queryGpuName: async () => null,
        queryGpuProcesses: async () => [], queryCpuLoad: async () => 1,
      },
      status: { probeReady: async () => ({ ready: false }), listeningPids: async () => [] },
      programs: { listeningPids: async () => [], killProcessTree: async () => ({ ok: true }), processExePath: async () => null },
      edit: { probe: () => ({ exists: true, isDirectory: false }) },
    },
    mountTools: () => { mounted += 1; return [() => { unmounted += 1 }] },
    dataDir: dir,
  })
  check('启动即挂载', toggled.toolsMounted === true && mounted === 1)
  toggled.setGlobal({ enabled: false })
  check('禁用立刻卸载', toggled.toolsMounted === false && unmounted === 1)
  toggled.setGlobal({ enabled: true })
  check('再启用立刻挂回', toggled.toolsMounted === true && mounted === 2)
}

for (const dir of tmpDirs) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}
console.log(`\n通过 ${passed} 项，失败 ${fails.length} 项`)
if (fails.length > 0) process.exit(1)