/**
 * dsh-app-launcher — 状态快照（tool 与设置页共用一份数据结构）。
 *
 * 聚合：系统采样 + 每个程序的门控结论 + 运行状态 + 进程归属 + 日志尾部。
 * 只依赖 node 内置模块。
 */
import { decideStart } from './gate.mjs'
import { listeningPids, ownershipOf, portOf, probeReady, readLogTail, readState } from './programs.mjs'

/**
 * 每个程序的阶段：
 * - ready    ：就绪探针通过
 * - starting ：有启动流程在跑，或端口已监听但服务未 ready
 * - failed   ：本会话记录到退出
 * - stopped  ：以上都不是
 */
function phaseOf({ online, processUp, state }) {
  if (online) return 'ready'
  if (state?.starting) return 'starting'
  if (processUp) return 'starting'
  if (state?.lastExit) return 'failed'
  return 'stopped'
}

/**
 * 构造一份完整快照。deps 可注入（测试不必真的碰 GPU / 网络）。
 *
 * @param {object} cfg       resolveConfig 的结果
 * @param {object} registry  programs.createRegistry() 的返回值
 * @param {object} sampler   sysinfo.createSampler() 的返回值
 * @param {object} options   { log, deps, fresh }
 */
export async function statusSnapshot(cfg, registry, sampler, { log = () => {}, deps = {}, fresh = false } = {}) {
  const probe = deps.probeReady ?? probeReady
  const listPids = deps.listeningPids ?? listeningPids
  const resolveOwnership = deps.ownershipOf ?? ownershipOf

  const sample = await sampler.sample(fresh)

  const programs = await Promise.all(
    (cfg.programs ?? []).map(async (program) => {
      const state = registry.stateOf(program.id)
      // 只对启用且配置完整的程序做探针与端口查询，避免无效配置拖慢设置页。
      const probeResult = program.valid ? await probe(program, log) : { ready: false, byProcess: false, status: null }

      const pids = program.valid ? await listPids(program, log, deps) : null
      const processUp = Array.isArray(pids) && pids.length > 0

      // 有 HTTP 探针的程序以探针为准；没有探针的 GUI 程序（Blender 等）
      // 只能以"进程是否存在"判定在线——否则它既不会 ready 也不会被识别。
      const online = probeResult.byProcess ? processUp : Boolean(probeResult.ready)

      state.online = online
      if (online) state.lastReadyAt = state.lastReadyAt || Date.now()
      state.probeStatus = probeResult.status

      const ownership = processUp ? await resolveOwnership(program, state, pids, deps) : null
      const remembered = readState(program)
      const running = online

      return {
        id: program.id,
        name: program.name,
        enabled: program.enabled,
        valid: program.valid,
        invalidReason: program.invalidReason,
        /** false = 只能手动启动（插件不代拉），界面据此禁用启动按钮。 */
        launchable: program.launchable !== false,
        launchHint: program.launchHint ?? '',
        description: program.description,
        exclusive: program.exclusive,
        needs: program.needs,
        launch: {
          exe: program.launch.exe,
          args: program.launch.args,
          cwd: program.launch.cwd,
          envKeys: Object.keys(program.launch.env),
        },
        ready: { url: program.ready.url, timeoutMs: program.ready.timeoutMs, port: portOf(program) },
        running,
        phase: phaseOf({ online, processUp, state }),
        online,
        byProcess: Boolean(probeResult.byProcess),
        probeStatus: probeResult.status,
        pid: processUp ? pids[0] : (state?.child?.pid ?? null),
        pids: Array.isArray(pids) ? pids : null,
        ownedByPlugin: ownership ? ownership.owned : false,
        canStop: Boolean(ownership?.owned),
        stopBlockedReason: ownership && !ownership.owned ? ownership.reason : null,
        rememberedPid: remembered?.pid ?? null,
        startedAt: state?.startedAt || null,
        lastReadyAt: state?.lastReadyAt || null,
        lastStopAt: state?.lastStopAt || null,
        lastExit: state?.lastExit ?? null,
        starting: Boolean(state?.starting),
        logPath: program.logFile,
      }
    }),
  )

  // 每个程序各自的门控结论：用同一份采样，判断"现在能不能起它"。
  const runningPrograms = programs.map((item) => ({
    id: item.id,
    name: item.name,
    exclusive: item.exclusive,
    running: item.running,
    canStop: item.canStop,
  }))
  const gates = {}
  for (const program of cfg.programs ?? []) {
    const self = programs.find((item) => item.id === program.id)
    gates[program.id] = decideStart({
      target: program,
      sample,
      runningPrograms,
      unreadableGpuPolicy: cfg.unreadableGpuPolicy,
      conflictPolicy: cfg.conflictPolicy,
      online: Boolean(self?.online),
    })
  }

  // GPU 进程表里哪些是本插件管理的程序的进程
  const gpuHolders = (sample?.gpuProcesses ?? []).map((holder) => {
    const owner = programs.find((item) => item.pid !== null && item.pid === holder.pid)
    return {
      pid: holder.pid,
      name: holder.name,
      usedMiB: holder.usedMiB,
      ownerId: owner?.id ?? null,
    }
  })

  const heavyInUse = programs
    .filter((item) => item.running && String(item.exclusive ?? '') !== '')
    .map((item) => item.id)

  return {
    plugin: {
      name: 'dsh-app-launcher',
      enabled: cfg.enabled,
      dryRun: cfg.dryRun,
      conflictPolicy: cfg.conflictPolicy,
      unreadableGpuPolicy: cfg.unreadableGpuPolicy,
      programCount: programs.length,
      enabledCount: programs.filter((item) => item.enabled).length,
    },
    system: {
      at: sample.at,
      cpu: sample.cpu,
      memory: sample.memory,
      gpu: sample.gpu
        ? { ...sample.gpu, name: sample.gpuName, available: true }
        : { available: false, name: sample.gpuName, reason: 'nvidia-smi 读不到状态' },
      gpuProcesses: sample.gpuProcesses,
      gpuHolders,
      heavyInUse,
    },
    programs,
    gates,
    logs: Object.fromEntries(
      (cfg.programs ?? []).map((program) => {
        const tail = readLogTail(program, cfg.logTailLines)
        return [
          program.id,
          tail
            ? { path: program.logFile, tail: tail.tail, size: tail.size, mtime: tail.mtime }
            : { path: program.logFile, tail: [], size: 0, mtime: null },
        ]
      }),
    ),
  }
}

/**
 * 单程序状态（tool app_stop / 设置页单行用）：只算一个程序，不扫全部。
 */
export async function programSnapshot(cfg, registry, sampler, programId, { log = () => {}, deps = {}, fresh = false } = {}) {
  const single = { ...cfg, programs: (cfg.programs ?? []).filter((item) => item.id === programId) }
  return statusSnapshot(single, registry, sampler, { log, deps, fresh })
}
