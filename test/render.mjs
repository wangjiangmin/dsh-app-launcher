/**
 * 渲染冒烟测试（v4）：真渲染到每个组件的目标分支，抓运行时 ReferenceError。
 *
 * 历史教训（务必保留）：
 *  - v1/v2 模拟整棵 LauncherSection 只渲染出 loading 分支 —— 测不到表单（假通过）。
 *  - v3 抠出 ProgramForm 单独渲染，但假 createElement 没把 children 放进 props，
 *    Field/Modal 里的 TextInput/SessionPicker/Switch 根本没被渲染 —— 又是假通过。
 *  - 全局 hookStore + 每个组件重置 hookIndex 会让嵌套组件的 hook 互相覆盖
 *    （SessionPicker 的 useSessions 踩掉 ProgramForm 的 form）——必须按组件实例分派 hook。
 *
 * v4 的做法：
 *  1. createElement 把 children 写进 props.children → Field/Modal 真的渲染子组件。
 *  2. 每个组件实例一个 hook 分派器（按 组件函数+出现序号 键控，跨两遍渲染保留状态）。
 *  3. useEffect 首遍同步触发 + fetch 快速 resolves + drain 微任务后再渲染一遍
 *     → useSessions/useConfig 的「加载完成」分支（勾选列表/条目开关）真的被走到。
 *  4. 覆盖 DirectoryCard / SessionPicker / SessionAuthDialog / SessionGrantPanel，
 *     最后做反向验证（故意改坏组件名，确认测试会报错）。
 *
 * v5（拆分后）：client.js 是组合根，UI 在 8 个 package-local chunk 里。loadPlugin()
 *  模拟 require.async 逐个加载 chunk、await 异步 apply，用 __DSH_LAUNCHER_TEST_HOOK__
 *  抓已装配模块。反向验证改为替换 client.form.js 的源码再加载。
 */
import { readFileSync } from 'node:fs'

// v5：client.js 已拆成组合根 + 8 个 package-local chunk。加载逻辑见下方 loadPlugin()：
// 假 require.async 逐个读 chunk 文件并 materialize，entry.apply 为 async，
// 通过 __DSH_LAUNCHER_TEST_HOOK__ 抓取已装配的模块（替代旧的整文件锚点注入）。

function createElement(type, props, ...children) {
  const flat = children.flat()
  return { type, props: { ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat }, children: flat }
}

// ---- 按组件实例分派 hook ----
let dispatcherMap = new Map()   // 组件函数 -> [ {hooks, index, effectRan} ]（跨两遍保留）
let occurrence = new Map()      // 每一遍渲染内，组件函数 -> 出现次数
let current = null              // 当前正在执行的组件的分派器

function dispatcherFor(fn) {
  const idx = occurrence.get(fn) ?? 0
  occurrence.set(fn, idx + 1)
  let arr = dispatcherMap.get(fn)
  if (!arr) { arr = []; dispatcherMap.set(fn, arr) }
  if (!arr[idx]) arr[idx] = { hooks: [], index: 0, effectRan: false }
  return arr[idx]
}

const React = {
  createElement,
  Fragment: '__fragment__',
  Component: class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(patch) { this.state = { ...this.state, ...patch } }
  },
  useState(initial) {
    const d = current
    const i = d.index++
    if (!(i in d.hooks)) d.hooks[i] = { v: typeof initial === 'function' ? initial() : initial }
    const slot = d.hooks[i]
    return [slot.v, (next) => { slot.v = typeof next === 'function' ? next(slot.v) : next }]
  },
  // ★ 每个 useEffect 占一个 hook 槽、各自只跑一次（贴近真实 React）。
  //   旧版用单个 d.effectRan 标志，导致 LauncherSection 里 useStatus 的 effect 跑完后
  //   useConfig 的 effect 被跳过 → 配置永远加载不出来（整面板假通过）。
  useEffect(fn) {
    const d = current
    const i = d.index++
    if (!(i in d.hooks)) d.hooks[i] = { ran: false }
    const slot = d.hooks[i]
    if (!slot.ran) { slot.ran = true; try { fn() } catch { /* 加载分支兜底 */ } }
  },
  useCallback(fn) {
    const d = current
    const i = d.index++
    if (!(i in d.hooks)) d.hooks[i] = { fn }
    return d.hooks[i].fn
  },
  useMemo(fn) {
    const d = current
    const i = d.index++
    if (!(i in d.hooks)) d.hooks[i] = { v: fn() }
    return d.hooks[i].v
  },
}
React.default = React

const dicts = {}
const locale = {
  register(ns, d) { dicts[ns] = d; return () => {} },
  bind(ns) { return (key) => dicts[ns]?.zh?.[key] ?? `#${key}` },
  getLocale() { return { id: 'zh' } },
  getSnapshot() { return { id: 'zh' } },
  subscribe() { return () => {} },
  setLocale() {},
  addLanguage() { return () => {} },
}

const registrations = []
const ctx = {
  effect(cb) { const r = cb(); return typeof r === 'function' ? r : () => {} },
  get(name) {
    if (name === 'uiWorkspace') return {}
    if (name === 'layout') return { selectPanel() {} }
    return undefined
  },
  slots: {
    inject(k, cb) { const e = cb(); return typeof e === 'function' ? e : () => {} },
    register(options) { registrations.push(options); return () => {} },
  },
  locale,
}

// window.__ModuleLoader__ 由 loadPlugin() 按「entry + chunk」分别捕获（见下）。

const SESSIONS = [
  { id: 'sess-a', title: '会话 A', live: true, subagent: false, createdAt: 1 },
  { id: 'sess-b', title: '', live: false, subagent: true, createdAt: 2 },
]
const CONFIG_BODY = {
  ok: true,
  config: {
    revision: 1, poolVersion: 2, enabled: true, unauthCount: 1, migrationPending: [],
    programs: [
      { id: 'comfyui', name: 'ComfyUI', kind: 'program', enabled: true, sessions: ['sess-a'], launch: { exe: 'C:\\x\\a.exe' } },
      { id: 'models', name: '模型目录', kind: 'directory', enabled: true, sessions: [], path: 'D:\\models' },
    ],
  },
}
globalThis.fetch = async (url) => {
  const u = String(url)
  let body
  if (u.includes('/sessions')) body = { ok: true, source: 'sessionQuery', sessions: SESSIONS }
  else if (u.includes('/config')) body = CONFIG_BODY
  else if (u.includes('/grants')) body = { ok: true, grants: [{ at: Date.now(), scope: 'entry', action: 'add', target: 'sess-a' }] }
  else body = { ok: true, plugin: {}, system: {}, programs: [], gates: {}, logs: {}, directories: [] }
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
}

// ---- 加载器：模拟 DSH 的 entry + package-local chunk 机制 ----
// overrides: { 'client.<name>.js': 源码 }，用于反向验证时替换某个 chunk。
async function loadPlugin(overrides = {}) {
  const chunkRegs = new Map()
  let entryReg = null
  globalThis.window = {
    __ModuleLoader__: {
      load(reg) { if (reg.chunk) chunkRegs.set(reg.chunk, reg); else entryReg = reg },
    },
  }
  const fakeRequire = (name) => { if (name === 'react') return React; throw new Error('unexpected sync require: ' + name) }
  fakeRequire.async = async (spec) => {
    const file = spec.replace(/^\.\//, '')
    if (!chunkRegs.has(file)) {
      const chunkSrc = overrides[file] ?? readFileSync('client/' + file, 'utf8')
      new Function(chunkSrc)() // 执行 chunk → 经 window.__ModuleLoader__.load 注册
    }
    const reg = chunkRegs.get(file)
    if (!reg) throw new Error('chunk 未注册: ' + file)
    return reg.factory(fakeRequire) // { build }
  }
  const entrySrc = overrides['client.js'] ?? readFileSync('client/client.js', 'utf8')
  new Function(entrySrc)() // 注册 entry
  if (!entryReg) throw new Error('entry 未注册')
  const mod = entryReg.factory(fakeRequire)
  let captured = null
  globalThis.__DSH_LAUNCHER_TEST_HOOK__ = (mods) => { captured = mods }
  await mod.apply(ctx)
  globalThis.__DSH_LAUNCHER_TEST_HOOK__ = undefined
  if (!captured) throw new Error('测试钩子未被调用（entry.apply 没装配模块）')
  return { mod, captured }
}

const { captured } = await loadPlugin()
const exports = {
  ProgramForm: captured.form.ProgramForm,
  LauncherSection: captured.panel.LauncherSection,
  AppCard: captured.cards.AppCard,
  SystemCard: captured.cards.SystemCard,
  ErrorBoundary: captured.controls.ErrorBoundary,
  DirectoryCard: captured.cards.DirectoryCard,
  SessionPicker: captured.sessions.SessionPicker,
  SessionAuthDialog: captured.sessions.SessionAuthDialog,
  SessionGrantPanel: captured.sessions.SessionGrantPanel,
  GrantsLog: captured.sessions.GrantsLog,
}
if (!exports.ProgramForm || !exports.DirectoryCard || !exports.SessionPicker || !exports.SessionGrantPanel) {
  console.log('✗ 未能拿到全部待测组件')
  process.exit(1)
}

const t = locale.bind('dsh-app-launcher')
const problems = []
let seen = new Set()
let checkboxCount = 0

function renderNode(node, budget = { n: 0 }) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') return
  if (node === '__fragment__') return
  if (Array.isArray(node)) { for (const n of node) renderNode(n, budget); return }

  if (typeof node.type === 'function') {
    budget.n += 1
    if (budget.n > 4000) return
    seen.add(node.type.name)
    const isClass = node.type.prototype && node.type.prototype.render
    let out
    const prev = current
    try {
      if (isClass) {
        out = new node.type(node.props).render()
      } else {
        const d = dispatcherFor(node.type)
        d.index = 0
        current = d
        out = node.type(node.props)
      }
    } catch (error) {
      problems.push(`${node.type.name || 'anonymous'}: ${error.message}`)
      return
    } finally {
      current = prev
    }
    renderNode(out, budget)
    return
  }
  if (node.type === 'input' && node.props?.type === 'checkbox') checkboxCount += 1
  for (const child of node.children ?? []) renderNode(child, budget)
  if ((node.children ?? []).length === 0 && node.props?.children) renderNode(node.props.children, budget)
}

function renderTree(tree) {
  occurrence = new Map()
  current = null
  renderNode(tree)
}

const drain = () => new Promise((r) => setTimeout(r, 0))
function resetCase() { dispatcherMap = new Map(); seen = new Set(); checkboxCount = 0 }
// 渲染两遍：第一遍触发 effect 加载，drain 后第二遍走「加载完成」分支
async function renderLoaded(Component, props) {
  resetCase()
  renderTree(createElement(Component, props))
  await drain(); await drain(); await drain()
  renderTree(createElement(Component, props))
}
function renderOnce(Component, props) {
  resetCase()
  renderTree(createElement(Component, props))
}

// ---- 用例 1：新建软件表单（含 SessionPicker 加载分支）----
await renderLoaded(exports.ProgramForm, { initial: null, isNew: true, busy: false, notice: null, t, onCancel() {}, onSave() {} })
if (!seen.has('SessionPicker')) problems.push('用例1 未渲染到 SessionPicker')
if (checkboxCount === 0) problems.push('用例1 SessionPicker 未走到勾选列表（仍是 loading，假通过）')
console.log('用例1 新建软件表单：ok（组件 ' + seen.size + ' 种，勾选框 ' + checkboxCount + '）')

// ---- 用例 2：编辑已有条目 ----
const existingForm = {
  id: 'demo', name: 'Demo', kind: 'program', enabled: true, description: 'demo app', sessions: ['sess-a'],
  exe: 'C:\\x\\a.exe', args: '', cwd: 'C:\\x', envText: '', interpreter: '', path: '',
  allowedDirs: ['C:\\x', 'D:\\y'],
  needs: { gpuUtilPctMax: 10, freeVramMiBMin: '', freeRamMiBMin: '', cpuPctMax: 80 },
  exclusive: 'gpu-heavy', readyUrl: '', readyTimeoutMs: 1000, stopTimeoutMs: 20000,
}
await renderLoaded(exports.ProgramForm, { initial: existingForm, isNew: false, busy: false, notice: null, t, onCancel() {}, onSave() {} })
if (!seen.has('SessionPicker')) problems.push('用例2 未渲染到 SessionPicker')
console.log('用例2 编辑软件表单：ok（组件 ' + seen.size + ' 种）')

// ---- 用例 3：脚本表单（解释器字段）----
await renderLoaded(exports.ProgramForm, { initial: { ...existingForm, kind: 'script', exe: 'C:\\x\\task.ps1', interpreter: '' }, isNew: false, busy: false, notice: null, t, onCancel() {}, onSave() {} })
console.log('用例3 脚本表单：ok（组件 ' + seen.size + ' 种）')

// ---- 用例 4：目录表单（只有路径 + 会话授权）----
await renderLoaded(exports.ProgramForm, { initial: { ...existingForm, kind: 'directory', path: 'D:\\models' }, isNew: false, busy: false, notice: null, t, onCancel() {}, onSave() {} })
if (!seen.has('SessionPicker')) problems.push('用例4 目录表单未渲染到 SessionPicker')
console.log('用例4 目录表单：ok（组件 ' + seen.size + ' 种）')

// ---- 用例 5：AppCard（程序卡片 + 验证结果 + 授权按钮）----
const cardProgram = {
  id: 'comfyui', name: 'ComfyUI', kind: 'program', enabled: true, valid: true, description: 'demo',
  launchable: true, launchHint: '', launch: { exe: 'C:\\x\\a.exe' }, sessions: ['sess-a'],
  needs: { gpuUtilPctMax: 10 }, exclusive: 'gpu-heavy',
  phase: 'stopped', running: false, canStop: false, stopBlockedReason: null,
  ready: { url: 'http://127.0.0.1:8188/x' },
}
renderOnce(exports.AppCard, {
  program: cardProgram,
  logInfo: { path: 'x.log', tail: ['line'], size: 4, mtime: Date.now() },
  gate: { action: 'start', ok: true, reason: null, suggestions: [] },
  editing: false, busy: null, confirmStop: null, setConfirmStop() {}, t,
  onEdit() {}, onDelete() {}, onStart() {}, onStop() {}, onVerify() {}, onAuth() {},
  verifyResult: {
    ok: false, verdict: 'fail', expect: 'stopped',
    evidence: [
      { check: 'port', ok: false, detail: '端口 8188 被 PID 123 监听' },
      { check: 'process', ok: true, detail: '没有相关进程存活' },
      { check: 'ready', ok: null, detail: '跳过探针检查' },
    ],
    problems: ['端口 8188 仍在监听'],
  },
})
console.log('用例5 程序卡片（含验证结果）：ok（组件 ' + seen.size + ' 种）')

// ---- 用例 6：DirectoryCard（目录卡片）----
renderOnce(exports.DirectoryCard, {
  entry: { id: 'models', name: '模型目录', kind: 'directory', path: 'D:\\models', sessions: [], description: '', enabled: true },
  t, editing: false, onEdit() {}, onDelete() {}, onAuth() {},
})
console.log('用例6 目录卡片：ok（组件 ' + seen.size + ' 种）')

// ---- 用例 7：SessionAuthDialog（单条目授权弹框，加载分支）----
await renderLoaded(exports.SessionAuthDialog, { entry: { id: 'comfyui', name: 'ComfyUI', sessions: ['sess-a'] }, t, onClose() {}, onSaved() {} })
if (!seen.has('SessionPicker')) problems.push('用例7 未渲染到 SessionPicker')
if (checkboxCount === 0) problems.push('用例7 SessionPicker 未走到勾选列表')
console.log('用例7 会话授权弹框：ok（组件 ' + seen.size + ' 种，勾选框 ' + checkboxCount + '）')

// ---- 用例 8：SessionGrantPanel（本会话授权，加载出条目开关）----
await renderLoaded(exports.SessionGrantPanel, { sessionId: 'sess-a', t })
if (!seen.has('Switch')) problems.push('用例8 未渲染到条目开关 Switch（仍是 loading，假通过）')
console.log('用例8 本会话授权面板：ok（组件 ' + seen.size + ' 种）')

// ---- 用例 9：SessionGrantPanel 无会话 id（fail-closed 提示）----
renderOnce(exports.SessionGrantPanel, { sessionId: '', t })
console.log('用例9 无会话 id 提示：ok')

// ---- 用例 10：GrantsLog（审计记录，加载分支）----
await renderLoaded(exports.GrantsLog, { t })
console.log('用例10 授权记录：ok（组件 ' + seen.size + ' 种）')

// ---------- 用例11：入口注册 ----------
const slotNames = registrations.map((r) => r.name)
const mustHave = ['settings.section', 'sidebar.panellist', 'main', 'conversation.session.header.actions']
const missing = mustHave.filter((n) => !slotNames.includes(n))
if (missing.length > 0) {
  problems.push(`缺少 slot 注册: ${missing.join(', ')}（已注册: ${slotNames.join(', ')}）`)
} else {
  console.log('用例11 入口注册：ok（' + slotNames.join(', ') + '）')
}
const panellist = registrations.find((r) => r.name === 'sidebar.panellist')
const mainReg = registrations.find((r) => r.name === 'main')
if (panellist && mainReg && panellist.id !== mainReg.key) {
  problems.push(`main key (${mainReg.key}) 与 panellist id (${panellist.id}) 不一致，点图标打不开面板`)
} else if (panellist && mainReg) {
  console.log('用例12 key 配对：ok（' + panellist.id + '）')
}

// ---- 用例13：SystemCard（系统资源卡片，含 GPU/CPU/内存 pills + 占用者）----
renderOnce(exports.SystemCard, {
  system: {
    at: Date.now(), lazy: false,
    gpu: { available: true, name: 'GPU0', utilPct: 12, freeMiB: 10000 },
    cpu: { pct: 20 }, memory: { freeMiB: 16000, totalMiB: 32000 },
    gpuHolders: [{ pid: 123, name: 'comfyui', usedMiB: 2000 }],
  },
  t, onProbe() {}, checking: false,
})
if (!seen.has('Pill')) problems.push('用例13 SystemCard 未渲染到 Pill')
console.log('用例13 系统资源卡片：ok（组件 ' + seen.size + ' 种）')

// ---- 用例14：LauncherSection 整面板（配置全池 + 运行态合并，渲染条目卡/系统卡/头部）----
await renderLoaded(exports.LauncherSection, { t })
if (!seen.has('AppCard') && !seen.has('DirectoryCard')) problems.push('用例14 整面板未渲染到任何条目卡片（假通过）')
if (!seen.has('SystemCard')) problems.push('用例14 整面板未渲染到 SystemCard')
console.log('用例14 整面板：ok（组件 ' + seen.size + ' 种）')

if (problems.length > 0) {
  console.log('\n✗ 发现渲染错误:')
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}

// ---------- 反向验证：故意改坏组件名，确认测试抓得到（防假通过）----------
// 锚点现在在 client.form.js（ProgramForm 里渲染 SessionPicker 的那行）。
const formSrc = readFileSync('client/client.form.js', 'utf8')
const brokenFormSrc = formSrc.replace('h(SessionPicker, { selected: form.sessions', 'h(SessionPickerTYPO, { selected: form.sessions')
if (brokenFormSrc === formSrc) {
  console.log('\n✗ 反向验证锚点未命中，测试需更新')
  process.exit(1)
}
const { captured: brokenCaptured } = await loadPlugin({ 'client.form.js': brokenFormSrc })
resetCase()
const before = problems.length
renderTree(createElement(brokenCaptured.form.ProgramForm, { initial: null, isNew: true, busy: false, notice: null, t, onCancel() {}, onSave() {} }))
if (problems.length <= before) {
  console.log('\n✗ 反向验证失败：改坏组件名后测试竟然没报错（说明渲染没真正走到目标分支）')
  process.exit(1)
}
problems.length = before
console.log('反向验证：ok（改坏 SessionPicker 名后测试如期报错）')

console.log('\n✓ 表单/卡片/会话组件渲染路径无异常')