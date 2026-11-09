/**
 * dsh-app-launcher — 给 Agent 的 4 个 tool。
 *
 * 免二次授权的落点：启动不走外部 shell 工具（那条链路有审批），
 * 而是插件内部 spawn——与 dsh-ninfer-autostart 同一条通路。
 * 安全边界是配置白名单：只有 programs 里 enabled=true 且路径写死在配置里的
 * 条目能被启动，Agent 无法传任意命令。
 */

const text = (value) => [{ type: 'text', text: value }]

function renderValue(value) {
  return text(JSON.stringify(value, null, 2))
}

/**
 * 把系统采样格式化成一眼能看懂的几行。
 * 占用 GPU 的进程只列前 5 个（按显存降序）：Windows 上这张表可能很长，
 * 全列出来会把摘要变成一屏噪音，也挤掉真正有用的判断信息。
 */
export function formatSystem(system) {
  const lines = []
  const gpu = system.gpu
  if (gpu?.available) {
    lines.push(`GPU：${gpu.name ?? '未知型号'}  利用率 ${gpu.utilPct}%  显存 ${gpu.usedMiB}/${gpu.totalMiB} MiB（空闲 ${gpu.freeMiB} MiB）`)
  } else {
    lines.push(`GPU：读不到状态（${gpu?.reason ?? 'nvidia-smi 不可用'}）`)
  }
  const mem = system.memory
  lines.push(`内存：空闲 ${mem.freeMiB} MiB / 共 ${mem.totalMiB} MiB（已用 ${mem.usedMiB} MiB）`)
  lines.push(`CPU：${system.cpu.pct ?? '未知'}%（${system.cpu.cpus} 逻辑核心）`)

  const holders = [...(system.gpuHolders ?? [])]
    .filter((item) => Number.isFinite(Number(item.usedMiB)))
    .sort((a, b) => Number(b.usedMiB) - Number(a.usedMiB))
  if (holders.length > 0) {
    const shown = holders.slice(0, 5).map((item) => `${item.name}(PID ${item.pid}, ${item.usedMiB} MiB)`)
    const more = holders.length > 5 ? `……另有 ${holders.length - 5} 个` : ''
    lines.push(`占用 GPU 的进程：${shown.join('；')}${more}`)
  } else if (gpu?.available) {
    lines.push('占用 GPU 的进程：无（桌面合成进程不计）')
  }
  const heavy = system.heavyInUse ?? []
  if (heavy.length > 0) lines.push(`本插件在跑的重活：${heavy.join('、')}`)
  return lines.join('\n')
}

export function systemStatusDefinition(runtime) {
  return {
    name: 'system_status',
    description:
      '查询这台主机当前的负载：CPU 占用、内存空闲、GPU 利用率与显存、以及谁在占用 GPU。用于在启动本地 AI 软件之前判断机器是否有空，也用于观察任务是否跑完。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (_args, value) => renderValue(value) },
    async execute() {
      const snapshot = await runtime.snapshot({ fresh: true })
      return {
        summary: formatSystem(snapshot.system),
        system: snapshot.system,
        programsRunning: snapshot.programs
          .filter((item) => item.running)
          .map((item) => ({ id: item.id, name: item.name, phase: item.phase })),
        at: snapshot.system.at,
      }
    },
  }
}

export function appListDefinition(runtime) {
  return {
    name: 'app_list',
    description:
      '列出已配置的本地软件（ComfyUI / LM Studio / NInfer 等）：启用状态、启动路径、需要的空闲资源、是否在运行、以及现在能不能启动（门控结论）。启动前先看这个。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (_args, value) => renderValue(value) },
    async execute() {
      const snapshot = await runtime.snapshot()
      const programs = snapshot.programs.map((item) => ({
        id: item.id,
        name: item.name,
        enabled: item.enabled,
        description: item.description,
        phase: item.phase,
        running: item.running,
        canStop: item.canStop,
        stopBlockedReason: item.stopBlockedReason,
        exclusive: item.exclusive,
        needs: item.needs,
        launch: item.launch.exe,
        readyUrl: item.ready.url,
        gate: {
          // action 决定语义：'start' 才是"现在可以起"，'already-running' 是"已在跑"，
          // 'reject' 才是"不能起"。只给 ok 会让 Agent 把"已在跑"误读成"可以起"。
          action: snapshot.gates?.[item.id]?.action ?? null,
          ok: snapshot.gates?.[item.id]?.ok ?? null,
          reason: snapshot.gates?.[item.id]?.reason ?? null,
          suggestions: snapshot.gates?.[item.id]?.suggestions ?? [],
        },
      }))
      return {
        plugin: snapshot.plugin,
        summary: formatSystem(snapshot.system),
        programs,
        at: snapshot.system.at,
      }
    },
  }
}

export function appStartDefinition(runtime) {
  return {
    name: 'app_start',
    description:
      '启动一个已配置的本地软件。启动前会自动做资源门控：只有在 CPU / GPU / 内存都空闲时才真正拉起；不满足时**不会启动**，而是返回具体读数、缺哪一项、以及建议怎么办。配置里 enabled=true 的条目无需二次授权即可启动。可等待就绪（最多 timeout_ms）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '程序 id（用 app_list 查看，例如 comfyui、lm-studio、ninfer）' },
        wait: { type: 'boolean', description: 'true = 等到就绪或超时再返回（默认 true）；false = 只受理，靠 app_list 轮询进度' },
        timeout_ms: {
          type: 'number',
          minimum: 0,
          maximum: 600000,
          description: '等待就绪的上限（默认 180000）。冷启动要几十秒到几分钟。',
        },
      },
      required: ['id'],
    },
    output: { schema: { type: 'object' }, render: (_args, value) => renderValue(value) },
    async execute(args, exec) {
      const id = String(args.id ?? '').trim()
      const accepted = await runtime.requestStart(id)

      if (!accepted.accepted) {
        return {
          ok: false,
          accepted: false,
          phase: 'rejected',
          reason: accepted.reason,
          suggestions: accepted.suggestions ?? [],
          gate: accepted.gate,
        }
      }
      if (!accepted.started) {
        return { ok: true, accepted: true, started: false, phase: accepted.phase, reason: accepted.reason, gate: accepted.gate }
      }

      const wait = args.wait !== false
      if (!wait) {
        return { ok: true, accepted: true, started: true, phase: 'starting', note: '已在后台启动，可用 app_list 查看进度', dryRun: accepted.dryRun }
      }

      const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : runtime.cfg.readyTimeoutMs
      const waited = await runtime.waitStart(id, timeoutMs)
      let snapshot = null
      if (waited?.ok) {
        runtime.sampler.invalidate()
        snapshot = await runtime.snapshot({ fresh: true })
      }
      return {
        ok: Boolean(waited?.ok),
        accepted: true,
        started: true,
        phase: waited?.ok ? 'ready' : (waited?.pending ? 'starting' : 'failed'),
        elapsedMs: waited?.elapsedMs ?? null,
        error: waited?.error ?? null,
        system: snapshot?.system ?? null,
        summary: snapshot ? formatSystem(snapshot.system) : null,
        dryRun: accepted.dryRun,
      }
    },
  }
}

export function appStopDefinition(runtime) {
  return {
    name: 'app_stop',
    description:
      '停止一个本地软件。只停本插件启动的进程：手动启动或提权启动的进程会被拒绝（并说明原因），绝不误杀。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '程序 id（用 app_list 查看）' } },
      required: ['id'],
    },
    output: { schema: { type: 'object' }, render: (_args, value) => renderValue(value) },
    async execute(args) {
      const id = String(args.id ?? '').trim()
      const result = await runtime.requestStop(id)
      return {
        ok: Boolean(result?.stopped),
        stopped: Boolean(result?.stopped),
        reason: result?.reason ?? null,
        alreadyStopped: Boolean(result?.alreadyStopped),
        ownership: result?.ownership ?? null,
      }
    },
  }
}

/**
 * 全局开关（需求 5 + 6）：Agent 也能读状态、改开关。
 * 只暴露"开关"这一个动作，不让 Agent 改路径/阈值——那是人在设置页做的事。
 */
export function appToggleDefinition(runtime) {
  return {
    name: 'app_toggle',
    description:
      '读取或切换「本地应用启动器」的全局开关。开启后 app_list / app_start / app_stop 对本会话与其它已开着的会话立即可用；关闭后它们立刻从工具表消失。只切换开关，不修改任何启动路径或资源阈值（那些在设置页里改）。',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true = 启用；false = 禁用；省略 = 只查询当前状态' },
      },
      required: [],
    },
    output: { schema: { type: 'object' }, render: (_args, value) => renderValue(value) },
    async execute(args) {
      const wanted = args?.enabled
      if (wanted === undefined) {
        const cfg = runtime.currentConfig()
        return { ok: true, enabled: cfg.enabled, toolsMounted: cfg.toolsMounted, programCount: runtime.cfg.programs.length }
      }
      if (typeof wanted !== 'boolean') throw new Error('app_toggle: enabled 必须是布尔值')
      const before = runtime.cfg.enabled
      const cfg = runtime.setGlobal({ enabled: wanted })
      return {
        ok: true,
        changed: before !== cfg.enabled,
        enabled: cfg.enabled,
        toolsMounted: cfg.toolsMounted,
        note: cfg.enabled
          ? '已启用：新会话与已开着的会话都可以调用 app_list / app_start'
          : '已禁用：app_* 工具已从工具表注销',
      }
    },
  }
}

/**
 * 注册全部 tool，返回 disposers。
 *
 * 注意：`app_toggle` 由插件入口单独常驻注册（见 lib/index.js），
 * 这样全局禁用时它仍然在，Agent 才有办法重新启用。
 */
export function registerLauncherTools(ctx, runtime) {
  const tools = ctx.tools
  const disposers = [
    tools.register(systemStatusDefinition(runtime)),
    tools.register(appListDefinition(runtime)),
    tools.register(appStartDefinition(runtime)),
    tools.register(appStopDefinition(runtime)),
  ]
  return disposers
}
