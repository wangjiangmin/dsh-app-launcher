/**
 * dsh-app-launcher — 设置页用的同源 HTTP 接口。
 *
 * 客户端插件用相对路径 fetch 这几个端点，因此天然同源。
 * 挂载方式：`ctx.inject(['webServer'], …)` 后 `webServer.register({kind:'exact', path, handler})`。
 *
 * 端点：
 *   GET  /dsh-app-launcher/status            全量快照（系统 + 程序 + 门控 + 日志）
 *   POST /dsh-app-launcher/start  {id}       手动启动（立即 202，进度靠轮询 status）
 *   POST /dsh-app-launcher/stop   {id}       手动停止（只停本插件启动的进程）
 *   GET  /dsh-app-launcher/log?id=X&lines=N  单个程序日志尾部
 */

export const ROUTE_PREFIX = '/dsh-app-launcher'
const BODY_LIMIT_BYTES = 64 * 1024
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

function sendJson(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(value))
}

function requireMethod(request, response, method) {
  if (request.method === method) return true
  response.writeHead(405, { allow: method })
  response.end()
  return false
}

/** 把 `host[:port]` 归一化成 `loopback:端口`（三个回环别名算同一身份）。 */
function loopbackAuthority(authority) {
  try {
    const parsed = new URL(`http://${authority}`)
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return null
    return `loopback:${parsed.port === '' ? '80' : parsed.port}`
  } catch {
    return null
  }
}

/**
 * POST 只接受本机回环来源。Host 必须是回环（顺带挡 DNS rebinding）；
 * Origin 缺失（桌面端宿主转发）与 `dsh-app:` 协议放行；其余按归一化后比较。
 * 这是这些接口唯一的 CSRF 防线。
 */
export function isSameOrigin(request) {
  const host = request.headers?.host
  const hostKey = host === undefined ? null : loopbackAuthority(host)
  if (hostKey === null) return false
  const origin = request.headers?.origin
  if (origin === undefined || origin === '') return true
  try {
    const url = new URL(origin)
    if (url.protocol === 'dsh-app:') return true
    return loopbackAuthority(url.host) === hostKey
  } catch {
    return false
  }
}

function requireTrustedPost(request, response) {
  if (!requireMethod(request, response, 'POST')) return false
  if (isSameOrigin(request)) return true
  sendJson(response, 403, { error: 'untrusted origin' })
  return false
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > BODY_LIMIT_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 挂载四个端点。`getRuntime()` 每次请求都重新取 `{ cfg, log, ... }`，
 * 这样宿主热重载配置后界面立刻反映新配置。
 *
 * @param {object} webServer  ctx.webServer
 * @param {() => object} getRuntime  返回 { cfg, log, statusSnapshot, requestStart, requestStop, readLog }
 * @returns {() => void} disposer
 */
export function mountAppLauncherRoutes(webServer, getRuntime) {
  const runtime = () => getRuntime() ?? {}

  /** 统一的错误应答：校验错误 / 浏览错误 → 400（带 code），其余 → 500。 */
  function sendError(response, error) {
    const message = error instanceof Error ? error.message : String(error)
    const isValidation = error?.name === 'ConfigValidationError'
    const isBrowse = error?.name === 'BrowseError'
    const status = isValidation || isBrowse ? 400 : 500
    sendJson(response, status, {
      ok: false,
      error: message,
      field: error?.field ?? null,
      code: error?.code ?? null,
    })
  }

  async function readBody(request) {
    try {
      return await readJsonBody(request)
    } catch {
      return {}
    }
  }

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        const rt = runtime()
        try {
          sendJson(response, 200, await rt.statusSnapshot())
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    // ---- 配置：读 / 全局开关 / 条目增删改 / 重置 ----
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config`,
      handler: (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        try {
          sendJson(response, 200, { ok: true, config: runtime().currentConfig() })
        } catch (error) {
          sendError(response, error)
        }
      },
    }),

    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config/global`,
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        const body = await readBody(request)
        try {
          sendJson(response, 200, { ok: true, config: runtime().setGlobal(body?.patch ?? body ?? {}) })
        } catch (error) {
          sendError(response, error)
        }
      },
    }),

    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config/program`,
      handler: async (request, response) => {
        const rt = runtime()
        const body = await readBody(request)
        try {
          if (request.method === 'POST') {
            const result = rt.addEntry(body?.entry ?? {})
            sendJson(response, 200, { ok: true, ...result })
            return
          }
          if (request.method === 'PATCH') {
            const id = String(body?.id ?? '').trim()
            if (!id) {
              sendJson(response, 400, { ok: false, error: '缺少条目 id' })
              return
            }
            const result = rt.updateEntry(id, body?.entry ?? {})
            sendJson(response, 200, { ok: true, ...result })
            return
          }
          if (request.method === 'DELETE') {
            const id = String(body?.id ?? '').trim()
            if (!id) {
              sendJson(response, 400, { ok: false, error: '缺少条目 id' })
              return
            }
            const result = rt.removeEntry(id)
            sendJson(response, 200, { ok: true, ...result })
            return
          }
          response.writeHead(405, { allow: 'POST, PATCH, DELETE' })
          response.end()
        } catch (error) {
          sendError(response, error)
        }
      },
    }),

    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config/reset`,
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        try {
          sendJson(response, 200, { ok: true, config: runtime().resetConfig() })
        } catch (error) {
          sendError(response, error)
        }
      },
    }),

    // ---- 授权目录：读 / 改 ----
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config/allowed-dirs`,
      handler: async (request, response) => {
        const rt = runtime()
        try {
          if (request.method === 'GET') {
            sendJson(response, 200, { ok: true, allowedDirs: rt.allowedDirs ?? [] })
            return
          }
          if (request.method === 'POST') {
            const body = await readBody(request)
            const dirs = body?.allowedDirs
            if (!Array.isArray(dirs)) {
              sendJson(response, 400, { ok: false, error: 'allowedDirs 必须是数组' })
              return
            }
            sendJson(response, 200, { ok: true, ...rt.setAllowedDirs(dirs) })
            return
          }
          response.writeHead(405, { allow: 'GET, POST' })
          response.end()
        } catch (error) {
          sendError(response, error)
        }
      },
    }),

    // ---- 文件浏览（仅限授权目录内） ----
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/browse`,
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        const rt = runtime()
        try {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const target = url.searchParams.get('path') ?? ''
          sendJson(response, 200, { ok: true, ...(await rt.browse(target)) })
        } catch (error) {
          sendError(response, error)
        }
      },
    }),

    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/start`,
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        const rt = runtime()
        let body = {}
        try {
          body = await readJsonBody(request)
        } catch {
          /* body 可选 */
        }
        const id = String(body?.id ?? '').trim()
        if (!id) {
          sendJson(response, 400, { ok: false, error: '缺少程序 id' })
          return
        }
        try {
          const result = rt.requestStart(id)
          sendJson(response, 202, { ok: true, ...result })
        } catch (error) {
          sendJson(response, 409, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/stop`,
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        const rt = runtime()
        let body = {}
        try {
          body = await readJsonBody(request)
        } catch {
          /* body 可选 */
        }
        const id = String(body?.id ?? '').trim()
        if (!id) {
          sendJson(response, 400, { ok: false, error: '缺少程序 id' })
          return
        }
        try {
          const result = await rt.requestStop(id)
          sendJson(response, result?.stopped ? 200 : 409, { ok: Boolean(result?.stopped), result })
        } catch (error) {
          sendJson(response, 409, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/verify`,
      handler: async (request, response) => {
        const rt = runtime()
        try {
          const url = new URL(request.url ?? '/', 'http://localhost')
          // GET /verify?id=xxx&expect=stopped  或 POST { id, expect }
          let id = String(url.searchParams.get('id') ?? '').trim()
          let expect = String(url.searchParams.get('expect') ?? 'stopped').trim()
          if (request.method === 'POST') {
            if (!requireTrustedPost(request, response)) return
            const body = await readJsonBody(request).catch(() => ({}))
            if (body?.id !== undefined) id = String(body.id).trim()
            if (body?.expect !== undefined) expect = String(body.expect).trim()
          } else if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET, POST' })
            response.end()
            return
          }
          sendJson(response, 200, { ok: true, ...(await rt.verify(id, expect)) })
        } catch (error) {
          sendError(response, error)
        }
      },
    }),

    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/log`,
      handler: (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        const rt = runtime()
        try {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const id = String(url.searchParams.get('id') ?? '').trim()
          const lines = Math.min(Math.max(Number(url.searchParams.get('lines') ?? 200) || 200, 1), 2000)
          if (!id) {
            sendJson(response, 400, { error: '缺少程序 id' })
            return
          }
          sendJson(response, 200, rt.readLog(id, lines))
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  ]

  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') {
        try {
          dispose()
        } catch {
          /* 宿主关闭时重复 dispose 不致命 */
        }
      }
    }
  }
}
