/**
 * dsh-app-launcher — 可持久化的配置存储。
 *
 * 两层来源：
 *  1. **patch 种子**：cordis.patch.yml 里 `programs` 的初始内容（只读，作为出厂默认）；
 *  2. **用户层**：$DSH_HOME/app-launcher/config.json（界面里增删改的全部结果）。
 *
 * 为什么不让界面直接写 cordis.patch.yml：那是 profile 的组合文件，改它要重启才生效、
 * 而且会和插件的版本升级相互覆盖。用户层独立成文件后，改完立刻生效（runtime 换配置、
 * tool 重新注册），也不会丢。
 *
 * 读取顺序：用户层存在 → 用用户层；不存在 → 用 patch 种子并落盘一次（养成接管）。
 * 用户点「重置」→ 删除用户层，回到 patch 种子。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { LAUNCHER_DEFAULTS, resolveConfig } from './config.mjs'

/** 用户层配置文件路径（与 patch 种子分离）。 */
export function configPath(dataDir) {
  return join(dataDir, 'config.json')
}

function readJson(path) {
  try {
    // 必须吃掉 BOM：用 PowerShell 5.1 的 Set-Content -Encoding UTF8 或记事本手改
    // 都会写入 EF BB BF，JSON.parse 会直接抛错。
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeJson(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    return true
  } catch {
    // 配置目录不可写（沙箱、只读卷、权限不足）：不能因此让整个开关/保存崩掉。
    // 返回 false，由上层告知"仅在内存生效，重启后丢失"。
    return false
  }
}

/**
 * 只取"可在界面里编辑的那部分"，避免把运行时派生字段（dataDir 等）写进文件。
 * programs 里的每个条目也剥掉派生字段。
 */
export function toPersistable(cfg) {
  return {
    enabled: cfg.enabled,
    conflictPolicy: cfg.conflictPolicy,
    unreadableGpuPolicy: cfg.unreadableGpuPolicy,
    sampleCacheMs: cfg.sampleCacheMs,
    readyTimeoutMs: cfg.readyTimeoutMs,
    nvidiaSmi: cfg.nvidiaSmi,
    dryRun: cfg.dryRun,
    verbose: cfg.verbose,
    allowedDirs: (cfg.allowedDirs ?? []).slice(),
    programs: (cfg.programs ?? []).map(programToPersistable),
  }
}

export function programToPersistable(program) {
  return {
    id: program.id,
    name: program.name,
    enabled: program.enabled,
    description: program.description,
    launch: {
      exe: program.launch?.exe ?? '',
      args: program.launch?.args ?? [],
      cwd: program.launch?.cwd ?? '',
      env: program.launch?.env ?? {},
      prependCwdToPath: program.launch?.prependCwdToPath !== false,
    },
    // 授权目录跟着程序走，必须一起落盘（漏了它，重启后每个程序都没有授权目录）
    allowedDirs: (program.allowedDirs ?? []).slice(),
    needs: program.needs ?? {},
    exclusive: program.exclusive ?? '',
    ready: {
      url: program.ready?.url ?? '',
      timeoutMs: program.ready?.timeoutMs ?? LAUNCHER_DEFAULTS.readyTimeoutMs,
      intervalMs: program.ready?.intervalMs ?? 1000,
    },
    stopTimeoutMs: program.stopTimeoutMs ?? 20000,
  }
}

/**
 * 配置存储。构造时只读一次种子；之后 load()/save() 都走用户层。
 *
 * @param {object} options { seed: 来自 patch 的原始 config, dataDir }
 */
export function createConfigStore({ seed = {}, dataDir }) {
  const path = configPath(dataDir)
  let cached = null

  function seedRaw() {
    return toPersistable(resolveConfig(seed))
  }

  return {
    path,
    /** 当前生效的原始配置（未归一化，交给 resolveConfig 处理）。 */
    load() {
      if (cached) return cached
      const stored = readJson(path)
      if (stored) {
        cached = stored
        return cached
      }
      // 首次运行：把 patch 种子落成用户层，从此界面拥有完整的一份。
      const initial = seedRaw()
      writeJson(path, initial)
      cached = initial
      return cached
    },
    /** 整体替换并落盘（界面保存时调用）。 */
    save(raw) {
      const next = toPersistable(resolveConfig({ ...seed, ...raw }))
      const persisted = writeJson(path, next)
      cached = next
      this.lastPersisted = persisted
      return next
    },
    /** 删除用户层，回到 patch 种子。 */
    reset() {
      try {
        rmSync(path, { force: true })
      } catch {
        /* 文件不存在不影响结果 */
      }
      cached = null
      return this.load()
    },
    /** 是否在用用户层（false = 还没被界面改过）。 */
    hasUserLayer() {
      return readJson(path) !== null
    },
  }
}
