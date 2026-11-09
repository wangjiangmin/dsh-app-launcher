/**
 * dsh-app-launcher — 系统资源采样（CPU / 内存 / GPU / GPU 进程表）。
 *
 * 设计约束（沿用 dsh-ninfer-autostart 的教训）：本模块**只使用 node 内置模块**。
 * 插件装在 DSH profile 的 node_modules 下，那里没有 @deepseek-ai/* 官方包，
 * 任何裸包 import 都会在加载期失败。
 *
 * 所有采样函数**永不 reject**：任何失败（可执行文件缺失、超时、宿主禁止子进程
 * 导致 spawn EPERM、输出无法解析）都返回 null，由门控决定后续策略。
 */
import { execFile } from 'node:child_process'
import { cpus, freemem, totalmem } from 'node:os'

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

// ==================== GPU ====================

/**
 * 解析 `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`
 * 的一行：`20, 3306, 16303` → { utilPct: 20, usedMiB: 3306, totalMiB: 16303, freeMiB: 12997 }
 */
export function parseGpuCsv(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .find((item) => item.trim() !== '')
  if (!line) return null
  const [util, used, total] = line.split(',').map((item) => Number(item.trim()))
  if (![util, used, total].every((n) => Number.isFinite(n))) return null
  return { utilPct: util, usedMiB: used, totalMiB: total, freeMiB: total - used }
}

/**
 * 解析 GPU 名称 + 厂商（`nvidia-smi --query-gpu=name --format=csv,noheader` 或
 * `wmic path win32_VideoController get name`），返回第一个非空行。
 */
export function parseGpuName(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^Name$/i.test(line))
  return lines[0] ?? null
}

/**
 * 解析 `nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits`
 * 的输出，形如：
 *   25296, C:\...\LM Studio.exe, 3306
 * → [{ pid, name, usedMiB }]；标题行（含 "pid"）与空行跳过。
 *
 * **显存读不到的条目直接丢弃**：Windows 上很多桌面合成进程（explorer、msedge、
 * PowerToys…）也会出现在这张表里但给不出 used_memory，把它们当成"占 GPU 的进程"
 * 会污染摘要、并让 Agent 得出错误结论（实测踩到）。
 */
export function parseGpuProcesses(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(',').map((item) => item.trim())
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    if (!Number.isInteger(pid) || pid <= 0) continue // 标题行在这里被挡掉
    const usedMiB = Number(parts[parts.length - 1])
    if (!Number.isFinite(usedMiB)) continue // 显存读不到 → 不是真正的 GPU 使用者
    out.push({
      pid,
      name: parts.slice(1, parts.length - 1).join(', '),
      usedMiB,
    })
  }
  return out
}

/** 读 GPU 显存/利用率。读不到返回 null。 */
export function queryGpu(nvidiaSmi = 'nvidia-smi', log = () => {}) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    try {
      execFile(
        nvidiaSmi,
        ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
        { windowsHide: true, timeout: 10000 },
        (error, stdout) => {
          if (error) {
            log(`nvidia-smi 调用失败：${error.message}`)
            settle(null)
            return
          }
          const gpu = parseGpuCsv(stdout)
          if (!gpu) {
            log(`nvidia-smi 输出无法解析：${String(stdout).trim().slice(0, 120)}`)
            settle(null)
            return
          }
          settle(gpu)
        },
      )
    } catch (error) {
      log(`nvidia-smi 无法启动：${error instanceof Error ? error.message : String(error)}`)
      settle(null)
    }
  })
}

/** 读 GPU 型号名。读不到返回 null。 */
export async function queryGpuName(nvidiaSmi = 'nvidia-smi', log = () => {}) {
  const out = await execFileText(nvidiaSmi, ['--query-gpu=name', '--format=csv,noheader'], 10000)
  if (out === null) {
    log('读取 GPU 型号失败')
    return null
  }
  return parseGpuName(out)
}

/** 读"谁在吃显存"：GPU 上的计算进程表。读不到返回 null。 */
export async function queryGpuProcesses(nvidiaSmi = 'nvidia-smi', log = () => {}) {
  const out = await execFileText(
    nvidiaSmi,
    ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'],
    10000,
  )
  if (out === null) {
    log('读取 GPU 进程表失败')
    return null
  }
  return parseGpuProcesses(out)
}

// ==================== CPU / 内存 ====================

/**
 * 解析 `wmic cpu get loadpercentage /value` → `LoadPercentage=42`；
 * 或 Linux 的 `cat /proc/loadavg`（返回 null，交由 cpuLoadPct 走 fallback）。
 */
export function parseCpuLoad(text) {
  const matched = /LoadPercentage=(\d+)/i.exec(String(text ?? ''))
  if (matched) {
    const n = Number(matched[1])
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * CPU 占用率。优先 wmic（Windows 直接给百分比），失败则用 os.cpus() 采样差值。
 * 注意 os.cpus() 的 times 是**累计值**，两次采样间隔必须 > 0，否则差值为 0；
 * 这里固定等 250ms 再采第二次。
 */
export async function queryCpuLoad(log = () => {}) {
  if (process.platform === 'win32') {
    const out = await execFileText('wmic', ['cpu', 'get', 'loadpercentage', '/value'], 8000)
    const pct = out === null ? null : parseCpuLoad(out)
    if (pct !== null) return pct
    log('wmic 读 CPU 失败，退回 os.cpus() 采样')
  }
  const before = sampleTimes()
  await delay(250)
  const after = sampleTimes()
  return cpuLoadFromTimes(before, after)
}

function sampleTimes() {
  const list = cpus()
  let idle = 0
  let total = 0
  for (const cpu of list) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/** 纯函数：两次累计采样算占用率（便于单测）。 */
export function cpuLoadFromTimes(before, after) {
  if (!before || !after) return null
  const totalDelta = after.total - before.total
  const idleDelta = after.idle - before.idle
  if (!Number.isFinite(totalDelta) || totalDelta <= 0) return null
  const pct = (1 - idleDelta / totalDelta) * 100
  return Math.max(0, Math.min(100, Math.round(pct)))
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 内存总量/可用量（MiB）。永不失败（os 模块在进程内直读）。 */
export function memorySnapshot() {
  const totalMiB = Math.round(totalmem() / 1024 / 1024)
  const freeMiB = Math.round(freemem() / 1024 / 1024)
  return { totalMiB, freeMiB, usedMiB: totalMiB - freeMiB }
}

/**
 * 一次完整采样。deps 可注入，便于测试里替换掉真实命令。
 * 返回：
 * { at, gpu: {utilPct,usedMiB,totalMiB,freeMiB}|null, gpuName, gpuProcesses, cpu:{pct,cpus}, memory }
 */
export async function sampleSystem(deps = {}, log = () => {}) {
  const sampleGpu = deps.queryGpu ?? queryGpu
  const sampleName = deps.queryGpuName ?? queryGpuName
  const sampleProcs = deps.queryGpuProcesses ?? queryGpuProcesses
  const sampleCpu = deps.queryCpuLoad ?? queryCpuLoad
  const [gpu, gpuName, gpuProcesses, cpuPct] = await Promise.all([
    sampleGpu(deps.nvidiaSmi ?? 'nvidia-smi', log),
    sampleName(deps.nvidiaSmi ?? 'nvidia-smi', log),
    sampleProcs(deps.nvidiaSmi ?? 'nvidia-smi', log),
    sampleCpu(log),
  ])
  return {
    at: Date.now(),
    gpu,
    gpuName,
    gpuProcesses,
    cpu: { pct: cpuPct, cpus: cpus().length },
    memory: memorySnapshot(),
  }
}

/**
 * 带缓存的采样器（同一个插件实例共享一份，避免 Agent 连发 4 个 tool 就刷 8 次 nvidia-smi）。
 * `sample()` 返回缓存的快照；`invalidate()` 清缓存（启停之后必须调，否则读到旧读数）。
 */
export function createSampler({ cacheMs = 3000, nvidiaSmi = 'nvidia-smi', deps = {} } = {}, log = () => {}) {
  let cache = null
  let inflight = null
  return {
    async sample(force = false) {
      if (!force && cache && Date.now() - cache.at < cacheMs) return cache
      if (inflight) return inflight
      inflight = sampleSystem({ ...deps, nvidiaSmi }, log)
        .then((value) => {
          cache = value
          return value
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    },
    invalidate() {
      cache = null
    },
  }
}
