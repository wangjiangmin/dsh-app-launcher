/**
 * 工作区旧授权展开 + 会话选择器数据源（listSessions）的测试。
 *
 * poolVersion 2 没有工作区授权层，但旧 scopes.json 里的工作区切片要迁移：
 * runtime 构造时把它们挂起（migrationPending），等宿主注入 workspaceRegistry
 * 后由 expandWorkspaceGrants 把「工作区路径」翻译成「会话 id 列表」写进 sessions。
 * 工作区已不存在 → 授权作废（审计记一笔），绝不静默扩大授权。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LauncherRuntime } from '../lib/runtime.mjs'

const tmpDirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-test-'))
  tmpDirs.push(dir)
  return dir
}

let passed = 0
const fails = []
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ok  ' + name) }
  else { fails.push(name); console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')) }
}
function section(title) { console.log(`\n=== ${title} ===`) }

function makeRuntime(dir, seed = {}) {
  return new LauncherRuntime({
    seed: { sampleCacheMs: 0, ...seed },
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
}

function writeLegacy(dir, config, scopes) {
  mkdirSync(dir, { recursive: true })
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
  if (scopes) writeFileSync(join(dir, 'scopes.json'), JSON.stringify(scopes, null, 2), 'utf8')
}

const WS_APP = { id: 'ws-app', name: 'WsApp', launch: { exe: 'C:\\w.exe' } }

// ---------- 工作区授权展开 ----------

section('旧工作区授权 → 会话授权展开')

{
  const dir = tempDir()
  writeLegacy(dir, { allowedDirs: [], programs: [WS_APP] }, {
    version: 1,
    workspaces: {
      'D:\\proj\\alpha': { allowedDirs: ['D:\\proj\\alpha\\models'], programs: [WS_APP] },
    },
    sessions: {},
    grants: [],
  })
  const rt = makeRuntime(dir)
  const cfg = rt.currentConfig()
  check('迁移挂起：migrationPending 列出工作区路径',
    JSON.stringify(cfg.migrationPending) === JSON.stringify(['D:\\proj\\alpha']), JSON.stringify(cfg.migrationPending))
  check('展开前条目还没有会话授权',
    cfg.programs.find((p) => p.id === 'ws-app').sessions.length === 0)

  const result = rt.expandWorkspaceGrants((path) => (
    path === 'D:\\proj\\alpha' ? ['sess-1', 'sess-2'] : null
  ))
  check('expanded 计数 = 程序 + 目录各 1', result.expanded === 2, JSON.stringify(result))
  check('dropped 为 0', result.dropped === 0)

  const after = rt.currentConfig()
  check('migrationPending 清空', after.migrationPending.length === 0)
  const app = after.programs.find((p) => p.id === 'ws-app')
  check('程序授权展开到工作区下的会话',
    JSON.stringify(app.sessions) === JSON.stringify(['sess-1', 'sess-2']), JSON.stringify(app.sessions))
  const dirEntry = after.programs.find((p) => p.kind === 'directory')
  check('目录条目同样展开',
    dirEntry && JSON.stringify(dirEntry.sessions) === JSON.stringify(['sess-1', 'sess-2']))
  check('旧切片已消费', rt.scopes.hasLegacySlices() === false)

  // 落盘再读回
  const reopened = makeRuntime(dir)
  const app2 = reopened.currentConfig().programs.find((p) => p.id === 'ws-app')
  check('重启后授权仍在', JSON.stringify(app2.sessions) === JSON.stringify(['sess-1', 'sess-2']))
  check('重启后不再挂起', reopened.currentConfig().migrationPending.length === 0)
}

section('工作区已不存在：授权作废而非扩大')

{
  const dir = tempDir()
  writeLegacy(dir, { allowedDirs: [], programs: [WS_APP] }, {
    version: 1,
    workspaces: { 'D:\\gone': { allowedDirs: ['D:\\gone\\m'], programs: [WS_APP] } },
    sessions: {}, grants: [],
  })
  const rt = makeRuntime(dir)
  const result = rt.expandWorkspaceGrants(() => null)
  check('dropped = 程序 + 目录', result.dropped === 2, JSON.stringify(result))
  check('expanded 为 0', result.expanded === 0)
  const app = rt.currentConfig().programs.find((p) => p.id === 'ws-app')
  check('条目保持未授权', app.sessions.length === 0)
  check('审计记录了作废', rt.grants(20).some((g) => g.action === 'remove' && g.target === 'D:\\gone'))
  check('切片已消费（不会反复尝试）', rt.scopes.hasLegacySlices() === false)
}

{
  const dir = tempDir()
  writeLegacy(dir, { allowedDirs: [], programs: [WS_APP] }, {
    version: 1,
    workspaces: { 'D:\\boom': { allowedDirs: [], programs: [WS_APP] } },
    sessions: {}, grants: [],
  })
  const rt = makeRuntime(dir)
  const result = rt.expandWorkspaceGrants(() => { throw new Error('registry 炸了') })
  check('lister 抛错按「不存在」处理（dropped=1）', result.dropped === 1, JSON.stringify(result))
}

{
  const rt = makeRuntime(tempDir(), { programs: [WS_APP] })
  const result = rt.expandWorkspaceGrants(() => ['s1'])
  check('无挂起时直接返回 0/0', result.expanded === 0 && result.dropped === 0)
}

// ---------- 会话选择器数据源 ----------

section('listSessions：sessionQuery 首选')

{
  const rt = makeRuntime(tempDir())
  rt.setSessionQuery({
    listSessions: async () => [
      { header: { id: 's-new', createdAt: '2026-11-14T00:00:00Z', cwd: 'D:\\x' }, live: true },
      { header: { id: 's-sub', createdAt: '2026-11-13T00:00:00Z', origin: 'subagent' }, live: false },
    ],
    readTitleSnapshots: async () => [
      { sessionId: 's-new', status: 'fulfilled', value: { title: { title: '新会话标题' } } },
      { sessionId: 's-sub', status: 'rejected', reason: 'no title' },
    ],
  })
  const { source, sessions } = await rt.listSessions()
  check('source=sessionQuery', source === 'sessionQuery')
  check('两条会话', sessions.length === 2)
  check('标题取自 readTitleSnapshots', sessions[0].title === '新会话标题')
  check('live 标记', sessions[0].live === true)
  check('rejected 的标题为空串', sessions[1].title === '')
  check('subagent 标记', sessions[1].subagent === true)
  check('cwd 透传', sessions[0].cwd === 'D:\\x')
}

section('listSessions：降级与兜底')

{
  const rt = makeRuntime(tempDir())
  rt.setSessionQuery({ listSessions: async () => { throw new Error('查询失败') } })
  rt.setWorkspaceLister(() => [
    { path: 'D:\\a', title: 'Alpha', sessionIds: ['s1', 's2'] },
    { path: 'D:\\b', title: 'Beta', sessionIds: ['s2', 's3'] },
  ])
  const { source, sessions } = await rt.listSessions()
  check('sessionQuery 失败降级 workspaceRegistry', source === 'workspaceRegistry')
  check('跨工作区去重', JSON.stringify(sessions.map((s) => s.id)) === JSON.stringify(['s1', 's2', 's3']))
  check('带上工作区标题', sessions[0].workspaceTitle === 'Alpha')
  check('降级列表无标题', sessions[0].title === '')
}

{
  const rt = makeRuntime(tempDir())
  const { source, sessions } = await rt.listSessions()
  check('两个服务都没有 → none + 空列表', source === 'none' && sessions.length === 0)
}

{
  const rt = makeRuntime(tempDir())
  rt.setSessionQuery({ notAFunction: true })
  const { source } = await rt.listSessions()
  check('非法 sessionQuery 被拒收', source === 'none')
}

{
  const rt = makeRuntime(tempDir())
  const many = Array.from({ length: 350 }, (_, i) => ({ header: { id: `s-${i}` }, live: false }))
  rt.setSessionQuery({ listSessions: async () => many })
  const { sessions } = await rt.listSessions()
  check('会话列表截断到 300 条', sessions.length === 300, String(sessions.length))
}

// ---------- 工作区级授权（poolVersion 2 新能力：sessions OR workspaces）----------

section('工作区授权可见性：会话所属工作区命中 workspaces 即可见')

{
  const dir = tempDir()
  const entry = {
    id: 'ws-app', name: 'WsApp', kind: 'program',
    launch: { exe: 'C:\\w.exe' }, sessions: [], workspaces: ['D:\\proj\\alpha'],
  }
  const rt = makeRuntime(dir, { programs: [entry] })
  rt.setWorkspaceResolver((sid) => {
    if (sid === 'sess-in-alpha') return { path: 'D:\\proj\\alpha', title: 'Alpha' }
    if (sid === 'sess-in-beta') return { path: 'D:\\proj\\beta', title: 'Beta' }
    return null
  })
  const idsIn = async (sid) => rt.withAgentScope({ agent: { id: sid } }, async () => rt.visiblePrograms().map((p) => p.id))
  check('sessions 为空但所属工作区已授权 → 可见', (await idsIn('sess-in-alpha')).includes('ws-app'))
  check('别的工作区的会话 → 不可见', !(await idsIn('sess-in-beta')).includes('ws-app'))
  check('解析不到工作区的会话 → 不可见（fail-closed）', !(await idsIn('sess-unknown')).includes('ws-app'))
  check('空会话 id → 不可见', !(await idsIn('')).includes('ws-app'))
}

section('工作区路径归一：大小写 / 尾分隔符不影响命中')

{
  const dir = tempDir()
  const entry = {
    id: 'ws-app', name: 'WsApp', kind: 'program',
    launch: { exe: 'C:\\w.exe' }, sessions: [], workspaces: ['d:\\proj\\alpha\\'],
  }
  const rt = makeRuntime(dir, { programs: [entry] })
  rt.setWorkspaceResolver(() => ({ path: 'D:\\PROJ\\Alpha', title: 'Alpha' }))
  const visible = await rt.withAgentScope({ agent: { id: 's1' } }, async () => rt.visiblePrograms().map((p) => p.id))
  check('大小写+尾分隔符不同仍命中（pathKey 归一）', visible.includes('ws-app'), JSON.stringify(visible))
}

section('工作区授权对目录条目同样生效')

{
  const dir = tempDir()
  const dirEntry = {
    id: 'models', name: '模型目录', kind: 'directory',
    path: 'D:\\models', sessions: [], workspaces: ['D:\\proj\\alpha'],
  }
  const rt = makeRuntime(dir, { programs: [dirEntry] })
  rt.setWorkspaceResolver((sid) => (sid === 's-alpha' ? { path: 'D:\\proj\\alpha', title: 'A' } : null))
  const dirsIn = async (sid) => rt.withAgentScope({ agent: { id: sid } }, async () => rt.visibleDirectories().map((d) => d.id))
  check('工作区下的会话可见已授权目录', (await dirsIn('s-alpha')).includes('models'))
  check('无工作区的会话不可见目录', !(await dirsIn('s-other')).includes('models'))
}

section('sessions 与 workspaces 任一命中即可见')

{
  const dir = tempDir()
  const entry = {
    id: 'both', name: 'Both', kind: 'program',
    launch: { exe: 'C:\\b.exe' }, sessions: ['sess-direct'], workspaces: ['D:\\proj\\alpha'],
  }
  const rt = makeRuntime(dir, { programs: [entry] })
  rt.setWorkspaceResolver((sid) => (sid === 'sess-ws' ? { path: 'D:\\proj\\alpha', title: 'A' } : null))
  const direct = await rt.withAgentScope({ agent: { id: 'sess-direct' } }, async () => rt.visiblePrograms().map((p) => p.id))
  const viaWs = await rt.withAgentScope({ agent: { id: 'sess-ws' } }, async () => rt.visiblePrograms().map((p) => p.id))
  check('sessions 直接命中可见（无需工作区）', direct.includes('both'))
  check('workspaces 命中可见（无需 sessions）', viaWs.includes('both'))
}

section('setEntryGrants / setEntryWorkspaces：改授权 + 审计')

{
  const dir = tempDir()
  const rt = makeRuntime(dir, { programs: [{ id: 'app', name: 'App', launch: { exe: 'C:\\a.exe' }, sessions: [], workspaces: [] }] })
  const res = rt.setEntryGrants('app', { sessions: ['s1'], workspaces: ['D:\\proj\\alpha'] })
  check('setEntryGrants 返回两个维度', JSON.stringify(res.sessions) === JSON.stringify(['s1']) && JSON.stringify(res.workspaces) === JSON.stringify(['D:\\proj\\alpha']))
  const p = rt.currentConfig().programs.find((x) => x.id === 'app')
  check('workspaces 落盘', JSON.stringify(p.workspaces) === JSON.stringify(['D:\\proj\\alpha']))
  check('审计记录工作区授权（kind=workspace add）', rt.grants(20).some((g) => g.kind === 'workspace' && g.action === 'add' && g.target === 'D:\\proj\\alpha'))
  check('审计记录会话授权（kind=entry add）', rt.grants(20).some((g) => g.kind === 'entry' && g.action === 'add' && g.target === 's1'))

  // 只改工作区，sessions 保持不变
  rt.setEntryWorkspaces('app', ['D:\\proj\\beta'])
  const p2 = rt.currentConfig().programs.find((x) => x.id === 'app')
  check('setEntryWorkspaces 不动 sessions', JSON.stringify(p2.sessions) === JSON.stringify(['s1']))
  check('setEntryWorkspaces 换工作区', JSON.stringify(p2.workspaces) === JSON.stringify(['D:\\proj\\beta']))
  check('审计记录移除旧工作区', rt.grants(20).some((g) => g.kind === 'workspace' && g.action === 'remove' && g.target === 'D:\\proj\\alpha'))

  // 落盘再读回
  const reopened = makeRuntime(dir)
  const p3 = reopened.currentConfig().programs.find((x) => x.id === 'app')
  check('重启后工作区授权仍在', JSON.stringify(p3.workspaces) === JSON.stringify(['D:\\proj\\beta']))

  let threw = null
  try { rt.setEntryGrants('no-such-entry', { workspaces: ['D:\\x'] }) } catch (e) { threw = e }
  check('未知条目抛错', threw !== null && /找不到条目/.test(threw.message))
}

section('listWorkspaces：工作区选择器数据源')

{
  const rt = makeRuntime(tempDir())
  check('无服务 → none + 空', (() => { const r = rt.listWorkspaces(); return r.source === 'none' && r.workspaces.length === 0 })())
  rt.setWorkspaceLister(() => [
    { id: 'ws-1', path: 'D:\\proj\\alpha', title: 'Alpha', sessionIds: ['s1', 's2'] },
    { id: 'ws-2', path: 'D:\\proj\\beta', title: 'Beta', sessionIds: ['s3'] },
    { id: 'ws-empty', path: '', title: '空路径', sessionIds: [] },
  ])
  const { source, workspaces } = rt.listWorkspaces()
  check('source=workspaceRegistry', source === 'workspaceRegistry')
  check('过滤空路径', workspaces.length === 2)
  check('带会话计数', workspaces[0].sessionCount === 2 && workspaces[1].sessionCount === 1)
  check('透传 id/path/title', workspaces[0].id === 'ws-1' && workspaces[0].path === 'D:\\proj\\alpha' && workspaces[0].title === 'Alpha')
  rt.setWorkspaceLister(() => { throw new Error('registry 炸了') })
  check('lister 抛错 → none 兜底', rt.listWorkspaces().source === 'none')
}

section('unauthCount：会话与工作区都空才算未授权')

{
  const dir = tempDir()
  const rt = makeRuntime(dir, { programs: [
    { id: 'a', name: 'A', launch: { exe: 'C:\\a.exe' }, sessions: ['s1'], workspaces: [] },
    { id: 'b', name: 'B', launch: { exe: 'C:\\b.exe' }, sessions: [], workspaces: ['D:\\proj'] },
    { id: 'c', name: 'C', launch: { exe: 'C:\\c.exe' }, sessions: [], workspaces: [] },
  ] })
  check('只有 sessions/workspaces 双空的条目计入 unauthCount', rt.currentConfig().unauthCount === 1, String(rt.currentConfig().unauthCount))
}

// ---------- 收尾 ----------

for (const dir of tmpDirs) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(`\n通过 ${passed} 项，失败 ${fails.length} 项`)
if (fails.length > 0) process.exit(1)