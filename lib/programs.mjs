/**
 * dsh-app-launcher — 多程序生命周期。
 *
 * 每个程序一份独立状态（启动中的 promise、最后就绪时间、最后退出码），
 * 复用 dsh-ninfer-autostart 已实测的三条机制：
 *   1. detached + 隐藏窗口 + stdout/stderr 落盘，宿主不被拖住；
 *   2. single-flight：并发请求共享同一次启动；
 *   3. 进程归属判定：只停本插件启动的进程，靠 netstat/lsof + 落盘 pid + exe 路径比对。
 *
 * 只使用 node 内置模块（原因见 sysinfo.mjs 顶部）。
 */
import { spawn, execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { delay } from './sysinfo.mjs'

/**
 * 无 HTTP 探针的程序（GUI 类）认"就绪"前，至少要存活的时长。
 *
 * 为什么需要：`child.exitCode` 是**异步**设置的，spawn 后几百毫秒内它仍是 null，
 * 于是"按进程存活判定"会把一个刚起来就要退出的进程误判成启动成功。
 * 实测 Comfy Desktop.exe 会在 3 秒内静默退出，阈值取 5 秒能覆盖这类秒退。
 */
export const MIN_LIVENESS_MS = 5000

/**
 * 必须从子进程环境里剔除的变量。
 *
 * `ELECTRON_RUN_AS_NODE=1` —— DSH 宿主自己是用 Electron 打包的，启动时会把
 * 这个变量注入到它自己的进程环境（让 Electron 以纯 Node 模式跑）。我们 spawn
 * 的子进程**继承**了它，后果是：任何 Electron 应用（ComfyUI Desktop、LM Studio
 * 的 GUI 等）拿到这个变量后会以**纯 Node 模式**启动，不建窗口、跑完就退。
 *
 * 实测（2026-11-09）：同一个 `Comfy Desktop.exe`
 *   - 保留该变量 → 57ms 退出，code=0，无任何输出
 *   - 剔除该变量 → 正常启动，输出 `App started v1.1.9 pid=…`
 * 这解释了"为什么用户自己的终端能启动、插件拉起就秒退"。
 *
 * 注意：剔除是安全的——这些变量只影响 Electron 自身的行为模式，
 * 不承担路径/凭据信息（路径类变量我们从不动）。
 */
const ELECTRON_HOST_ENV_KEYS = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'ELECTRON_DEFAULT_ERROR_MODE',
]

/** 当前进程里实际存在、且会被剔除的变量名（用于日志说明）。 */
export function strippedEnvKeys() {
  return ELECTRON_HOST_ENV_KEYS.filter((key) => process.env[key] !== undefined)
}

/**
 * 构造子进程环境变量。
 *
 * 步骤：继承父进程环境 → 剔除会破坏 Electron GUI 的宿主变量
 * → 叠加用户显式配置的 env → 可选把 cwd 前置到 PATH。
 */
export function buildChildEnv(program, cwd) {
  const env = { ...process.env }
  for (const key of ELECTRON_HOST_ENV_KEYS) {
    delete env[key]
  }
  Object.assign(env, program?.launch?.env ?? {})
  if (program?.launch?.prependCwdToPath && cwd) {
    // Windows 的环境变量名大小写不敏感，同一个变量可能以 PATH/Path/path 多份出现
    // （实测 node 进程里三者并存）。只改其中一份不够——子进程拿到的仍可能是另一份。
    // 所以统一找出现有的 PATH 键、把它替换掉，其余重复键删掉。
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
    const base = pathKey ? env[pathKey] : ''
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'PATH') delete env[key]
    }
    env[pathKey ?? 'PATH'] = base ? `${cwd};${base}` : cwd
  }
  return env
}

// ==================== 就绪探针 ====================

/**
 * 探针：GET ready.url 返回状态码 < okStatusMax 即视为就绪。**永不 reject**。
 *
 * 没配 url 的程序（如 Blender 这类纯 GUI，没有 HTTP 健康检查）：
 * 不能直接返回 ready=true —— 那会让界面把"没启动"也显示成"运行中"。
 * 改为**以进程存在为准**：由调用方先查出 pids，再交给这里判断。
 * 因此这个函数的 `ready` 只在"有 url"时才有意义；无 url 时返回
 * `{ ready: null, byProcess: true }`，让上层用 pids 决定在线状态。
 */
export async function probeReady(program, log = () => {}, timeoutMs) {
  const url = program?.ready?.url
  if (!url) return { ready: null, byProcess: true, status: null, url: null }
  const budget = toPositiveInt(timeoutMs, 3000)
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(budget) })
    const okMax = toPositiveInt(program.ready.okStatusMax, 399)
    const ok = res.status < okMax
    await res.arrayBuffer().catch(() => {})
    return { ready: ok, byProcess: false, status: res.status, url }
  } catch (error) {
    log(`探针 ${url} 未通：${error instanceof Error ? error.message : String(error)}`)
    return { ready: false, byProcess: false, status: null, url }
  }
}

function toPositiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

// ==================== 命令行 ====================

/** 拼出实际命令行。`commandOverride` 存在时完全按它执行（联调/换壳用）。 */
export function buildCommand(program) {
  const override = program?.launch?.commandOverride
  if (Array.isArray(override) && override.length > 0) {
    const [exe, ...argv] = override.map(String)
    return { exe, argv, cwd: program?.launch?.cwd || dirname(exe) }
  }
  return {
    exe: program?.launch?.exe ?? '',
    argv: program?.launch?.args ?? [],
    cwd: program?.launch?.cwd ?? '',
  }
}

/** 人类可读的命令行（dryRun 与设置页都用它）。 */
export function describeCommand(program) {
  const { exe, argv, cwd } = buildCommand(program)
  const quote = (value) => (/[\s"]/.test(value) ? `"${value}"` : value)
  return `${[exe, ...argv].map(quote).join(' ')}${cwd ? `  (cwd: ${cwd})` : ''}`
}

// ==================== 启动 ====================

/**
 * 后台拉起程序：detached + windowsHide + stdout/stderr 落盘（追加模式）。
 * 返回 child 与 pid；dryRun 时返回 null。
 */
export function spawnProgram(program, state, log = () => {}, dryRun = false) {
  const { exe, argv, cwd } = buildCommand(program)
  if (!existsSync(exe)) throw new Error(`找不到启动路径：${exe}`)
  if (dryRun) {
    log(`dryRun：本应执行 ${describeCommand(program)}`)
    return null
  }

  mkdirSync(dirname(program.logFile), { recursive: true })
  const fd = openSync(program.logFile, 'a')
  const env = buildChildEnv(program, cwd)

  // 插件自己的诊断也要落盘：子进程可能一个字节都不输出（Electron 类程序常见），
  // 那时日志文件是空的，用户和我们都无从判断"到底起没起、为什么退了"。
  appendLogLine(program.logFile, `===== 启动 ${program.name} =====`)
  appendLogLine(program.logFile, `时间: ${new Date().toISOString()}`)
  appendLogLine(program.logFile, `命令: ${describeCommand(program)}`)
  appendLogLine(program.logFile, `环境: ${Object.keys(program.launch.env ?? {}).join(',') || '(无额外)'}`)
  const stripped = strippedEnvKeys()
  if (stripped.length > 0) {
    appendLogLine(program.logFile, `已剔除继承的环境变量: ${stripped.join(', ')}（见下方说明）`)
  }

  const child = spawn(exe, argv, {
    cwd: cwd || undefined,
    env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  })

  // spawn 本身的错误（ENOENT/EACCES 等）必须被捕获，否则是未处理的 'error' 事件 → 进程崩
  child.on('error', (error) => {
    appendLogLine(program.logFile, `[spawn 失败] ${error.message}`)
    state.lastExit = { code: null, signal: null, at: Date.now(), error: error.message }
    if (state.child === child) state.child = null
  })

  child.on('exit', (code, signal) => {
    const elapsed = state.startedAt ? Date.now() - state.startedAt : null
    state.lastExit = { code, signal, at: Date.now(), elapsedMs: elapsed }
    if (state.child === child) state.child = null
    appendLogLine(
      program.logFile,
      `[进程退出] pid=${child.pid} code=${code} signal=${signal ?? '-'} 存活=${elapsed === null ? '?' : `${elapsed}ms`}`,
    )
    // 极短存活 + code 0 + 无输出：Electron 类程序从后台启动时的典型表现
    if (elapsed !== null && elapsed < 5000 && code === 0) {
      appendLogLine(
        program.logFile,
        '[诊断] 进程在 5 秒内以退出码 0 静默退出，且多半没有输出任何内容。' +
          '常见原因：该程序是 GUI/Electron 应用，只允许从交互式桌面会话启动；' +
          '或它把启动工作转交给了已在运行的实例后自行退出。',
      )
    }
  })
  state.child = child
  state.startedAt = Date.now()
  state.lastReadyAt = 0
  state.lastStopAt = 0
  writeState(program, state, {
    pid: child.pid ?? null,
    exe,
    startedAt: state.startedAt,
    logFile: program.logFile,
  })
  child.unref()
  appendLogLine(program.logFile, `[已创建进程] pid=${child.pid}（日志：${program.logFile}）`)
  log(`已启动 ${program.name} pid=${child.pid}（日志：${program.logFile}）`)
  return child
}

/**
 * 往程序日志追加一行插件侧诊断。
 *
 * 为什么单独写而不走 stdout：子进程的 stdout 就是同一个文件，但**插件自身**的
 * 判断（起了什么命令、退出码、是否秒退）不属于子进程输出，混在 stdio 里会被
 * 子进程的缓冲覆盖顺序打乱。用独立的 append 保证这些行一定在文件里。
 *
 * 失败不抛：日志写不进去不能影响启动主流程。
 */
export function appendLogLine(logFile, line) {
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    appendFileSync(logFile, `${line}\n`, 'utf8')
  } catch {
    /* 日志写失败不影响启动 */
  }
}

// ==================== 状态持久化（跨宿主重启的进程归属） ====================

export function stateFiles(program) {
  const dir = dirname(program.logFile)
  return { dir, state: join(dir, `${program.id}-state.json`) }
}

export function readState(program) {
  try {
    // 必须吃掉 BOM：用 PowerShell 5.1 的 Set-Content -Encoding UTF8 或记事本手改
    // 都会写入 EF BB BF，JSON.parse 会直接抛错。
    const raw = readFileSync(stateFiles(program).state, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function writeState(program, state, patch) {
  try {
    mkdirSync(stateFiles(program).dir, { recursive: true })
    const merged = { ...(readState(program) ?? {}), ...pickDefined(patch) }
    writeFileSync(stateFiles(program).state, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    state.remembered = merged
    return merged
  } catch {
    return null
  }
}

export function clearState(program, state) {
  try {
    rmSync(stateFiles(program).state, { force: true })
  } catch {
    /* 文件不存在或不可删都不影响主流程 */
  }
  if (state) state.remembered = null
}

function pickDefined(source) {
  const out = {}
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

// ==================== 端口占用 / 进程归属 ====================

/** 解析 `netstat -ano -p tcp` 输出里监听指定端口的 PID（纯函数）。 */
export function parseNetstatListeners(text, port) {
  const suffix = `:${port}`
  const pids = new Set()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const parts = line.trim().split(/\s+/)
    if (!(parts[1] ?? '').endsWith(suffix)) continue
    const pid = Number(parts[parts.length - 1])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/** 解析 `lsof -ti tcp:PORT -sTCP:LISTEN` 输出（POSIX）。 */
export function parseLsofListeners(text) {
  const pids = String(text ?? '').split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  return [...new Set(pids)]
}

/** 从 ready.url 里取端口；取不到返回 null。 */
export function portOf(program) {
  const url = program?.ready?.url
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.port) return Number(parsed.port)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

function execFileText(exe, argv, timeoutMs = 10000) {
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
 * 谁在对这个程序"在跑"。
 *
 * 两种程序要覆盖：
 *  - **有端口的服务**（ComfyUI 后端、LM Studio server、NInfer）：查监听该端口的 pid；
 *  - **无端口的 GUI**（Blender、记事本这类）：没有端口可查，退回按进程名找 pid。
 *
 * 返回值语义严格区分：**null = 读不到**（工具不可用），**[] = 确实没在跑**。
 * 调用方靠这个区别决定"拒绝停止"还是"已处于停止"。
 */
export async function listeningPids(program, log = () => {}, deps = {}) {
  const port = portOf(program)
  if (!port) {
    // 没配 ready.url（或其中没有端口）→ 按进程名探测。
    const name = processNameOf(program?.launch?.exe)
    if (name === '') return []
    return pidsByProcessName(name, deps)
  }
  if (process.platform === 'win32') {
    const out = await execFileText('netstat', ['-ano', '-p', 'tcp'])
    if (out === null) {
      log(`netstat 调用失败，无法判定端口 ${port} 占用`)
      return null
    }
    return parseNetstatListeners(out, port)
  }
  const out = await execFileText('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
  return out === null ? null : parseLsofListeners(out)
}

// ==================== 无端口的 GUI 程序（按进程名识别） ====================

/**
 * 从 exe 路径取进程名（不含扩展名与路径），用于「按进程名找 pid」。
 * `E:\...\Blender\blender.exe` → `blender`
 */
export function processNameOf(exe) {
  const text = String(exe ?? '').trim()
  if (text === '') return ''
  const base = text.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.exe$/i, '')
}

/**
 * 按进程名找 pid。
 *
 * 为什么需要它：像 **Blender** 这类纯 GUI 程序**不监听任何 HTTP 端口**，
 * 现有的"端口 → pid"识别对它永远返回空，于是界面会一直显示"已停止"，
 * 也无法认出用户自己启动的实例。这里改用进程名做兜底探测。
 *
 * 只使用系统自带工具（node 内置模块 + tasklist/PowerShell），不引依赖。
 * **永不 reject**；读不到返回 null（区别于"确实没在跑"的空数组）。
 */
export async function pidsByProcessName(name, deps = {}) {
  const target = String(name ?? '').trim()
  if (target === '') return []
  if (typeof deps.pidsByProcessName === 'function') return deps.pidsByProcessName(target)

  if (process.platform === 'win32') {
    // tasklist 最轻量：/FI 过滤进程名，输出固定列。
    const out = await execFileText('tasklist', ['/FI', `IMAGENAME eq ${target}.exe`, '/FO', 'CSV', '/NH'])
    if (out === null) {
      // tasklist 不可用时退回 PowerShell（CIM 查询）。
      const ps = await execFileText('powershell', [
        '-NoProfile',
        '-Command',
        `Get-Process -Name '${target.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }`,
      ])
      return ps === null ? null : ps.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0)
    }
    const pids = []
    for (const line of String(out).split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('"')) continue
      const cols = trimmed.split('","').map((item) => item.replace(/^"|"$/g, ''))
      const pid = Number(cols[1])
      if (Number.isInteger(pid) && pid > 0) pids.push(pid)
    }
    return [...new Set(pids)]
  }

  const out = await execFileText('pgrep', ['-x', target])
  return out === null ? null : out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0)
}

/** 读进程可执行文件路径：尽力而为，读不到返回 null（权限不足很常见）。 */
export async function processExePath(pid) {
  if (process.platform === 'win32') {
    // wmic 在新版 Windows 上可能被移除，退回 PowerShell CIM 查询。
    const wmic = await execFileText('wmic', ['process', 'where', `processid=${pid}`, 'get', 'executablepath', '/value'])
    if (wmic !== null) {
      const matched = /ExecutablePath=(.+)/i.exec(wmic)
      if (matched) return matched[1].trim()
    }
    const ps = await execFileText(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).Path`],
    )
    return ps === null ? null : ps.trim() || null
  }
  const out = await execFileText('ps', ['-o', 'comm=', '-p', String(pid)])
  return out === null ? null : out.trim() || null
}

/**
 * 读进程的父进程 PID：读不到返回 null。
 *
 * 用于归属判定沿父子链回溯（见 ownershipOf）：Electron 壳与它派生的后端
 * 是两个不同 PID，只有父链能把它们联系起来。
 */
export async function parentPidOf(pid) {
  if (process.platform === 'win32') {
    const ps = await execFileText(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ParentProcessId`],
    )
    if (ps === null) return null
    const value = Number(ps.trim())
    return Number.isInteger(value) && value > 0 ? value : null
  }
  const out = await execFileText('ps', ['-o', 'ppid=', '-p', String(pid)])
  if (out === null) return null
  const value = Number(out.trim())
  return Number.isInteger(value) && value > 0 ? value : null
}

function samePath(left, right) {
  const norm = (value) => String(value ?? '').replace(/[\\/]+$/, '').toLowerCase()
  return norm(left) === norm(right)
}

/**
 * 判定端口占用者是否"归本插件管"：
 * 依据当前会话记住的 pid，或上次会话落盘在 <id>-state.json 里的 pid。
 * 额外核对可执行文件路径——能读到且不匹配就拒绝，防 PID 复用导致误杀。
 *
 * ★ 必须沿**父子链**匹配，不能只比精确 PID。
 *
 * 实测（2026-11-09，ComfyUI Desktop）：插件 spawn 的是 Electron 外壳
 * （`Comfy Desktop.exe`），而真正监听 8188 的是它派生的后端
 * `python.exe ComfyUI/main.py --base-directory …`。两者是父子关系，
 * 精确 PID 比对必然不相等 → 插件把自己启动的服务判成"外部进程"而拒绝停止。
 * 所有"Electron/GUI 壳 + 子进程后端"的软件（ComfyUI Desktop、LM Studio 等）
 * 都会踩这个坑。
 */
export async function ownershipOf(program, state, pids, deps = {}) {
  const remembered = readState(program)
  const roots = new Set()
  if (state?.child?.pid) roots.add(state.child.pid)
  if (Number.isInteger(state?.remembered?.pid)) roots.add(state.remembered.pid)
  if (Number.isInteger(remembered?.pid)) roots.add(remembered.pid)

  const parents = deps.parentPidOf ?? parentPidOf
  // 逐个端口占用者向上追溯父链，看能否落到"我们记住的那个 PID"。
  // 追溯深度设上限：防环（PID 复用时可能出现自环）与异常深的进程树。
  const chainOf = async (pid) => {
    const chain = [pid]
    let cursor = pid
    for (let depth = 0; depth < 16; depth += 1) {
      const parent = await parents(cursor)
      if (!Number.isInteger(parent) || parent <= 0 || chain.includes(parent)) break
      chain.push(parent)
      cursor = parent
    }
    return chain
  }

  const ownedPids = []
  const descendants = new Map()
  for (const pid of pids) {
    if (roots.has(pid)) {
      ownedPids.push(pid)
      continue
    }
    const chain = await chainOf(pid)
    // 链上出现我们记住的 PID，说明这个端口占用者是它的后代 → 也算我们的。
    const hit = chain.find((item) => roots.has(item))
    // 链长必须 >1：链只有自己说明它不是任何已记录进程的后代。
    if (hit !== undefined && chain.length > 1) {
      ownedPids.push(pid)
      descendants.set(pid, hit)
    }
  }

  const info = {
    owned: ownedPids.length > 0,
    pids,
    ownedPids,
    foreignPids: pids.filter((pid) => !ownedPids.includes(pid)),
    /** 经父链认领的 PID → 它所属的已记录根 PID（便于日志与界面解释） */
    viaDescendantOf: Object.fromEntries(descendants),
    /** 本插件记住的根 PID（Electron 壳等）。停止时需要一并杀掉，否则会留空壳。 */
    rootPids: [...roots],
    source: null,
    reason: '',
  }
  if (ownedPids.length === 0) {
    // 无端口程序（Blender 这类 GUI）没有端口可言，文案必须说"进程"，
    // 否则会输出「端口 null 被 PID … 占用」这种让人以为配置坏了的句子。
    const port = portOf(program)
    info.reason = port === null
      ? `进程 PID ${pids.join('、')}（${processNameOf(program?.launch?.exe) || '未知'}）在运行，但不是本插件启动的（归属未知），拒绝停止`
      : `端口 ${port} 被 PID ${pids.join('、')} 占用，但不是本插件启动的进程（归属未知），拒绝停止`
    return info
  }
  info.source = descendants.size > 0
    ? 'state-file-parent'
    : (state?.child?.pid && ownedPids.includes(state.child.pid) ? 'session' : 'state-file')

  // 可执行文件校验（防 PID 复用误杀）：只对"精确命中"的 PID 生效。
  //
  // 经父链认领的 PID 通常是后端 python 或渲染子进程，它们的 exe 本来就和
  // 配置的启动入口不同（ComfyUI Desktop 的壳是 Comfy Desktop.exe，后端是
  // venv 里的 python.exe）。对这些进程拿 exe 去比配置路径必然不等，
  // 若照旧拒绝，父子链匹配就白做了。这里改为只跳过校验，不放宽其它判据。
  const probeExe = deps.processExePath ?? processExePath
  const expectExe = program?.launch?.exe ?? ''
  for (const pid of ownedPids) {
    if (descendants.has(pid)) continue
    const exe = await probeExe(pid)
    if (exe && expectExe && !samePath(exe, expectExe)) {
      info.owned = false
      info.reason = `PID ${pid} 的可执行文件是 ${exe}，与配置的 ${expectExe} 不一致，拒绝停止（可能是 PID 复用）`
      return info
    }
  }
  const viaNote = descendants.size > 0
    ? `（其中 ${[...descendants.entries()].map(([pid, root]) => `${pid} 是 ${root} 的后代`).join('、')}）`
    : ''
  info.reason = portOf(program) === null
    ? `进程 PID ${ownedPids.join('、')} 由本插件启动${viaNote}`
    : `端口 ${portOf(program)} 由本插件启动的 PID ${ownedPids.join('、')} 占用${viaNote}`
  return info
}

/** 杀进程树：Windows 用 `taskkill /T /F`，POSIX 先杀进程组。 */
export function killProcessTree(pid, log = () => {}) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          const reason = String(stderr ?? '').trim() || error.message
          log(`taskkill ${pid} 失败：${reason}`)
          resolve({ ok: false, reason })
          return
        }
        resolve({ ok: true, detail: String(stdout ?? '').trim() })
      })
      return
    }
    try {
      process.kill(-pid, 'SIGTERM')
      resolve({ ok: true, detail: 'SIGTERM(process-group)' })
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
        resolve({ ok: true, detail: 'SIGTERM(pid)' })
      } catch (error) {
        resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  })
}

// ==================== 单个程序的生命周期 ====================

/** 每个程序一份运行时状态。键是程序 id。 */
export function createRegistry() {
  const states = new Map()
  const inflight = new Map()
  return {
    stateOf(id) {
      if (!states.has(id)) {
        states.set(id, {
          child: null,
          inflight: null,
          startedAt: 0,
          lastReadyAt: 0,
          lastStopAt: 0,
          lastExit: null,
          remembered: null,
          online: false,
          starting: false,
          probeStatus: null,
        })
      }
      return states.get(id)
    },
    /** 仅供 statusSnapshot：程序"在跑"= 探针通 或 端口有人监听 或 进程还活着。 */
    isActive(id) {
      const state = states.get(id)
      return Boolean(state && (state.online || state.child))
    },
  }
}

/**
 * 确保程序在线：已就绪直接放行；否则交给调用方先跑门控，再 spawn + 轮询就绪。
 * 并发请求共享同一次启动（single-flight）。
 *
 * @param {object} program     归一化后的程序
 * @param {object} state       registry.stateOf(id)
 * @param {object} opts        { dryRun, log }
 */
export async function ensureRunning(program, state, { dryRun = false, log = () => {} } = {}) {
  // probeCache 用 state.lastReadyAt 表示；由上层判定是否要短路，这里只负责"真的起一次"。
  if (state.inflight) {
    log(`${program.name} 已有启动流程在进行，等待同一流程…`)
    return state.inflight
  }

  state.starting = true
  state.inflight = (async () => {
    const child = spawnProgram(program, state, log, dryRun)
    if (dryRun || child === null) {
      return { ready: false, dryRun: true, pid: null, elapsedMs: 0 }
    }
    const timeoutMs = program.ready.timeoutMs
    const intervalMs = program.ready.intervalMs
    const deadline = Date.now() + timeoutMs
    const startedAt = Date.now()
    log(`等待 ${program.name} 就绪，最长 ${Math.round(timeoutMs / 1000)}s…`)
    appendLogLine(program.logFile, `[等待就绪] 最长 ${timeoutMs}ms，间隔 ${intervalMs}ms，探针=${program.ready.url || '(无，按进程名判定)'}`)

    /** 进程退出后的诊断消息：带上存活时长与"秒退"提示。 */
    const exitMessage = () => {
      const exit = state.lastExit
      const elapsed = exit?.elapsedMs ?? (Date.now() - startedAt)
      const codePart = exit?.code === null ? `signal ${exit?.signal}` : `exit ${exit?.code}`
      const silentHint = elapsed < 5000 && exit?.code === 0
        ? '进程在 5 秒内以退出码 0 静默退出且没有输出，通常是 GUI/Electron 程序只能从桌面启动，或它把工作转交给了已有实例。'
        : ''
      return `${program.name} 启动失败：进程已退出（${codePart}，存活 ${elapsed}ms）。${silentHint}详见日志 ${program.logFile}`
    }

    // 启动器类程序的宽限窗口：子进程（真正的服务）还在把端口拉起来，
    // 不能因为启动器自己退出就立刻判失败。见下方 while 循环里的说明。
    const LAUNCHER_GRACE_MS = 15000
    let exitSeenAt = 0

    while (Date.now() < deadline) {
      // ★ 启动器退出不等于启动失败。
      //
      // 实测（2026-11-09，LM Studio）：命令是 `lms.exe server start`（CLI 启动器），
      // 它拉起 GUI/服务后**自己以 code 0 退出**。日志里能清楚看到：
      //     Success! Server is now running on port 1234   ← 服务已就绪
      //     [进程退出] pid=29764 code=0 存活=3329ms        ← 启动器随后退出
      // 旧逻辑"先查退出、后查探针"，于是这一轮直接抛"启动失败"，
      // 而实际上 LM Studio 已经有 5 个进程在跑、1234 返回 200。
      //
      // 现在的语义：看到启动器退出**不立即失败**，改为继续轮询探针一个宽限
      // 窗口；期间探针通了就算成功（说明工作已交接给子进程），窗口结束仍未通
      // 才报失败。无探针的 GUI 程序没有"交接"概念，保持原来的立即失败。
      if (child.exitCode !== null) {
        const hasProbe = Boolean(program?.ready?.url)
        if (!hasProbe) {
          appendLogLine(program.logFile, `[启动失败] ${exitMessage()}`)
          throw new Error(exitMessage())
        }
        if (exitSeenAt === 0) {
          exitSeenAt = Date.now()
          appendLogLine(
            program.logFile,
            `[进程退出] 启动器 pid=${child.pid} 已退出（code=${child.exitCode}）；` +
              `它可能是启动器/壳，服务由子进程继续拉起。继续等待探针，宽限 ${LAUNCHER_GRACE_MS}ms。`,
          )
        }
        if (Date.now() - exitSeenAt >= LAUNCHER_GRACE_MS) {
          appendLogLine(program.logFile, `[启动失败] ${exitMessage()}`)
          throw new Error(exitMessage())
        }
      }
      const probe = await probeReady(program, log)
      state.probeStatus = probe.status

      // 无 HTTP 探针的程序（GUI 类）只能"按进程存活"判定就绪，
      // 但进程可能在 spawn 后的几百毫秒内静默退出，而 child.exitCode 是
      // 异步设置的 —— 刚 spawn 完它还是 null。所以这里要求先活过
      // MIN_LIVENESS_MS 再认"就绪"，否则会把秒退误报成启动成功。
      if (probe.byProcess) {
        const aliveFor = Date.now() - startedAt
        if (child.exitCode !== null) {
          appendLogLine(program.logFile, `[启动失败] ${exitMessage()}`)
          throw new Error(exitMessage())
        }
        if (aliveFor >= MIN_LIVENESS_MS) {
          state.lastReadyAt = Date.now()
          state.online = true
          appendLogLine(
            program.logFile,
            `[就绪] 无探针程序，按进程存活判定：已存活 ${aliveFor}ms（阈值 ${MIN_LIVENESS_MS}ms）`,
          )
          return {
            ready: true,
            started: true,
            pid: child.pid,
            elapsedMs: Date.now() - startedAt,
            status: probe.status,
            byProcess: true,
          }
        }
        // 还没活够最小观察窗口，继续等
        await delay(Math.min(300, intervalMs))
        continue
      }

      if (probe.ready) {
        // 这里**不再**因为 child.exitCode !== null 判失败。
        // 探针已经通了 = 服务确实在跑，此时启动器退出正是"交接完成"的正常表现。
        // 旧逻辑在这里也查退出，是 LM Studio 被误报失败的第二个原因。
        state.lastReadyAt = Date.now()
        state.online = true
        const handoff = exitSeenAt !== 0 ? `（启动器 pid=${child.pid} 已退出，服务由子进程接管）` : ''
        appendLogLine(
          program.logFile,
          `[就绪] 用时 ${Date.now() - startedAt}ms，探针状态=${probe.status ?? '-'}${handoff}`,
        )
        return {
          ready: true,
          started: true,
          pid: child.pid,
          elapsedMs: Date.now() - startedAt,
          status: probe.status,
          byProcess: Boolean(probe.byProcess),
          handoff: exitSeenAt !== 0,
        }
      }
      await delay(intervalMs)
    }
    const timeoutMessage = `等待 ${program.name} 就绪超时（${timeoutMs}ms），进程仍在运行但探针未通。请查看日志 ${program.logFile}`
    appendLogLine(program.logFile, `[启动超时] ${timeoutMessage}`)
    throw new Error(timeoutMessage)
  })()

  try {
    return await state.inflight
  } finally {
    state.starting = false
    state.inflight = null
  }
}

/** 按程序名取当前 PID 列表；无端口程序用它做"我的 PID 是否还在"的二次判定。 */
async function pidsByName(program, deps = {}) {
  const name = processNameOf(program?.launch?.exe)
  if (name === '') return []
  return pidsByProcessName(name, deps)
}

/**
 * 停止程序。**只停本插件启动的进程**：归属校验不过就直接拒绝，绝不误杀手动起的服务。
 */
export async function stopProgram(program, state, log = () => {}, deps = {}) {
  const probe = deps.listeningPids ?? listeningPids
  const kill = deps.killProcessTree ?? killProcessTree
  const pids = await probe(program, log, deps)

  // 没有探针端口（如 LM Studio 的 GUI 壳没有固定端口）时，退化到"本会话记住的 pid"。
  if (pids === null) {
    const ownPid = state?.child?.pid
    if (!ownPid) {
      return { stopped: false, reason: '无法判定端口占用（netstat/lsof 不可用），且没有本会话启动的 PID，为安全起见不执行停止' }
    }
    const result = await kill(ownPid, log)
    if (!result.ok) return { stopped: false, reason: `停止失败：${result.reason}` }
    clearState(program, state)
    state.online = false
    state.lastStopAt = Date.now()
    state.lastReadyAt = 0
    state.lastExit = null
    return { stopped: true, reason: `已停止本会话启动的 PID ${ownPid}（无端口可校验）` }
  }
  if (pids.length === 0) {
    // 端口没人监听，但可能还有本会话的进程（例如 GUI 壳）
    const ownPid = state?.child?.pid
    if (ownPid && state.child.exitCode === null) {
      const result = await kill(ownPid, log)
      clearState(program, state)
      state.online = false
      state.lastStopAt = Date.now()
      state.lastReadyAt = 0
      return result.ok
        ? { stopped: true, reason: `端口无监听，已停止本会话启动的 PID ${ownPid}` }
        : { stopped: false, reason: `停止失败：${result.reason}` }
    }
    clearState(program, state)
    state.online = false
    state.lastStopAt = Date.now()
    state.lastReadyAt = 0
    return { stopped: true, alreadyStopped: true, reason: '无监听进程，程序已处于停止状态' }
  }

  const ownership = await ownershipOf(program, state, pids, deps)
  if (!ownership.owned) return { stopped: false, ownership, reason: ownership.reason }

  // 要杀的目标 = 端口占用者（可能是后端 python）+ 我们记住的根进程。
  //
  // 为什么必须补上根：ComfyUI Desktop 这类"Electron 壳 + 子进程后端"的软件，
  // 端口监听者是后代（python），只杀它会让 Electron 壳变成没后端的空窗口
  // 留在任务管理器里。反过来杀根就够了（taskkill /T 会带走整棵子树），
  // 但保留两者可以兜住"后端被重新拉起"的情况。
  const killTargets = [...new Set([...ownership.ownedPids, ...(ownership.rootPids ?? [])])]
  const results = []
  for (const pid of killTargets) results.push({ pid, ...(await kill(pid, log)) })

  // 确认条件必须锚定"我杀掉的那几个 PID"是否消失，**不能**用
  // "同名进程/端口全部消失"。
  //
  // 踩过的坑（2026-11-09，Blender）：用户手动启动的实例与插件启动的实例
  // 同名并存（PID 24340 / 16156）。插件只杀自己的 16156，随后仍用
  // listeningPids 轮询"还有没有 blender.exe"——24340 一直在，
  // 于是必然报「已发出停止信号，但端口 null 在 20000ms 内未释放」，
  // 把一次成功的停止伪装成失败。端口 null 本身也没有可轮询的语义。
  //
  // 现在的语义：
  //   - 先看有没有 PID 可查（portOf !== null 才谈端口释放）；
  //   - 否则要求 ownedPids 全部从 processExePath / pidsByProcessName 里消失；
  //   - 只要仍在跑，再补一次 kill（有些进程 taskkill /T /F 后会短暂僵住）。
  const port = portOf(program)
  const isGone = async (pid) => {
    if (state?.child?.pid === pid && state.child.exitCode !== null) return true
    const exe = await (deps.processExePath ?? processExePath)(pid)
    // 读不到 exe：既可能是进程没了，也可能是权限不足。用进程名列表做二次判定。
    if (exe !== null) return false
    const names = await pidsByName(program, deps)
    return Array.isArray(names) ? !names.includes(pid) : false
  }
  const deadline = Date.now() + program.stopTimeoutMs
  let released = false
  let reaped = []
  while (Date.now() < deadline) {
    if (port === null) {
      reaped = []
      for (const pid of ownership.ownedPids) {
        if (await isGone(pid)) reaped.push(pid)
      }
      if (reaped.length === ownership.ownedPids.length) {
        released = true
        break
      }
    } else {
      const now = await probe(program, log, deps)
      if (Array.isArray(now) && now.length === 0) {
        released = true
        break
      }
    }
    await delay(500)
  }
  if (!released) {
    const failed = results.filter((item) => !item.ok)
    const targets = killTargets.join('、')
    return {
      stopped: false,
      ownership,
      results,
      reason: failed.length > 0
        ? `停止失败：${failed.map((item) => item.reason).join('；')}`
        : port === null
          ? `已发出停止信号，但 PID ${targets} 在 ${program.stopTimeoutMs}ms 内仍未退出`
          : `已发出停止信号，但端口 ${port} 在 ${program.stopTimeoutMs}ms 内未释放`,
    }
  }
  clearState(program, state)
  state.online = false
  state.lastStopAt = Date.now()
  state.lastReadyAt = 0
  state.lastExit = null
  const viaNote = Object.keys(ownership.viaDescendantOf ?? {}).length > 0
    ? `（含经父子链认领的后端进程 ${Object.keys(ownership.viaDescendantOf).join('、')}）`
    : ''
  log(`${program.name} 已停止（PID ${killTargets.join('、')}）`)
  return { stopped: true, ownership, results, reason: `已停止 PID ${killTargets.join('、')}${viaNote}` }
}

// ==================== 日志 ====================

/** 读程序日志尾部，失败返回 null。 */
export function readLogTail(program, lines = 40) {
  try {
    const info = statSync(program.logFile)
    const raw = readFileSync(program.logFile, 'utf8')
    return {
      text: raw,
      tail: raw.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-Math.max(1, lines)),
      size: info.size,
      mtime: info.mtimeMs,
    }
  } catch {
    return null
  }
}
