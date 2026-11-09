/**
 * dsh-app-launcher — 门控判定（**纯函数**，全部可单测，不碰进程与网络）。
 *
 * 目标：Agent 想启动某个本地软件之前，先判断"这台机器现在有没有空"。
 * 判定输入：一次系统采样（sysinfo.sampleSystem 的结果）+ 目标程序的 needs 阈值
 * + 同族互斥组里其它程序的在线情况。
 * 输出带**具体读数**，让 Agent 能自己下结论，
 * 例如"GPU 利用率 87% ≥ 阈值 10%，等当前任务结束"。
 */

/** 数值对人的展示：MiB → "8.0 GiB" / "512 MiB"。 */
export function formatMiB(mib) {
  // 注意 Number(null) === 0、Number('') === 0，不能用 isFinite 兜底。
  if (mib === null || mib === undefined || mib === '') return '未知'
  const n = Number(mib)
  if (!Number.isFinite(n)) return '未知'
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GiB`
  return `${Math.round(n)} MiB`
}

/**
 * 归一化 needs 阈值。全部字段可选；未配置 = 不参与判定。
 * - gpuUtilPctMax      GPU 利用率上限（>= 即拒绝）
 * - freeVramMiBMin     空闲显存下限
 * - freeRamMiBMin      空闲内存下限
 * - cpuPctMax          CPU 占用上限
 */
export function normalizeNeeds(raw = {}) {
  const num = (value) => {
    if (value === undefined || value === null || value === '') return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return {
    gpuUtilPctMax: num(raw.gpuUtilPctMax),
    freeVramMiBMin: num(raw.freeVramMiBMin),
    freeRamMiBMin: num(raw.freeRamMiBMin),
    cpuPctMax: num(raw.cpuPctMax),
  }
}

function check(name, required, actual, pass, message) {
  return { name, required, actual, pass, message }
}

/**
 * 单个程序的资源门控判定。
 *
 * @param {object} sample  sampleSystem() 的返回值（gpu 可为 null）
 * @param {object} needs   normalizeNeeds() 的返回值
 * @param {object} [opts]
 * @param {'reject'|'allow'} [opts.unreadableGpuPolicy='reject']  读不到 GPU 时的策略
 * @returns {{ok:boolean, checks:Array, failed:Array, gpu:object|null, reason:string|null}}
 */
export function evaluateResourceGate(sample, needs, opts = {}) {
  const policy = String(opts.unreadableGpuPolicy ?? 'reject')
  const normalized = normalizeNeeds(needs)
  const checks = []

  // ---- GPU 利用率 ----
  if (normalized.gpuUtilPctMax !== null) {
    if (!sample?.gpu) {
      checks.push(check(
        'gpu-util',
        normalized.gpuUtilPctMax,
        null,
        policy === 'allow',
        policy === 'allow'
          ? '读不到 GPU 状态，按 unreadableGpuPolicy=allow 放行'
          : '读不到 GPU 状态（nvidia-smi 不可用）',
      ))
    } else {
      const util = sample.gpu.utilPct
      checks.push(check(
        'gpu-util',
        normalized.gpuUtilPctMax,
        util,
        util < normalized.gpuUtilPctMax,
        `GPU 利用率 ${util}% ${util < normalized.gpuUtilPctMax ? '<' : '≥'} 阈值 ${normalized.gpuUtilPctMax}%`,
      ))
    }
  }

  // ---- 空闲显存 ----
  if (normalized.freeVramMiBMin !== null) {
    if (!sample?.gpu) {
      checks.push(check(
        'free-vram',
        normalized.freeVramMiBMin,
        null,
        policy === 'allow',
        policy === 'allow'
          ? '读不到 GPU 状态，按 unreadableGpuPolicy=allow 放行'
          : '读不到 GPU 显存状态（nvidia-smi 不可用）',
      ))
    } else {
      const free = sample.gpu.freeMiB
      checks.push(check(
        'free-vram',
        normalized.freeVramMiBMin,
        free,
        free >= normalized.freeVramMiBMin,
        `空闲显存 ${formatMiB(free)}（共 ${formatMiB(sample.gpu.totalMiB)}）${free >= normalized.freeVramMiBMin ? '≥' : '<'} 需要 ${formatMiB(normalized.freeVramMiBMin)}`,
      ))
    }
  }

  // ---- 空闲内存 ----
  if (normalized.freeRamMiBMin !== null) {
    const free = sample?.memory?.freeMiB ?? null
    const total = sample?.memory?.totalMiB ?? null
    if (free === null) {
      checks.push(check('free-ram', normalized.freeRamMiBMin, null, false, '读不到内存状态'))
    } else {
      checks.push(check(
        'free-ram',
        normalized.freeRamMiBMin,
        free,
        free >= normalized.freeRamMiBMin,
        `空闲内存 ${formatMiB(free)}（共 ${formatMiB(total)}）${free >= normalized.freeRamMiBMin ? '≥' : '<'} 需要 ${formatMiB(normalized.freeRamMiBMin)}`,
      ))
    }
  }

  // ---- CPU 占用 ----
  if (normalized.cpuPctMax !== null) {
    const pct = sample?.cpu?.pct ?? null
    if (pct === null) {
      checks.push(check('cpu-load', normalized.cpuPctMax, null, false, '读不到 CPU 占用率'))
    } else {
      checks.push(check(
        'cpu-load',
        normalized.cpuPctMax,
        pct,
        pct < normalized.cpuPctMax,
        `CPU 占用 ${pct}% ${pct < normalized.cpuPctMax ? '<' : '≥'} 阈值 ${normalized.cpuPctMax}%`,
      ))
    }
  }

  const failed = checks.filter((item) => !item.pass)
  const ok = failed.length === 0
  return {
    ok,
    checks,
    failed,
    gpu: sample?.gpu ?? null,
    reason: ok ? null : failed.map((item) => item.message).join('；'),
  }
}

/**
 * 同族互斥判定：`exclusive` 组内最多一个程序在跑。
 *
 * @param {string} targetId        要启动的程序 id
 * @param {string} exclusiveGroup  目标程序的互斥组（空 = 不互斥）
 * @param {Array<{id,name,exclusive,running,canStop}>} runningPrograms  当前在线/启动中的程序
 * @param {'reject'|'stop-own'} [conflictPolicy='reject']
 *   - reject   ：只拒绝 + 给建议（默认，绝不杀别人的进程）
 *   - stop-own ：允许先停掉**本插件启动的**冲突程序（外部启动的仍拒绝）
 * @returns {{ok:boolean, conflict:object|null, reason:string|null, suggestions:string[], stopFirst?:string[]}}
 */
export function evaluateConflict(targetId, exclusiveGroup, runningPrograms, conflictPolicy = 'reject') {
  const group = String(exclusiveGroup ?? '').trim()
  if (group === '') return { ok: true, conflict: null, reason: null, suggestions: [] }

  const others = (runningPrograms ?? []).filter(
    (item) => item && item.id !== targetId && String(item.exclusive ?? '').trim() === group && item.running,
  )
  if (others.length === 0) return { ok: true, conflict: null, reason: null, suggestions: [] }

  const names = others.map((item) => item.name || item.id).join('、')
  const base = {
    conflict: others[0],
    conflicts: others,
    reason: `同族互斥组「${group}」已有 ${names} 在运行`,
  }

  if (conflictPolicy === 'stop-own') {
    const blockers = others.filter((item) => !item.canStop)
    if (blockers.length === 0) {
      return {
        ok: true,
        ...base,
        reason: null,
        suggestions: [],
        stopFirst: others.map((item) => item.id),
      }
    }
    return {
      ok: false,
      ...base,
      reason: `${base.reason}，且其中 ${blockers.map((item) => item.name || item.id).join('、')} 不是本插件启动的，拒绝代停`,
      suggestions: [`先手动停止 ${blockers.map((item) => item.name || item.id).join('、')}`, `或改用不与「${group}」互斥的程序`],
    }
  }

  return {
    ok: false,
    ...base,
    suggestions: [
      `先停止 ${names} 再启动本程序`,
      '或等它跑完（可先调用 system_status 观察 GPU 回落）',
      '或改用不需要独占 GPU 的程序',
    ],
  }
}

/**
 * 汇总一次启动判定的全部结论（资源门控 + 互斥 + 已在线短路）。
 * 这是 tool `app_start` 唯一调用的判定入口，保持纯函数便于回归测试。
 *
 * @returns {{
 *   action: 'already-running'|'reject'|'start',
 *   ok: boolean,
 *   reason: string|null,
 *   resourceGate: object|null,
 *   conflict: object|null,
 *   suggestions: string[],
 *   stopFirst: string[],
 * }}
 */
export function decideStart({ target, sample, runningPrograms = [], unreadableGpuPolicy = 'reject', conflictPolicy = 'reject', online = false }) {
  if (online) {
    return {
      action: 'already-running',
      ok: true,
      reason: null,
      resourceGate: null,
      conflict: null,
      suggestions: [],
      stopFirst: [],
    }
  }

  const resourceGate = evaluateResourceGate(sample, target?.needs ?? {}, { unreadableGpuPolicy })
  const conflict = evaluateConflict(target?.id, target?.exclusive, runningPrograms, conflictPolicy)
  const suggestions = [...(conflict.suggestions ?? [])]

  if (!resourceGate.ok && resourceGate.gpu && resourceGate.gpu.utilPct >= 50) {
    const holders = (sample?.gpuProcesses ?? []).map(
      (item) => `${item.name}(PID ${item.pid}, ${item.usedMiB}MiB)`,
    )
    if (holders.length > 0) suggestions.push(`当前占用 GPU 的进程：${holders.join('、')}`)
  }
  if (!resourceGate.ok && resourceGate.checks.some((item) => item.name === 'free-ram')) {
    suggestions.push('可先关闭其它吃内存的程序，或选一个 freeRamMiBMin 更低的程序')
  }
  // 兜底：资源不满足却一条建议都没有时，别让 Agent 干等。
  if (!resourceGate.ok && suggestions.length === 0) {
    const names = resourceGate.failed.map((item) => item.name).join('、')
    suggestions.push(`当前资源不满足（${names}），可稍后重试并先用 system_status 观察是否回落`)
    if (resourceGate.gpu) {
      suggestions.push('或改选一个资源需求更低的程序（见 app_list 的 needs 字段）')
    } else {
      suggestions.push('若确认 GPU 空闲但 nvidia-smi 不可用，可把 unreadableGpuPolicy 设为 allow')
    }
  }

  if (!resourceGate.ok || !conflict.ok) {
    const reasons = [resourceGate.reason, conflict.reason].filter(Boolean)
    return {
      action: 'reject',
      ok: false,
      reason: reasons.join('；'),
      resourceGate,
      conflict,
      suggestions,
      stopFirst: conflict?.stopFirst ?? [],
    }
  }

  return {
    action: 'start',
    ok: true,
    reason: null,
    resourceGate,
    conflict,
    suggestions,
    stopFirst: conflict?.stopFirst ?? [],
  }
}
