/**
 * dsh-app-launcher — 配置归一化。
 *
 * 配置形态（cordis.patch.yml 的 config:<id> 下）：
 *   enabled / verbose / dryRun / sampleCacheMs / unreadableGpuPolicy / conflictPolicy
 *   programs: 统一条目池「软件/脚本/目录」，每条：
 *     { id, name, kind:'program'|'script'|'directory', sessions:[会话id...],
 *       enabled, description, launch{exe,args,cwd,env,interpreter}, needs{...},
 *       exclusive, ready{url,timeoutMs,intervalMs}, stopTimeoutMs, logFile,
 *       path（仅 directory） }
 *
 * 授权模型（poolVersion 2）：**没有全局授权**。每个条目必须显式授权给具体会话
 * （sessions 列表）才对那个会话可见；sessions 为空的条目只在设置页可见。
 *
 * 这里只做"补齐默认 + 校验类型"，**不改写用户写的路径**，让设置页能原样显示。
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeNeeds } from './gate.mjs'

export const LAUNCHER_DEFAULTS = {
  /** 总开关。false 时 tool 只读（能查状态、不能起停），设置页仍可看。 */
  enabled: true,
  verbose: true,
  /** 只打印将执行的命令，不真的拉起进程。 */
  dryRun: false,
  /** 采样缓存时长。 */
  sampleCacheMs: 3000,
  /** 读不到 GPU 状态时：'reject' 放弃启动 | 'allow' 仍然启动。 */
  unreadableGpuPolicy: 'reject',
  /** 同族互斥冲突时：'reject' 只拒绝给建议 | 'stop-own' 允许先停本插件启动的。 */
  conflictPolicy: 'reject',
  /** nvidia-smi 可执行文件（可给绝对路径）。 */
  nvidiaSmi: 'nvidia-smi',
  /** 每次启动后等待就绪的默认上限（程序自己的 ready.timeoutMs 优先）。 */
  readyTimeoutMs: 180000,
  /** 设置页展示的日志尾部行数。 */
  logTailLines: 40,
  /**
   * @deprecated poolVersion 2 起废除全局授权目录。
   * 旧配置里的这个列表会在迁移时转成 kind='directory' 的条目（sessions=[]，
   * 即默认不授权给任何会话）。保留字段只为读得懂旧文件，新代码不再使用它。
   */
  allowedDirs: [],
  programs: [],
}

/** 条目类型：软件 / 脚本 / 目录。 */
export const ENTRY_KINDS = ['program', 'script', 'directory']

/**
 * 脚本扩展名 → 解释器推导表（kind='script' 且未显式填 interpreter 时用）。
 * shell:true 表示交给系统 shell 执行（Windows 下 .bat/.cmd 必须如此，
 * 否则带空格的路径会被 cmd 错误解析）。
 */
export const SCRIPT_INTERPRETERS = {
  '.ps1': { exe: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'] },
  '.bat': { shell: true },
  '.cmd': { shell: true },
  '.py': { exe: 'python.exe', args: [] },
  '.js': { exe: 'node.exe', args: [] },
  '.mjs': { exe: 'node.exe', args: [] },
  '.cjs': { exe: 'node.exe', args: [] },
  '.sh': { exe: 'sh', args: [] },
  '.vbs': { exe: 'cscript.exe', args: ['//Nologo'] },
  '.jar': { exe: 'java.exe', args: ['-jar'] },
}

/** 按扩展名推导脚本解释器；未知扩展名返回 null（保存时会被拒绝）。 */
export function inferScriptInterpreter(scriptPath) {
  const text = String(scriptPath ?? '')
  const dot = text.lastIndexOf('.')
  if (dot < 0) return null
  const ext = text.slice(dot).toLowerCase()
  return SCRIPT_INTERPRETERS[ext] ?? null
}

/** 归一化会话授权列表：去空、去重、只留非空字符串。 */
export function normalizeSessions(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const text = String(item ?? '').trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function toPositiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item))
}

function asEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue
    out[String(key)] = String(raw)
  }
  return out
}

/** 数据目录：$DSH_HOME/app-launcher（状态文件与日志都落这里）。 */
export function dataDirOf() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'app-launcher')
}

/**
 * 归一化单个条目（软件/脚本/目录）。缺关键字段的条目会被标记 invalid
 * （而不是静默丢弃），这样设置页能直接显示出"这条配错了"。
 */
export function normalizeProgram(raw = {}, index = 0) {
  const launch = raw.launch ?? {}
  const ready = raw.ready ?? {}
  const id = String(raw.id ?? '').trim() || `program-${index + 1}`
  const name = String(raw.name ?? '').trim() || id
  const kind = ENTRY_KINDS.includes(raw.kind) ? raw.kind : 'program'
  const exe = String(launch.exe ?? raw.exe ?? '').trim()
  const dirPath = String(raw.path ?? raw.dirPath ?? '').trim()
  const rawCwd = String(launch.cwd ?? raw.cwd ?? '').trim()
  // 用户没填工作目录时默认用 exe 所在目录；但要记住"这是推导出来的"，
  // 因为保存验证只该校验用户真正填的值（推导值随 exe 走，不必单独验）。
  const cwd = rawCwd || (exe ? dirname(exe) : '')
  const logFile = String(raw.logFile ?? '').trim()

  const isDirectory = kind === 'directory'
  const valid = isDirectory ? isAbsolutePath(dirPath) : Boolean(exe)
  const invalidReason = valid
    ? null
    : isDirectory
      ? '目录条目缺少绝对路径（path）'
      : kind === 'script'
        ? '脚本条目缺少脚本路径（launch.exe）'
        : '缺少 launch.exe 启动路径'

  return {
    id,
    name,
    /** 条目类型：program=软件 / script=脚本 / directory=目录（只授权浏览，不可启动）。 */
    kind,
    /**
     * 会话授权列表：只有列在这里的会话才能通过工具看到/使用这个条目。
     * 空列表 = 不授权给任何会话（仅设置页可见）。没有"全局授权"这一层。
     */
    sessions: normalizeSessions(raw.sessions),
    /** 仅 directory 条目使用：被授权浏览的目录绝对路径。 */
    path: isDirectory ? dirPath : '',
    enabled: raw.enabled !== false,
    description: String(raw.description ?? '').trim(),
    launch: {
      exe,
      args: asStringArray(launch.args ?? raw.args),
      cwd,
      /** cwd 是用户显式填的还是从 exe 推导的（决定保存时是否单独校验它）。 */
      cwdExplicit: rawCwd !== '',
      env: asEnv(launch.env ?? raw.env),
      /** 把 cwd 前置到子进程 PATH（需要同目录 DLL 的引擎用）。 */
      prependCwdToPath: launch.prependCwdToPath !== false && Boolean(cwd),
      /** 仅 script 条目：显式解释器（留空则按扩展名推导）。 */
      interpreter: String(launch.interpreter ?? raw.interpreter ?? '').trim(),
    },
    /**
     * 这个程序自己的授权目录。
     *
     * 授权目录**跟着程序走**，而不是全插件一张总表：
     * 每个程序只该看到自己需要的那些目录（ComfyUI 要模型/输出目录，
     * Blender 要安装与工程目录），互不相干，也避免一个程序授权整盘后
     * 牵连其它程序。
     */
    allowedDirs: normalizeAllowedDirs(raw.allowedDirs),
    /**
     * 是否允许本插件拉起它（默认 true）。
     *
     * 为什么要这个开关：有些软件**只能由人从桌面启动**（`Comfy Desktop.exe`
     * 从后台进程启动会 3 秒内静默退出、退出码 0、不产生任何输出）。把它们
     * 标成 manual 后，插件仍会：检测它有没有在跑、显示状态、允许停止；
     * 但点「启动」会直接说明"这个程序需要手动启动"，而不是白等一轮超时。
     */
    launchable: !isDirectory && raw.launchable !== false,
    /** manual 时给用户看的说明（为什么不能自动启动）。 */
    launchHint: String(raw.launchHint ?? '').trim(),
    needs: normalizeNeeds(raw.needs ?? {}),
    exclusive: String(raw.exclusive ?? '').trim(),
    ready: {
      url: String(ready.url ?? raw.readyUrl ?? '').trim(),
      timeoutMs: toPositiveInt(ready.timeoutMs, LAUNCHER_DEFAULTS.readyTimeoutMs),
      intervalMs: toPositiveInt(ready.intervalMs, 1000),
      /** 探针可接受的状态码下限（部分程序未实现该端点，可用 404 也算活着）。 */
      okStatusMax: toPositiveInt(ready.okStatusMax, 399),
    },
    stopTimeoutMs: toPositiveInt(raw.stopTimeoutMs, 20000),
    logFile: logFile || join(dataDirOf(), `${id}.log`),
    /** 配置是否完整到可以启动（目录条目：路径完整即可授权浏览）。 */
    valid,
    invalidReason,
  }
}

/** 归一化整个插件配置。 */
export function resolveConfig(raw = {}) {
  const merged = { ...LAUNCHER_DEFAULTS, ...pickDefined(raw) }
  const programs = Array.isArray(raw.programs) ? raw.programs : []
  merged.programs = programs.map((item, index) => normalizeProgram(item, index))
  merged.enabled = merged.enabled !== false
  merged.dryRun = merged.dryRun === true
  merged.verbose = merged.verbose !== false
  merged.sampleCacheMs = toPositiveInt(merged.sampleCacheMs, LAUNCHER_DEFAULTS.sampleCacheMs)
  merged.readyTimeoutMs = toPositiveInt(merged.readyTimeoutMs, LAUNCHER_DEFAULTS.readyTimeoutMs)
  merged.logTailLines = toPositiveInt(merged.logTailLines, LAUNCHER_DEFAULTS.logTailLines)
  merged.unreadableGpuPolicy = String(merged.unreadableGpuPolicy) === 'allow' ? 'allow' : 'reject'
  merged.conflictPolicy = String(merged.conflictPolicy) === 'stop-own' ? 'stop-own' : 'reject'
  merged.nvidiaSmi = String(merged.nvidiaSmi || 'nvidia-smi')
  merged.allowedDirs = normalizeAllowedDirs(raw.allowedDirs)
  /** 条目池版本：2=统一「软件/脚本/目录」+会话授权（无全局授权层）。 */
  merged.poolVersion = Number(raw.poolVersion) === 2 ? 2 : 1
  merged.dataDir = dataDirOf()
  return merged
}

/**
 * 归一化授权目录：去空、去重（大小写与尾部分隔符不敏感）、只保留绝对路径。
 *
 * 拒绝相对路径是刻意的：白名单要能表达"这台机器上的某个确切目录"，
 * 相对路径会随进程 cwd 漂移，既不可预期也没法做包含判断。
 */
export function normalizeAllowedDirs(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const text = String(item ?? '').trim()
    if (text === '') continue
    if (!isAbsolutePath(text)) continue
    const key = pathKey(text)
    if (seen.has(key)) continue
    seen.add(key)
    // 统一去掉尾部分隔符，但保留盘符根（"C:\" 不能变成 "C:"）
    out.push(stripTrailingSep(text))
  }
  return out
}

/** 是否绝对路径（兼容 Windows 盘符与 UNC）。 */
export function isAbsolutePath(p) {
  const text = String(p ?? '')
  return /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\/.test(text) || text.startsWith('/')
}

/** 比较用的归一化键：小写 + 正斜杠 + 去尾部分隔符。 */
export function pathKey(p) {
  const text = String(p ?? '').replace(/\//g, '\\')
  return stripTrailingSep(text).toLowerCase()
}

function stripTrailingSep(p) {
  const text = String(p ?? '')
  if (/^[a-zA-Z]:\\?$/.test(text)) return `${text[0]}:\\`
  return text.replace(/[\\/]+$/, '')
}

/**
 * 目标路径是否在任一授权目录之内（含目录本身）。
 *
 * 用**路径边界**比较而不是朴素 startsWith：`C:\Apps2` 不能被 `C:\Apps` 放行。
 * 这是浏览白名单与"打开文件"的唯一判据。
 */
export function isPathAllowed(target, allowedDirs) {
  const list = Array.isArray(allowedDirs) ? allowedDirs : []
  if (list.length === 0) return false
  const key = pathKey(target)
  if (key === '') return false
  for (const dir of list) {
    const base = pathKey(dir)
    if (base === '') continue
    if (key === base) return true
    const prefix = base.endsWith('\\') ? base : `${base}\\`
    if (key.startsWith(prefix)) return true
  }
  return false
}

/**
 * 某个程序自己的授权目录（去重）。
 *
 * poolVersion 2 起**不再有全局兜底**：授权目录跟着条目走，
 * 共享目录用 kind='directory' 的条目表达（同样要按会话授权）。
 * cfg 参数保留只为签名兼容，不再参与合并。
 */
export function effectiveAllowedDirs(cfg, program) {
  const own = Array.isArray(program?.allowedDirs) ? program.allowedDirs : []
  const seen = new Set()
  const out = []
  for (const dir of own) {
    const key = pathKey(dir)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(dir)
  }
  return out
}

function pickDefined(source) {
  const out = {}
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

/** 按 id 或 name（大小写不敏感）查找程序。 */
export function findProgram(programs, key) {
  const needle = String(key ?? '').trim().toLowerCase()
  if (needle === '') return null
  return (
    programs.find((item) => item.id.toLowerCase() === needle) ??
    programs.find((item) => item.name.toLowerCase() === needle) ??
    null
  )
}

export function createLogger(prefix, verbose = true) {
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
  return (message) => {
    if (!verbose && !/^(失败|拒绝|超时|错误|已启动|已停止)/.test(String(message))) return
    console.log(`${prefix} ${stamp()} ${message}`)
  }
}
