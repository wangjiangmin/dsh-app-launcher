/**
 * 渲染冒烟测试（v3）：直接渲染编辑表单，抓运行时 ReferenceError。
 *
 * 前两版的教训：模拟整棵 LauncherSection 需要复现多轮 setState 重渲染，
 * 假 React 做不到，结果只渲染出 loading 分支 —— 测不到表单。
 *
 * 这一版换个更可靠的办法：**把 client.js 里的表单组件抠出来单独渲染**。
 * 做法是给源码追加一行导出（只在测试进程内改字符串，不碰磁盘文件），
 * 然后直接渲染 ProgramForm。
 */
import { readFileSync } from 'node:fs'

const originalSrc = readFileSync('client/client.js', 'utf8')

// 在 factory 末尾的 `return { name: NS, inject, apply }` 之前插入测试导出
const marker = 'return { name: NS, inject, apply }'
if (!originalSrc.includes(marker)) {
  console.log('✗ 找不到导出锚点，测试需更新')
  process.exit(1)
}
const src = originalSrc.replace(
  marker,
  'globalThis.__TEST_EXPORTS__ = { ProgramForm, LauncherSection, AppCard, SystemCard, ErrorBoundary }\n      ' + marker,
)

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat() }
}

const hookStore = []
let hookIndex = 0
const React = {
  createElement,
  Fragment: '__fragment__',
  Component: class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(patch) { this.state = { ...this.state, ...patch } }
  },
  useState(initial) {
    const i = hookIndex++
    if (!(i in hookStore)) hookStore[i] = typeof initial === 'function' ? initial() : initial
    return [hookStore[i], (next) => { hookStore[i] = typeof next === 'function' ? next(hookStore[i]) : next }]
  },
  useEffect() {},
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
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

const ctx = {
  effect(cb) { const r = cb(); return typeof r === 'function' ? r : () => {} },
  get(name) { return name === 'uiWorkspace' ? {} : undefined },
  slots: { inject(k, cb) { const e = cb(); return typeof e === 'function' ? e : () => {} }, register() { return () => {} } },
  locale,
}

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) { mod = factory((n) => { if (n === 'react') return React; throw new Error(n) }) },
  },
}
globalThis.fetch = async (url) => {
  const body = String(url).includes('/config')
    ? { revision: 1, path: 'C:\\cfg.json', persisted: true, enabled: true, allowedDirs: [], programs: [] }
    : { plugin: {}, system: {}, programs: [], gates: {}, logs: {} }
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
}

let mod = null
new Function(src)()
mod.apply(ctx)

const exports = globalThis.__TEST_EXPORTS__
if (!exports?.ProgramForm) {
  console.log('✗ 未能拿到 ProgramForm')
  process.exit(1)
}

const t = locale.bind('dsh-app-launcher')
const problems = []
let seen = new Set()

function renderNode(node, budget = { n: 0 }) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') return
  if (node === '__fragment__') return
  if (Array.isArray(node)) { for (const n of node) renderNode(n, budget); return }

  if (typeof node.type === 'function') {
    budget.n += 1
    if (budget.n > 4000) return
    seen.add(node.type.name)
    let out
    try {
      const isClass = node.type.prototype && node.type.prototype.render
      if (isClass) out = new node.type(node.props).render()
      else { hookIndex = 0; out = node.type(node.props) }
    } catch (error) {
      problems.push(`${node.type.name || 'anonymous'}: ${error.message}`)
      return
    }
    renderNode(out, budget)
    return
  }
  for (const child of node.children ?? []) renderNode(child, budget)
}

// ---- 用例 1：新建表单（initial = null）----
hookStore.length = 0
hookIndex = 0
let tree = exports.ProgramForm({ initial: null, isNew: true, busy: false, notice: null, t, onCancel() {}, onSave() {} })
renderNode(tree)
console.log('用例1 新建表单：ok（组件 ' + seen.size + ' 种）')

// ---- 用例 2：编辑已有条目（initial = toForm 的输出）----
// 用真实配置形状喂进去，覆盖「编辑」这条崩溃路径
const existing = {
  id: 'demo', name: 'Demo', enabled: true, description: 'demo app',
  launch: { exe: 'C:\\x\\a.exe', args: [], cwd: 'C:\\x', env: {} },
  allowedDirs: ['C:\\x', 'D:\\y'], needs: { gpuUtilPctMax: 10 },
  exclusive: 'gpu-heavy', ready: { url: '', timeoutMs: 1000, intervalMs: 1000 }, stopTimeoutMs: 20000,
}
hookStore.length = 0
hookIndex = 0
seen = new Set()
tree = exports.ProgramForm({ initial: {
  id: existing.id, name: existing.name, enabled: existing.enabled, description: existing.description,
  exe: existing.launch.exe, args: '', cwd: existing.launch.cwd, envText: '',
  allowedDirs: existing.allowedDirs.slice(),
  needs: { gpuUtilPctMax: 10, freeVramMiBMin: '', freeRamMiBMin: '', cpuPctMax: 80 },
  exclusive: existing.exclusive, readyUrl: '', readyTimeoutMs: 1000, stopTimeoutMs: 20000,
}, isNew: false, busy: false, notice: null, t, onCancel() {}, onSave() {} })
renderNode(tree)
console.log('用例2 编辑表单：ok（组件 ' + seen.size + ' 种）')

if (problems.length > 0) {
  console.log('\n✗ 发现渲染错误:')
  for (const p of problems) console.log('  ' + p)
  process.exit(1)
}
console.log('\n✓ 表单渲染路径无异常')
