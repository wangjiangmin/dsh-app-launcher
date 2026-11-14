// client.hooks.js — dsh-app-launcher 客户端 chunk（单一职责）。由 client.js 组合根经 require.async 加载，build(deps) 显式接收依赖。
window.__ModuleLoader__.load({
  id: 'dsh-app-launcher',
  chunk: 'client.hooks.js',
  factory(require) {
    function build({ React, core }) {
      const { POLL_MS, jsonFetch } = core

    /**
     * 状态数据。
     *
     * ★ 懒加载：首屏只取 `?lazy=1`（不采样、不探针，秒开）。
     * 只有用户点「测试」或启动某个程序之后，才切到完整模式并按 POLL_MS 轮询 ——
     * 之前一进设置页就 full 采样 + 每 3 秒轮询，等于持续跑 nvidia-smi，很卡。
     *
     * @param {boolean} live 是否进入完整模式（已测试过 / 有程序在启动或运行）
     */
    function useStatus(live) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [checking, setChecking] = React.useState(false)

      const fetchOnce = React.useCallback(async (full) => {
        try {
          const res = await jsonFetch(full ? '/status?fresh=1' : '/status?lazy=1')
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          setData(res.body)
          setError(null)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }, [])

      const refresh = React.useCallback(async () => {
        await fetchOnce(Boolean(live))
      }, [fetchOnce, live])

      /** 手动「测试」：强制一次完整采样。 */
      const probe = React.useCallback(async () => {
        setChecking(true)
        try {
          await fetchOnce(true)
        } finally {
          setChecking(false)
        }
      }, [fetchOnce])

      React.useEffect(() => {
        refresh()
      }, [refresh])

      // 轮询策略：只在"有程序正在启动或在运行"时轮询（那时需要看进度/状态变化）。
      // 单纯点过一次「测试」不该导致后台每 3 秒跑一次 nvidia-smi —— 那是持续开销。
      const needPoll = Boolean(
        live && data?.programs?.some((p) => p.starting || p.phase === 'starting' || p.phase === 'ready'),
      )
      React.useEffect(() => {
        if (!needPoll) return undefined
        const timer = setInterval(() => { fetchOnce(true) }, POLL_MS)
        return () => clearInterval(timer)
      }, [needPoll, fetchOnce])

      return { data, error, refresh, probe, checking }
    }

    function useConfig() {
      const [config, setConfig] = React.useState(null)
      const refresh = React.useCallback(async () => {
        try {
          const res = await jsonFetch('/config')
          if (res.ok) setConfig(res.body?.config ?? null)
        } catch {
          /* 配置读不到不影响状态展示 */
        }
      }, [])
      React.useEffect(() => {
        refresh()
      }, [refresh])
      return { config, setConfig, refresh }
    }

    /** 会话列表：GET /sessions（宿主 sessionQuery；缺失时降级 workspaceRegistry）。 */
    function useSessions() {
      const [state, setState] = React.useState({ loading: true, sessions: [], source: 'none', error: null })
      const reload = React.useCallback(async () => {
        setState((prev) => ({ ...prev, loading: true }))
        try {
          const res = await jsonFetch('/sessions')
          if (!res.ok) throw new Error(res.body?.error ?? `HTTP ${res.status}`)
          setState({ loading: false, sessions: res.body.sessions ?? [], source: res.body.source ?? 'none', error: null })
        } catch (err) {
          setState({ loading: false, sessions: [], source: 'none', error: err instanceof Error ? err.message : String(err) })
        }
      }, [])
      React.useEffect(() => { reload() }, [reload])
      return { ...state, reload }
    }

      return { useStatus, useConfig, useSessions }
    }
    return { build }
  },
})
