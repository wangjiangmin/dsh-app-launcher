/**
 * dsh-app-launcher — DSH 宿主插件入口。
 *
 * 1) 注册 5 个 tool：常驻的 `app_toggle`（开关本身）+ 按全局 enabled 动态挂载的
 *    `system_status` / `app_list` / `app_start` / `app_stop`。
 *    **动态挂载是需求 6 的实现点**：tool 注册表是进程级的，开关切换时直接
 *    register / dispose，新会话与已开着的旧会话下一次组装工具表时都会看到变化。
 * 2) 挂设置页的同源 HTTP 接口（状态 / 配置读写 / 条目增删改 / 启停 / 日志）。
 */
import { resolveConfig } from './config.mjs'
import { mountAppLauncherRoutes, ROUTE_PREFIX } from './http.mjs'
import { LauncherRuntime } from './runtime.mjs'
import { appToggleDefinition, registerLauncherTools } from './tools.mjs'

export const name = 'dsh-app-launcher'

/** tools 必需（要写工具表）；webServer 可选。 */
export const inject = ['tools']

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function createLogger(verbose = true) {
  return (message) => {
    if (!verbose && !/^(失败|拒绝|超时|错误|已启动|已停止|全局)/.test(String(message))) return
    console.log(`[app-launcher] ${stamp()} ${message}`)
  }
}

function mountSettingsUi(ctx, runtime, log) {
  if (typeof ctx.inject !== 'function') {
    log('ctx.inject 不可用，跳过设置页接口挂载（界面看不到本插件）')
    return
  }
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const dispose = mountAppLauncherRoutes(host.webServer, () => ({
        log,
        statusSnapshot: () => runtime.snapshot({ fresh: true }),
        requestStart: (id) => runtime.requestStart(id),
        requestStop: (id) => runtime.requestStop(id),
        // 验证是插件自己的职责：给出端口/进程/探针三条独立证据。
        // ★ 这份门面是手写的，runtime 上新增能力必须在这里显式转发一次，
        //   否则 HTTP 路由拿到的是 undefined（表现为 "rt.verify is not a function"）。
        verify: (id, expect) => runtime.verify(id, expect),
        readLog: (id, lines) => runtime.readLog(id, lines),
        currentConfig: () => runtime.currentConfig(),
        listPrograms: () => runtime.listPrograms(),
        setGlobal: (patch) => runtime.setGlobal(patch),
        addEntry: (entry) => runtime.addEntry(entry),
        updateEntry: (id, entry) => runtime.updateEntry(id, entry),
        removeEntry: (id) => runtime.removeEntry(id),
        resetConfig: () => runtime.resetConfig(),
        setAllowedDirs: (dirs) => runtime.setAllowedDirs(dirs),
        browse: (path) => runtime.browse(path),
        // 三级作用域授权（工作区 / 会话）：同样必须在这里显式转发
        scopeInfo: (where) => runtime.scopeInfo(where),
        scopeSlice: (scope, key) => runtime.scopeSlice(scope, key),
        setScopeSlice: (scope, key, slice, note) => runtime.setScopeSlice(scope, key, slice, note),
        clearScope: (scope, key) => runtime.clearScope(scope, key),
        grants: (limit) => runtime.grants(limit),
        // HTTP 层直接读白名单（GET /config/allowed-dirs 用）
        get allowedDirs() {
          return runtime.cfg.allowedDirs ?? []
        },
        get cfg() {
          return runtime.cfg
        },
      }))
      log(`已挂载设置页接口 ${ROUTE_PREFIX}/*`)
      return dispose
    }, 'dsh-app-launcher: settings http routes')
  })
}

export function apply(ctx, rawSeed = {}) {
  const seedCfg = resolveConfig(rawSeed)
  const log = createLogger(seedCfg.verbose)

  // tool 挂载/卸载交给 runtime：全局开关一切换就立刻反映到工具表。
  const runtime = new LauncherRuntime({
    seed: rawSeed,
    log,
    mountTools: (rt) => registerLauncherTools(ctx, rt),
    unmountTools: (disposers) => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') {
          try {
            dispose()
          } catch {
            /* 重复 dispose 不致命 */
          }
        }
      }
    },
  })

  const cfg = runtime.cfg
  log(
    `已加载：${cfg.programs.length} 个程序（启用 ${cfg.programs.filter((item) => item.enabled).length}），` +
      `enabled=${cfg.enabled} 配置层=${runtime.store.hasUserLayer() ? '用户层' : 'patch 种子'} dryRun=${cfg.dryRun}`,
  )
  for (const program of cfg.programs) {
    if (!program.valid) log(`配置不完整：${program.id} —— ${program.invalidReason}`)
  }

  mountSettingsUi(ctx, runtime, log)

  // ── 会话 → 工作区 解析器 ──
  // Client 侧没有"列出工作区"的 API（workspaces 服务只有 create/rename/delete），
  // 所以由宿主用 workspaceRegistry 反查：遍历工作区的 sessionIds 找到归属。
  // 客户端只传 sessionId，工作区路径由这里解析。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['workspaceRegistry'], (host) => {
      host.effect(() => {
        const registry = host.workspaceRegistry
        runtime.setWorkspaceResolver((sessionId) => {
          try {
            for (const workspace of registry.list()) {
              const ids = workspace.sessionIds ?? []
              if (ids.includes(sessionId)) {
                return { path: workspace.path, title: workspace.title }
              }
            }
          } catch {
            /* 注册表暂不可用时返回 null，由上层提示 */
          }
          return null
        })
        log('已接入工作区解析（会话 → 工作区路径）')
        return () => runtime.setWorkspaceResolver(null)
      }, 'dsh-app-launcher: workspace resolver')
    })
  }

  // 常驻：开关本身不能被开关关掉，否则全局禁用后就没法再启用。
  const toggleDisposer = ctx.tools.register(appToggleDefinition(runtime))
  ctx.effect(() => () => {
    try {
      toggleDisposer()
    } catch {
      /* 忽略 */
    }
    if (runtime.toolDisposers) {
      for (const dispose of runtime.toolDisposers) {
        try {
          dispose()
        } catch {
          /* 忽略 */
        }
      }
      runtime.toolDisposers = null
    }
  }, 'dsh-app-launcher: tools')

  runtime.syncToolMount()

  ctx.on('app-boot/config-reload', () => {
    runtime.applyConfig(runtime.store.load())
    log('宿主配置重载，已同步')
  })
}
