/**
 * 验证「会话 → 工作区」解析与工作区级授权。
 *
 * 真实环境里 resolver 由宿主注入（workspaceRegistry 反查）；
 * 这里用假 resolver 验证 runtime 侧的语义。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LauncherRuntime } from '../lib/runtime.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-test-'))

const rt = new LauncherRuntime({
  seed: {
    sampleCacheMs: 0,
    allowedDirs: ['C:\\Global'],
    programs: [{ id: 'global-app', name: 'G', launch: { exe: 'C:\\a.exe' } }],
  },
  deps: {
    sysinfo: {
      queryGpu: async () => null, queryGpuName: async () => null,
      queryGpuProcesses: async () => [], queryCpuLoad: async () => 1,
    },
    status: { probeReady: async () => ({ ready: false, byProcess: false }), listeningPids: async () => [] },
    programs: { listeningPids: async () => [], killProcessTree: async () => ({ ok: true }), processExePath: async () => null },
    edit: { probe: () => ({ exists: true, isDirectory: false }) },
  },
  dataDir: dir,
})

let passed = 0
const fails = []
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ok  ' + name) }
  else { fails.push(name); console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')) }
}

console.log('=== resolver 未注入时 ===')
check('workspaceOfSession 返回 null', rt.workspaceOfSession('sess-1') === null)
check('scopeInfo 只给 sessionId 时工作区为空', rt.scopeInfo({ sessionId: 'sess-1' }).workspaceKey === '')

console.log('\n=== 注入 resolver 后 ===')
rt.setWorkspaceResolver((sid) => {
  if (sid === 'sess-1' || sid === 'sess-2') return { path: 'D:\\proj\\alpha', title: 'Alpha' }
  if (sid === 'sess-3') return { path: 'D:\\proj\\beta', title: 'Beta' }
  return null
})

const a = rt.workspaceOfSession('sess-1')
check('解析出工作区路径', a?.path === 'D:\\proj\\alpha', JSON.stringify(a))
check('不同会话解析到不同工作区', rt.workspaceOfSession('sess-3')?.path === 'D:\\proj\\beta')
check('未知会话返回 null', rt.workspaceOfSession('unknown') === null)

console.log('\n=== scopeInfo 自动补工作区 ===')
const info = rt.scopeInfo({ sessionId: 'sess-1' })
check('workspaceKey 被自动填充', info.workspaceKey === 'D:\\proj\\alpha', info.workspaceKey)
check('workspaceTitle 被自动填充', info.workspaceTitle === 'Alpha')

console.log('\n=== 用 sessionId 设置工作区级授权（客户端只需 sessionId） ===')
const afterSet = rt.setScopeSlice('workspace', 'sess-1', {
  allowedDirs: ['D:\\proj\\alpha\\models'],
  programs: [],
}, 'from session menu')
check('写入落到正确的工作区路径', afterSet.workspaceKey === 'D:\\proj\\alpha', afterSet.workspaceKey)
check(
  '目录已加入',
  rt.scopeInfo({ workspacePath: 'D:\\proj\\alpha' }).layers.workspace.allowedDirs.includes('D:\\proj\\alpha\\models'),
)

console.log('\n=== 同工作区另一会话继承（工作区级语义） ===')
const otherSession = rt.scopeInfo({ sessionId: 'sess-2' })
check('sess-2 继承 sess-1 所属工作区的授权', otherSession.effective.allowedDirs.includes('D:\\proj\\alpha\\models'))

console.log('\n=== 不同工作区不受影响 ===')
const beta = rt.scopeInfo({ sessionId: 'sess-3' })
check('Beta 看不到 Alpha 的目录', !beta.effective.allowedDirs.includes('D:\\proj\\alpha\\models'))

console.log('\n=== 无法解析时报错而非静默写错 ===')
let threw = false
try {
  rt.setScopeSlice('workspace', 'no-such-session', { allowedDirs: ['C:\\x'], programs: [] })
} catch {
  threw = true
}
check('未知会话写入被拒绝', threw)

rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${passed} 项，失败 ${fails.length} 项`)
if (fails.length > 0) process.exit(1)
