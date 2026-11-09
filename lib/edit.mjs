/**
 * dsh-app-launcher — 配置编辑与校验（**纯函数**，便于单测）。
 *
 * 界面里所有"增 / 改 / 删"都先过这里的校验，再交给 store 落盘：
 * 坏条目在保存前就被拒绝，并明确告诉用户哪里错了，而不是存进去以后
 * 变成一条启动不了的死配置。
 */
import { statSync } from 'node:fs'
import { findProgram, isAbsolutePath, normalizeAllowedDirs, normalizeProgram } from './config.mjs'

/** 校验失败时的错误类型，便于 HTTP 层区分 400 与 500。 */
export class ConfigValidationError extends Error {
  constructor(message, field = null) {
    super(message)
    this.name = 'ConfigValidationError'
    this.field = field
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

/**
 * 从程序名派生一个 id。
 *
 * 只用 ASCII 派生会遇到中文名（"我的脚本" 全被清空 → 退化成 `app`，多个中文条目
 * 就会 app / app-2 / app-3，对用户毫无可读性）。所以：
 *  - 能派生出发音无关的 ASCII 段就用它（ComfyUI → comfyui）；
 *  - 全非 ASCII（中文/日文等）→ 用 `program-N`，编号可预期、不与已有 id 冲突。
 * 用户随时可以在表单里手填 id 覆盖这个默认值。
 */
export function deriveId(name, existing = []) {
  const taken = new Set(existing)
  const ascii = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

  if (ascii !== '') {
    if (!taken.has(ascii)) return ascii
    for (let i = 2; i < 1000; i += 1) {
      const next = `${ascii}-${i}`
      if (!taken.has(next)) return next
    }
    throw new ConfigValidationError('无法为这个名称派生唯一 id，请手动填写 id')
  }

  // 名字里没有可用 ASCII：按 program-N 递增编号。
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `program-${i}`
    if (!taken.has(candidate)) return candidate
  }
  throw new ConfigValidationError('无法为这个名称派生唯一 id，请手动填写 id')
}

/**
 * 校验一个条目（新增或修改后）。
 * 返回归一化后的条目；不合法则抛 ConfigValidationError。
 */
export function validateProgram(raw, { existing = [], allowSameId = null } = {}) {
  if (!raw || typeof raw !== 'object') throw new ConfigValidationError('条目必须是一个对象')

  const name = String(raw.name ?? '').trim()
  if (name === '') throw new ConfigValidationError('请填写「名称」', 'name')

  let id = String(raw.id ?? '').trim()
  if (id === '') {
    id = deriveId(name, existing.filter((item) => item !== allowSameId))
  } else {
    if (!ID_PATTERN.test(id)) {
      throw new ConfigValidationError('id 只能包含字母、数字、点、下划线和短横线', 'id')
    }
    const taken = existing.filter((item) => item !== allowSameId)
    if (taken.includes(id)) throw new ConfigValidationError(`id「${id}」已被占用，请换一个`, 'id')
  }

  const exe = String(raw.launch?.exe ?? '').trim()
  if (exe === '') throw new ConfigValidationError('请填写「启动路径」', 'launch.exe')

  const timeoutMs = Number(raw.ready?.timeoutMs)
  if (raw.ready?.timeoutMs !== undefined && raw.ready?.timeoutMs !== '' && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new ConfigValidationError('就绪超时必须是正数（毫秒）', 'ready.timeoutMs')
  }

  const url = String(raw.ready?.url ?? '').trim()
  if (url !== '') {
    let parsed = null
    try {
      parsed = new URL(url)
    } catch {
      throw new ConfigValidationError('就绪探针地址必须是完整 URL，例如 http://127.0.0.1:8188/system_stats', 'ready.url')
    }
    if (!/^http(s)?:/.test(parsed.protocol)) {
      throw new ConfigValidationError('就绪探针地址必须是 http:// 或 https://', 'ready.url')
    }
  }

  const needs = raw.needs ?? {}
  for (const [key, label] of [
    ['gpuUtilPctMax', 'GPU 利用率上限'],
    ['freeVramMiBMin', '空闲显存下限'],
    ['freeRamMiBMin', '空闲内存下限'],
    ['cpuPctMax', 'CPU 占用上限'],
  ]) {
    const value = needs[key]
    if (value === undefined || value === null || value === '') continue
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) {
      throw new ConfigValidationError(`「${label}」必须是非负数（留空 = 不限制）`, `needs.${key}`)
    }
  }

  const normalized = normalizeProgram({ ...raw, id, name }, 0)
  return normalized
}

/**
 * 保存时的路径检查（你要求的「手工填写 + 保存时验证」）。
 *
 * 不阻止跨目录填写（用户本来就要手填），只保证：
 *  - 启动路径是绝对路径；
 *  - 启动路径**确实存在**且不是目录；
 *  - 工作目录若填了，确实存在且是目录。
 *
 * 「不存在」是硬错误：写进配置只会变成一条启动不了的死条目。
 * 但**验证的是"现在存在"**——程序将来被移动，报错信息会指明具体路径。
 *
 * @param {object} program 归一化后的程序条目
 * @param {object} [options]
 * @param {(p: string) => {exists: boolean, isDirectory: boolean|null}} [options.probe]
 */
export function validateProgramPaths(program, options = {}) {
  const probe = options.probe ?? defaultPathProbe()
  const exe = String(program?.launch?.exe ?? '').trim()
  if (exe === '') return // 缺 exe 由 valid/invalidReason 处理，这里不重复报

  if (!isAbsolutePath(exe)) {
    throw new ConfigValidationError(`启动路径必须是绝对路径：${exe}`, 'launch.exe')
  }
  const exeInfo = probe(exe)
  if (!exeInfo.exists) {
    throw new ConfigValidationError(`启动路径不存在：${exe}`, 'launch.exe')
  }
  if (exeInfo.isDirectory) {
    throw new ConfigValidationError(`启动路径是目录而不是文件：${exe}`, 'launch.exe')
  }

  // 工作目录：只校验**用户显式填写**的那个。
  // 没填时 normalizeProgram 会用 exe 所在目录推导一个，那是随 exe 走的派生值，
  // 不该拿来做"这个目录是否合法"的判定（否则填 C:/a.exe 会报 C:/ 不是目录）。
  const cwd = String(program?.launch?.cwd ?? '').trim()
  const cwdExplicit = program?.launch?.cwdExplicit !== false && cwd !== ''
  if (cwdExplicit) {
    if (!isAbsolutePath(cwd)) {
      throw new ConfigValidationError(`工作目录必须是绝对路径：${cwd}`, 'launch.cwd')
    }
    const cwdInfo = probe(cwd)
    if (!cwdInfo.exists) {
      throw new ConfigValidationError(`工作目录不存在：${cwd}`, 'launch.cwd')
    }
    if (cwdInfo.isDirectory === false) {
      throw new ConfigValidationError(`工作目录是文件而不是目录：${cwd}`, 'launch.cwd')
    }
  }

  // 程序自己的授权目录：必须是绝对路径（不要求存在，允许预授权将来才建的目录）
  for (const dir of program?.allowedDirs ?? []) {
    if (!isAbsolutePath(dir)) {
      throw new ConfigValidationError(`授权目录必须是绝对路径：${dir}`, 'allowedDirs')
    }
  }
}

/** 默认的路径探测（同步 stat，一次只探几个路径，开销可忽略）。 */
function defaultPathProbe() {
  return (p) => {
    try {
      const st = statSync(p)
      return { exists: true, isDirectory: st.isDirectory() }
    } catch {
      return { exists: false, isDirectory: null }
    }
  }
}

/** 读当前原始配置的 programs 数组（保持未归一化，供编辑使用）。 */
function rawPrograms(rawConfig) {
  return Array.isArray(rawConfig?.programs) ? rawConfig.programs.slice() : []
}

/**
 * 新增一个条目。
 * @returns {{ config: object, program: object }}
 */
export function addProgram(rawConfig, entry, options = {}) {
  const programs = rawPrograms(rawConfig)
  const submitted = normalizeSubmittedEntry(entry)
  const normalized = validateProgram(submitted, { existing: programs.map((item) => String(item.id ?? '').trim()) })
  // 保存时验证路径（手工填写模式下这是唯一一道防线）
  validateProgramPaths(normalized, options)
  return {
    config: { ...rawConfig, programs: [...programs, entryWithId(submitted, normalized.id)] },
    program: normalized,
  }
}

/**
 * 修改一个条目（按原 id 定位；允许同时改 id）。
 * @returns {{ config: object, program: object, previousId: string }}
 */
export function updateProgram(rawConfig, id, entry, options = {}) {
  const programs = rawPrograms(rawConfig)
  const index = programs.findIndex((item) => String(item.id ?? '').trim() === id)
  if (index < 0) throw new ConfigValidationError(`找不到条目「${id}」`, 'id')

  const submitted = normalizeSubmittedEntry(entry)
  const normalized = validateProgram(submitted, {
    existing: programs.map((item) => String(item.id ?? '').trim()),
    allowSameId: id,
  })
  validateProgramPaths(normalized, options)
  const next = programs.slice()
  next[index] = entryWithId(submitted, normalized.id)
  return { config: { ...rawConfig, programs: next }, program: normalized, previousId: id }
}

/** 删除一个条目。 */
export function removeProgram(rawConfig, id) {
  const programs = rawPrograms(rawConfig)
  const exists = programs.some((item) => String(item.id ?? '').trim() === id)
  if (!exists) throw new ConfigValidationError(`找不到条目「${id}」`, 'id')
  return { config: { ...rawConfig, programs: programs.filter((item) => String(item.id ?? '').trim() !== id) } }
}

/** 写回时带上已确定的 id（用户没填 id 时由 deriveId 生成）。 */
function entryWithId(entry, id) {
  return { ...entry, id }
}

/**
 * 全局开关 / 插件级策略修改。只接受白名单字段，避免界面误写运行时字段。
 * @returns {object} 新配置
 */
export function updateGlobal(rawConfig, patch = {}) {
  const next = { ...rawConfig }
  const allowed = [
    'enabled', 'conflictPolicy', 'unreadableGpuPolicy', 'sampleCacheMs',
    'readyTimeoutMs', 'nvidiaSmi', 'dryRun', 'verbose', 'allowedDirs',
  ]
  for (const key of allowed) {
    const value = patch[key]
    if (value === undefined) continue
    next[key] = value
  }
  if (patch.allowedDirs !== undefined) {
    if (!Array.isArray(patch.allowedDirs)) {
      throw new ConfigValidationError('授权目录必须是数组', 'allowedDirs')
    }
    // 只收绝对路径；相对路径会让白名单随进程 cwd 漂移，无法做包含判断
    for (const dir of patch.allowedDirs) {
      const text = String(dir ?? '').trim()
      if (text === '') continue
      if (!isAbsolutePath(text)) {
        throw new ConfigValidationError(`授权目录必须是绝对路径：${text}`, 'allowedDirs')
      }
    }
    next.allowedDirs = normalizeAllowedDirs(patch.allowedDirs)
  }
  if (patch.conflictPolicy !== undefined && !['reject', 'stop-own'].includes(String(patch.conflictPolicy))) {
    throw new ConfigValidationError('冲突策略只能是 reject 或 stop-own', 'conflictPolicy')
  }
  if (patch.unreadableGpuPolicy !== undefined && !['reject', 'allow'].includes(String(patch.unreadableGpuPolicy))) {
    throw new ConfigValidationError('读不到 GPU 的策略只能是 reject 或 allow', 'unreadableGpuPolicy')
  }
  return next
}

/** 供界面展示的"可编辑视图"：把归一化条目摊平成表单友好结构。 */
export function toFormProgram(program) {
  return {
    id: program.id,
    name: program.name,
    enabled: program.enabled,
    description: program.description,
    exe: program.launch?.exe ?? '',
    args: (program.launch?.args ?? []).join(' '),
    cwd: program.launch?.cwd ?? '',
    envText: Object.entries(program.launch?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    needs: {
      gpuUtilPctMax: program.needs?.gpuUtilPctMax ?? '',
      freeVramMiBMin: program.needs?.freeVramMiBMin ?? '',
      freeRamMiBMin: program.needs?.freeRamMiBMin ?? '',
      cpuPctMax: program.needs?.cpuPctMax ?? '',
    },
    exclusive: program.exclusive ?? '',
    readyUrl: program.ready?.url ?? '',
    readyTimeoutMs: program.ready?.timeoutMs ?? '',
    stopTimeoutMs: program.stopTimeoutMs ?? '',
    valid: program.valid,
    invalidReason: program.invalidReason,
  }
}

/** 把表单结构还原成配置条目（保存时用）。 */
export function fromFormProgram(form = {}) {
  return {
    id: String(form.id ?? '').trim(),
    name: String(form.name ?? '').trim(),
    enabled: form.enabled !== false,
    description: String(form.description ?? '').trim(),
    launch: {
      exe: String(form.exe ?? '').trim(),
      args: splitArgs(form.args),
      cwd: String(form.cwd ?? '').trim(),
      env: parseEnvText(form.envText),
    },
    needs: {
      gpuUtilPctMax: blankToUndefined(form.needs?.gpuUtilPctMax),
      freeVramMiBMin: blankToUndefined(form.needs?.freeVramMiBMin),
      freeRamMiBMin: blankToUndefined(form.needs?.freeRamMiBMin),
      cpuPctMax: blankToUndefined(form.needs?.cpuPctMax),
    },
    exclusive: String(form.exclusive ?? '').trim(),
    ready: {
      url: String(form.readyUrl ?? '').trim(),
      timeoutMs: blankToUndefined(form.readyTimeoutMs),
      intervalMs: 1000,
    },
    stopTimeoutMs: blankToUndefined(form.stopTimeoutMs),
  }
}

/**
 * 把客户端提交的"扁平行形态"归一成配置条目。
 *
 * 客户端为了简单，把参数与环境变量都以**原始文本**提交（`launch.args` 是字符串、
 * `launch.env` 是 `KEY=VALUE` 多行文本），由这里统一解析：
 * 这样 splitArgs / parseEnvText 的规则只有一份，不会客户端宿主各写一遍还写不一致。
 */
export function normalizeSubmittedEntry(entry = {}) {
  const launch = entry.launch ?? {}
  const ready = entry.ready ?? {}

  // 已经是数组/对象 → 直接用；是字符串 → 解析。
  const args = Array.isArray(launch.args)
    ? launch.args.map((item) => String(item))
    : splitArgs(launch.args)

  const env = typeof launch.env === 'string'
    ? parseEnvText(launch.env)
    : (launch.env && typeof launch.env === 'object' ? launch.env : {})

  return {
    id: String(entry.id ?? '').trim(),
    name: String(entry.name ?? '').trim(),
    enabled: entry.enabled !== false,
    description: String(entry.description ?? '').trim(),
    launch: {
      exe: String(launch.exe ?? '').trim(),
      args,
      cwd: String(launch.cwd ?? '').trim(),
      env: normalizeEnvValues(env),
    },
    // 授权目录跟着程序走：客户端提交数组或换行文本都接受
    allowedDirs: Array.isArray(entry.allowedDirs)
      ? entry.allowedDirs.map((d) => String(d ?? '').trim()).filter((d) => d !== '')
      : String(entry.allowedDirs ?? '').split(/\r?\n/).map((d) => d.trim()).filter((d) => d !== ''),
    needs: entry.needs ?? {},
    exclusive: String(entry.exclusive ?? '').trim(),
    ready: {
      url: String(ready.url ?? '').trim(),
      timeoutMs: normalizeOptionalNumber(ready.timeoutMs),
      intervalMs: normalizeOptionalNumber(ready.intervalMs) ?? 1000,
    },
    stopTimeoutMs: normalizeOptionalNumber(entry.stopTimeoutMs),
  }
}

function normalizeEnvValues(env) {
  const out = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined || value === null) continue
    out[String(key)] = String(value)
  }
  return out
}

function normalizeOptionalNumber(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (text === '') return undefined
  const n = Number(text)
  return Number.isFinite(n) ? n : text
}

function blankToUndefined(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text === '' ? undefined : Number(text)
}

/**
 * 参数串解析。支持引号（含 Windows 路径里的空格），不做 shell 展开。
 * `--port 8188 --extra-model-paths "D:\\models"` → ['--port','8188','--extra-model-paths','D:\\models']
 */
export function splitArgs(text) {
  const input = String(text ?? '')
  const out = []
  let buffer = ''
  let quote = null
  let started = false
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        buffer += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started || buffer !== '') {
        out.push(buffer)
        buffer = ''
        started = false
      }
      continue
    }
    buffer += ch
    started = true
  }
  if (started || buffer !== '') out.push(buffer)
  return out
}

/** `KEY=VALUE` 多行文本 → 环境变量对象；非法行忽略。 */
export function parseEnvText(text) {
  const out = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key !== '') out[key] = value
  }
  return out
}

export { findProgram }
