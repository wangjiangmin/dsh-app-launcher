/**
 * 热加载测试：授权写入后，**同一个 runtime 实例**下次调用立即可见。
 *
 * 这是核心承诺：不需要重开会话、不需要重启宿主、不需要重建 runtime。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LauncherRuntime } from '../lib/runtime.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dsh-hot-test-'))

const rt = new LauncherRuntime({
  seed: {
    sampleCacheMs: 0,
    programs: [{ id: 'global-app', name: 'Global', launch: { exe: 'C:\\g.exe' } }],
    allowedDirs: ['C:\\Global'],
  },
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

// 模拟宿主注入的会话 → 工作区解析
rt.setWorkspaceResolver((sid) => {
  if (sid === 'sess-A') return { path: 'D:\\wsA', title: 'WS A' }
  if (sid === 'sess-B') return { path: 'D:\\wsB', title: 'WS B' }
  return null
})

let passed = 0
const fails = []
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ok  ' + name) }
  else { fails.push(name); console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')) }
}

/** 模拟一次 tool 调用：执行时进入 exec.agent 的作用域。 */
const toolCall = (sessionId, fn) => rt.withAgentScope({ agent: { id: sessionId } }, fn)

console.log('=== 授权前 ===')
const before = await toolCall('sess-A', () => rt.visiblePrograms().map((p) => p.id))
check('只看到全局程序', before.length === 1 && before[0] === 'global-app', JSON.stringify(before))

const dirsBefore = await toolCall('sess-A', () => rt.allowedDirsOf('global-app'))
check('只有全局目录', dirsBefore.length === 1, JSON.stringify(dirsBefore))

console.log('\n=== 写入会话级授权（同一个 runtime 实例，不重建） ===')
rt.setScopeSlice('session', 'sess-A', {
  allowedDirs: ['D:\\A-extra'],
  programs: [{ id: 'session-app', name: 'SessionApp', launch: { exe: 'C:\\s.exe' } }],
})

console.log('\n=== 授权后：立刻可见（无需重启/重开会话） ===')
const after = await toolCall('sess-A', () => rt.visiblePrograms().map((p) => p.id))
check('立刻看到会话级程序', after.includes('session-app'), JSON.stringify(after))
check('全局程序仍在', after.includes('global-app'))

const dirsAfter = await toolCall('sess-A', () => rt.allowedDirsOf('global-app'))
check('立刻看到会话级目录', dirsAfter.includes('D:\\A-extra'), JSON.stringify(dirsAfter))

console.log('\n=== 别的会话不受影响 ===')
const other = await toolCall('sess-B', () => rt.visiblePrograms().map((p) => p.id))
check('sess-B 看不到 sess-A 的程序', !other.includes('session-app'), JSON.stringify(other))

console.log('\n=== 写入工作区级授权：同工作区另一会话立刻可见 ===')
rt.setScopeSlice('workspace', 'sess-A', {
  allowedDirs: ['D:\\wsA-models'],
  programs: [{ id: 'ws-app', name: 'WsApp', launch: { exe: 'C:\\w.exe' } }],
})
const sameWs = await toolCall('sess-B', () => ({
  // sess-B 属于 D:\wsB，看不到 A 的工作区授权
  ids: rt.visiblePrograms().map((p) => p.id),
}))

// 再加一个属于 sess-A 同一工作区的会话，确认继承
rt.setWorkspaceResolver((sid) => {
  if (sid === 'sess-A' || sid === 'sess-C') return { path: 'D:\\wsA', title: 'WS A' }
  if (sid === 'sess-B') return { path: 'D:\\wsB', title: 'WS B' }
  return null
})
const sibling = await toolCall('sess-C', () => rt.visiblePrograms().map((p) => p.id))
check('同工作区的 sess-C 继承工作区程序', sibling.includes('ws-app'), JSON.stringify(sibling))
check('sess-B（另一工作区）看不到', !sameWs.ids.includes('ws-app'), JSON.stringify(sameWs.ids))

console.log('\n=== 撤销后立刻消失（同样是热加载） ===')
rt.clearScope('session', 'sess-A')
const revoked = await toolCall('sess-A', () => rt.visiblePrograms().map((p) => p.id))
check('撤销后看不到会话级程序', !revoked.includes('session-app'), JSON.stringify(revoked))
check('全局程序仍在', revoked.includes('global-app'))

console.log('\n=== workspacePath 覆盖（设置页指定工作区时） ===')
const byPath = rt.scopeInfo({ workspacePath: 'D:\\wsA' })
check('按路径查得到工作区级程序', byPath.layers.workspace.programs.includes('ws-app'))
check('按路径查不附带会话级',
  !byPath.effective.programs.some((p) => p.id === 'session-app'),
  JSON.stringify(byPath.effective.programs.map((p) => p.id)))

console.log('\n=== 全局层：目录与程序一起写（曾静默丢弃程序） ===')
const dir2 = mkdtempSync(join(tmpdir(), 'dsh-hot-global-'))
const rt2 = new LauncherRuntime({
  seed: { sampleCacheMs: 0, programs: [], allowedDirs: [] },
  deps: {
    sysinfo: {
      queryGpu: async () => null, queryGpuName: async () => null,
      queryGpuProcesses: async () => [], queryCpuLoad: async () => 1,
    },
    status: { probeReady: async () => ({ ready: false }), listeningPids: async () => [] },
    programs: { listeningPids: async () => [], killProcessTree: async () => ({ ok: true }), processExePath: async () => null },
    edit: { probe: () => ({ exists: true, isDirectory: false }) },
  },
  dataDir: dir2,
})
rt2.setScopeSlice('global', '', {
  allowedDirs: ['C:\\G1'],
  programs: [{ id: 'g-app', name: 'GApp', launch: { exe: 'C:\\g.exe' } }],
})
check('全局层程序被保存（不再丢弃）', rt2.currentConfig().programs.some((p) => p.id === 'g-app'))
check('全局层目录被保存', rt2.currentConfig().allowedDirs.includes('C:\\G1'))

// 只改目录时程序应保留（不传 programs 字段）
rt2.setScopeSlice('global', '', { allowedDirs: ['C:\\G1', 'C:\\G2'] })
check('只改目录时程序保留', rt2.currentConfig().programs.some((p) => p.id === 'g-app'))
check('目录已更新', rt2.currentConfig().allowedDirs.length === 2)

// 传空 programs 表示清空
rt2.setScopeSlice('global', '', { allowedDirs: ['C:\\G1'], programs: [] })
check('传空 programs 清空程序', rt2.currentConfig().programs.length === 0)

rmSync(dir2, { recursive: true, force: true })

rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${passed} 项，失败 ${fails.length} 项`)
if (fails.length > 0) process.exit(1)
