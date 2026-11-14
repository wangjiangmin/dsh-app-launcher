/**
 * dsh-app-launcher — 停止/启动后的独立验证。
 *
 * 为什么需要它：`stopProgram` 返回成功只代表"杀进程的调用成功了"，
 * 不代表服务真的下去了。以前只能靠人在外面提权跑 netstat / Get-Process
 * 去核对——那既不属于插件职责，也拿不到插件的内部语义（比如"还有几个
 * 属于本插件的进程"）。
 *
 * 插件跑在宿主进程里，本身不受 Agent 沙箱限制，所以验证应当由插件自己做：
 *   - 停止后：端口无人监听 + 无残留进程 + 探针不通，三条独立证据；
 *   - 启动后：端口有人监听 + 探针通过 + 有活着的进程。
 *
 * 这里只做**只读探测**，绝不杀进程、绝不改状态。
 */
import { execFile } from 'node:child_process'

import { detectProcessName, listeningPids, parentPidOf, pidsByProcessName, portOf, processExePath } from './programs.mjs'

/** 执行命令取文本；失败返回 null（区别于"命令成功但输出为空"）。 */
function execText(exe, argv, timeoutMs = 10000) {
  return new Promise((resolve) => {
    try {
      execFile(exe, argv, { windowsHide: true, timeout: timeoutMs }, (error, stdout) => {
        resolve(error ? null : String(stdout))
      })
    } catch {
      resolve(null)
    }
  })
}

/**
 * 列出「疑似属于这个程序」的残留进程。
 *
 * 判据刻意从严，避免把无关进程报成残留。以下任一成立即算：
 *   1. 可执行文件名与配置的启动入口一致（Electron 壳/原生 exe）；
 *   2. 该进程的父链能追溯到一个满足 (1) 的进程（后端 python 等）；
 *   3. 它就是 ready.url 端口的监听者；
 *   4. 它的 exe 与配置的启动入口在**同一个程序目录**下。
 *
 * 为什么需要 (3)(4)：配置里写的往往是"启动器"，而真正跑起来的是另一个进程。
 * 实测（2026-11-09，LM Studio）：启动入口是 `resources\app\.webpack\lms.exe`
 * （CLI 启动器，它拉起 GUI 后自己就退了），真正在跑的是
 * `F:\program\LM Studio\LM Studio.exe` 共 5 个进程。只按 lms.exe 比对的话，
 * 「端口在监听 + 探针返回 200」却被判成「没有进程在跑」→ 误判 fail。
 *
 * 返回 null 表示"读不到进程表"（权限/工具缺失），与空数组严格区分。
 */
export async function findResidualProcesses(program, deps = {}, portPids = []) {
  const name = detectProcessName(program)
  if (name === '') return []

  const listByName = deps.pidsByProcessName ?? pidsByProcessName
  const byName = await listByName(name, deps)
  if (byName === null) return null

  // ★ 候选集必须包含端口占用者本身，而不只是"按启动入口名字找到的进程"。
  // 踩过的坑（2026-11-09，LM Studio）：配置写的是 lms.exe（启动器），按这个名字
  // 查到的列表是空的（启动器拉起 GUI 后已退出），循环一次都不进 → 后面的
  // 端口占用者认领逻辑永远没机会跑，于是"端口在监听 + 探针 200"被判成
  // "没有进程在跑"。候选集必须独立于名字匹配结果。
  const candidates = [...new Set([...byName, ...(Array.isArray(portPids) ? portPids : [])])]
  if (candidates.length === 0) return []

  const probeExe = deps.processExePath ?? processExePath
  const parents = deps.parentPidOf ?? parentPidOf
  const expectExe = String(program?.launch?.exe ?? '').replace(/[\\/]+$/, '').toLowerCase()
  // 程序目录链：由近及远，覆盖"启动器在子目录、主程序在根"的布局。
  const programDirs = programDirectoryChain(expectExe)
  const portSet = new Set(Array.isArray(portPids) ? portPids : [])
  const byNameSet = new Set(byName)

  const matched = new Map()
  const note = (pid, exe, kind, extra = {}) => {
    if (!matched.has(pid)) matched.set(pid, { pid, exe, kind, ...extra })
  }
  const exeCache = new Map()
  const exeOf = async (pid) => {
    if (!exeCache.has(pid)) exeCache.set(pid, await probeExe(pid))
    return exeCache.get(pid)
  }

  // 第一遍：直接证据（同名 exe / 端口占用者 / 同程序目录）。
  // 先把这一遍全部跑完，父链判定才能看到完整的"已认领"集合，
  // 否则结果会依赖遍历顺序（父进程排在子进程后面就会漏）。
  for (const pid of candidates) {
    const exe = await exeOf(pid)
    const norm = typeof exe === 'string' ? exe.replace(/[\\/]+$/, '').toLowerCase() : ''
    if (norm !== '' && norm === expectExe) {
      note(pid, exe, 'same-exe')
      continue
    }
    if (portSet.has(pid)) {
      note(pid, exe, 'port-owner')
      continue
    }
    if (norm !== '' && programDirs.some((dir) => norm.startsWith(dir))) {
      note(pid, exe, 'same-dir')
      continue
    }
  }

  // 第二遍：沿父链把"已认领进程"的后代也算进来（后端 python 等）。
  for (const pid of candidates) {
    if (matched.has(pid)) continue
    const exe = await exeOf(pid)
    let cursor = await parents(pid)
    for (let depth = 0; depth < 8 && Number.isInteger(cursor) && cursor > 0; depth += 1) {
      if (matched.has(cursor)) {
        note(pid, exe, 'child-of-owned', { parentPid: cursor })
        break
      }
      // 父进程本身也在这个候选集里（例如同名启动器自己还活着）：以它为锚。
      if (byNameSet.has(cursor)) {
        note(pid, exe, 'child-of-owned', { parentPid: cursor })
        break
      }
      const next = await parents(cursor)
      if (!Number.isInteger(next) || next <= 0 || next === cursor) break
      cursor = next
    }
  }
  return [...matched.values()]
}

/**
 * 由启动入口推出候选"程序目录"前缀（可多层，由近及远）。
 *
 * 为什么要多层：启动器常放在子目录里，而主程序在它的上层。
 * 实测（2026-11-09，LM Studio）：
 *   启动入口 F:\program\LM Studio\resources\app\.webpack\lms.exe
 *   实际进程 F:\program\LM Studio\LM Studio.exe
 * 只取紧邻目录（.webpack\）匹配不到，需要向上回溯到程序根。
 *
 * ★ 但绝不能退到盘符根：`C:\Apps\Comfy Desktop.exe` 一旦回溯到 `C:\`，
 * 整块盘上所有进程都会被认成"同一个程序"，残留判定直接失去意义
 * （测试里 `C:\Other\unrelated.exe` 当场被误认）。
 * 因此只回溯到"程序根"：遇到明显的容器型中间目录（resources / app /
 * node_modules / bin / lib / .webpack 之类）继续上溯，遇到普通名字即停。
 */
export function programDirectoryChain(expectExe, maxLevels = 4) {
  // 这些目录名说明"还在程序内部"，不是程序根，可以继续往上走。
  const CONTAINER = new Set([
    'resources', 'app', 'bin', 'lib', 'libs', 'dist', 'build', 'out',
    'node_modules', 'webpack', '.webpack', 'x64', 'x86', 'win', 'win32', 'win64',
    'engine', 'runtime', 'current', 'versions',
  ])
  const chain = []
  let dir = programDirectoryOf(expectExe)
  for (let level = 0; level < maxLevels && dir !== ''; level += 1) {
    const trimmed = dir.replace(/[\\/]+$/, '')
    if (trimmed === '' || /^[a-zA-Z]:$/.test(trimmed)) break // 盘符根，到此为止
    chain.push(dir)
    const leaf = (trimmed.split(/[\\/]/).pop() ?? '').toLowerCase()
    // 只有"容器型"目录才继续上溯；普通名字视作程序根，停止回溯。
    if (!CONTAINER.has(leaf)) break
    dir = programDirectoryOf(trimmed)
  }
  return chain
}

/** 由启动入口推出"程序目录"前缀（带尾部分隔符，便于 startsWith）。 */
export function programDirectoryOf(expectExe) {
  const text = String(expectExe ?? '')
  if (text === '') return ''
  const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
  return cut <= 0 ? '' : text.slice(0, cut + 1)
}

/**
 * 探针：GET ready.url，返回 { ok, status, error }。没有 url 时 ok=null。
 *
 * 允许通过 deps.fetch 注入：测试必须能离线跑。之前测试里用了真实的
 * 127.0.0.1:1234 地址，结果"测试是否通过"取决于 LM Studio 当晚开没开——
 * 这是测试依赖外部环境的典型错误（已实测踩到）。
 */
async function probeReady(program, timeoutMs = 4000, deps = {}) {
  const url = program?.ready?.url
  if (!url) return { url: null, ok: null, status: null, error: null }
  const doFetch = deps.fetch ?? fetch
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    await res.arrayBuffer?.().catch?.(() => {})
    const okMax = Number(program?.ready?.okStatusMax) || 399
    return { url, ok: res.status < okMax, status: res.status, error: null }
  } catch (error) {
    return { url, ok: false, status: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 验证一个程序"当前到底有没有在跑"。
 *
 * @param {object} program  归一化后的程序
 * @param {object} opts     { expect: 'running' | 'stopped', deps }
 * @returns 结构化结论：verdict 是 'pass' | 'fail' | 'unknown'，
 *          evidence 逐项列出三条独立证据，便于界面上解释"为什么这么判"。
 */
export async function verifyProgram(program, { expect, deps = {} } = {}) {
  const wantRunning = expect !== 'stopped'
  const port = portOf(program)
  const evidence = []
  const problems = []

  // ---- 证据 1：端口 ----
  let pids = null
  if (port !== null) {
    const probe = deps.listeningPids ?? listeningPids
    pids = await probe(program, () => {}, deps)
    if (pids === null) {
      evidence.push({ check: 'port', ok: null, detail: `端口 ${port}：读不到监听状态（netstat/lsof 不可用）` })
    } else {
      const listening = pids.length > 0
      evidence.push({
        check: 'port',
        ok: listening === wantRunning,
        detail: listening ? `端口 ${port} 被 PID ${pids.join('、')} 监听` : `端口 ${port} 无监听`,
      })
      if (listening !== wantRunning) problems.push(`端口 ${port} ${listening ? '仍在监听' : '没有人监听'}`)
    }
  } else {
    evidence.push({ check: 'port', ok: null, detail: '该程序没有配置就绪端口，跳过端口检查' })
  }

  // ---- 证据 2：残留进程 ----
  // 把端口占用者传进去：它本身就是"这个程序在运行"的硬证据。
  // 配置里写的常常是启动器（lms.exe），真正跑的是另一个 exe（LM Studio.exe）。
  const residual = await findResidualProcesses(program, deps, Array.isArray(pids) ? pids : [])
  if (residual === null) {
    evidence.push({ check: 'process', ok: null, detail: '读不到进程表，无法确认是否有残留进程' })
  } else {
    const anyAlive = residual.length > 0
    evidence.push({
      check: 'process',
      ok: anyAlive === wantRunning,
      detail: anyAlive
        ? `仍有 ${residual.length} 个相关进程存活：${residual.map((item) => `${item.pid}(${item.kind})`).join('、')}`
        : '没有相关进程存活',
      processes: residual,
    })
    if (anyAlive !== wantRunning) {
      problems.push(anyAlive ? `仍有残留进程 ${residual.map((item) => item.pid).join('、')}` : '没有进程在跑')
    }
  }

  // ---- 证据 3：就绪探针 ----
  const ready = await probeReady(program, 4000, deps)
  if (ready.url === null) {
    evidence.push({ check: 'ready', ok: null, detail: '该程序没有配置就绪 URL，跳过探针检查' })
  } else {
    // 文案要点：期望停止时"不可达"是**好事**，别写成像是出错。
    // 之前显示「✗/✓ …不可达（fetch failed）」读起来自相矛盾。
    const expectText = wantRunning ? '应当能连通' : '应当不可达'
    evidence.push({
      check: 'ready',
      ok: Boolean(ready.ok) === wantRunning,
      detail: ready.ok
        ? `${ready.url} 响应 HTTP ${ready.status}（${expectText}）`
        : `${ready.url} 无响应${ready.error ? `（${ready.error}）` : ''}（${expectText}：${wantRunning ? '异常' : '正常'}）`,
    })
    if (Boolean(ready.ok) !== wantRunning) {
      problems.push(ready.ok ? '就绪探针仍能连通' : '就绪探针不通')
    }
  }

  // 结论：只要能取得至少一条硬证据就下判断；全部读不到才 unknown。
  const decisive = evidence.filter((item) => item.ok !== null)
  let verdict
  if (decisive.length === 0) verdict = 'unknown'
  else verdict = problems.length === 0 ? 'pass' : 'fail'

  return {
    id: program.id,
    name: program.name,
    expect,
    verdict,
    ok: verdict === 'pass',
    port,
    pids,
    residualProcesses: residual ?? null,
    evidence,
    problems,
    checkedAt: Date.now(),
  }
}

/**
 * 验证全部程序（或指定的几个）。设置页的「验证」按钮与 tool 共用。
 */
export async function verifyAll(cfg, { expect = 'stopped', ids, deps = {} } = {}) {
  const targets = (cfg.programs ?? []).filter((program) => {
    if (!program.enabled || !program.valid) return false
    return ids === undefined || ids.includes(program.id)
  })
  const results = await Promise.all(targets.map((program) => verifyProgram(program, { expect, deps })))
  const failed = results.filter((item) => item.verdict === 'fail')
  const unknown = results.filter((item) => item.verdict === 'unknown')
  return {
    expect,
    total: results.length,
    passed: results.filter((item) => item.verdict === 'pass').length,
    failed: failed.length,
    unknown: unknown.length,
    ok: failed.length === 0 && unknown.length === 0,
    results,
    at: Date.now(),
  }
}
