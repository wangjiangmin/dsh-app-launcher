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

import { listeningPids, parentPidOf, pidsByProcessName, portOf, processExePath, processNameOf } from './programs.mjs'

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
 * 判据刻意从严，避免把无关进程报成残留：
 *   1. 可执行文件名与配置的启动入口一致（Electron 壳/原生 exe）；
 *   2. 或该进程的父链能追溯到一个 exe 路径匹配的进程（后端 python 等）。
 *
 * 返回 null 表示"读不到进程表"（权限/工具缺失），与空数组严格区分。
 */
export async function findResidualProcesses(program, deps = {}) {
  const name = processNameOf(program?.launch?.exe)
  if (name === '') return []

  const listByName = deps.pidsByProcessName ?? pidsByProcessName
  const pids = await listByName(name, deps)
  if (pids === null) return null

  const probeExe = deps.processExePath ?? processExePath
  const parents = deps.parentPidOf ?? parentPidOf
  const expectExe = String(program?.launch?.exe ?? '').replace(/[\\/]+$/, '').toLowerCase()

  const residual = []
  for (const pid of pids) {
    const exe = await probeExe(pid)
    const sameExe = typeof exe === 'string' && exe.replace(/[\\/]+$/, '').toLowerCase() === expectExe
    if (sameExe) {
      residual.push({ pid, exe, kind: 'same-exe' })
      continue
    }
    // exe 读不到或不同：再看它是不是某个"同名进程"的后代（后端进程场景）。
    // 只沿父链找同名进程，不把整台机器的进程都算进来。
    let cursor = await parents(pid)
    for (let depth = 0; depth < 8 && Number.isInteger(cursor) && cursor > 0; depth += 1) {
      if (pids.includes(cursor)) {
        residual.push({ pid, exe, kind: 'child-of-same-name', parentPid: cursor })
        break
      }
      const next = await parents(cursor)
      if (!Number.isInteger(next) || next <= 0 || next === cursor) break
      cursor = next
    }
  }
  return residual
}

/** 探针：GET ready.url，返回 { ok, status, error }。没有 url 时 ok=null。 */
async function probeReady(program, timeoutMs = 4000) {
  const url = program?.ready?.url
  if (!url) return { url: null, ok: null, status: null, error: null }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    await res.arrayBuffer().catch(() => {})
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
  const residual = await findResidualProcesses(program, deps)
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
  const ready = await probeReady(program)
  if (ready.url === null) {
    evidence.push({ check: 'ready', ok: null, detail: '该程序没有配置就绪 URL，跳过探针检查' })
  } else {
    evidence.push({
      check: 'ready',
      ok: Boolean(ready.ok) === wantRunning,
      detail: ready.ok
        ? `${ready.url} 响应 HTTP ${ready.status}`
        : `${ready.url} 不可达${ready.error ? `（${ready.error}）` : ''}`,
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
