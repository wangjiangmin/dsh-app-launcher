/**
 * dsh-app-launcher — 运行时。
 *
 * 把「配置存储 / 采样 / 程序生命周期 / 状态快照 / 工具挂载」串成一体，
 * 供 tool（lib/tools.mjs）与设置页 HTTP 接口（lib/http.mjs）共用。
 *
 * 关键契约：
 * - **配置持久化**：用户层 $DSH_HOME/app-launcher/config.json，界面改完立刻生效；
 * - **授权模型（poolVersion 2）**：统一条目池「软件/脚本/目录」，每个条目自带
 *   sessions / workspaces 两种授权。**没有全局授权**：条目授权给某会话（sessions）
 *   或某工作区（workspaces，该工作区下所有会话默认可用）后，对应会话的工具才能
 *   看到/使用它；设置页（管理面）始终能看到全部条目。
 * - **动态生效**：全局 enabled 切换时直接注册/注销 tool；会话授权改动下一次
 *   工具调用立刻生效（每次调用都带调用者 sessionId 重新过滤）；
 * - **启动必须先过门控**：结论取自 statusSnapshot.gates[id]，与界面完全同一份；
 * - **停止只停本插件启动的进程**。
 */
import { basename } from 'node:path'
import { addProgram, ConfigValidationError, deriveId, removeProgram, updateGlobal, updateProgram } from './edit.mjs'
import { listAllowedDirectory } from './browse.mjs'
import { createConfigStore, programToPersistable as toPersistableProgram } from './store.mjs'
import { effectiveAllowedDirs, findProgram, normalizeSessions, normalizeWorkspaces, pathKey, resolveConfig } from './config.mjs'
import { createRegistry, ensureRunning, readLogTail, stopProgram } from './programs.mjs'
import { createScopeStore, mergeDirs } from './scopes.mjs'
import { statusSnapshot } from './status.mjs'
import { createSampler } from './sysinfo.mjs'
import { verifyAll, verifyProgram } from './verify.mjs'

/** 会话选择器一次最多返回的会话数。 */
const SESSION_LIST_CAP = 300

export class LauncherRuntime {
  /**
   * @param {object} options
   * @param {object} options.seed      来自 patch 的种子配置
   * @param {Function} options.log
   * @param {object} options.deps      测试注入
   * @param {Function} options.mountTools    (runtime) => dispose[]，注册 tool
   * @param {Function} options.unmountTools  (disposers) => void
   */
  constructor({ seed = {}, log = () => {}, deps = {}, mountTools = null, unmountTools = null, dataDir = null } = {}) {
    this.log = log
    this.deps = deps
    this.mountTools = mountTools
    this.unmountTools = unmountTools

    const provisional = resolveConfig(seed)
    const dir = dataDir ?? provisional.dataDir
    // dataDir 可显式指定：测试要隔离到临时目录，生产走 $DSH_HOME/app-launcher。
    this.store = createConfigStore({ seed, dataDir: dir })
    /** 授权审计 + 旧三层切片迁移（见 lib/scopes.mjs）。 */
    this.scopes = createScopeStore({ dataDir: dir })
    this.cfg = resolveConfig(this.store.load())
    /** 尚未展开的旧工作区授权（等 workspaceRegistry 到位后折叠进 sessions）。 */
    this._pendingWorkspaceGrants = []
    this._migratePool()
    this.registry = createRegistry()
    this.sampler = this._makeSampler()
    this.startStates = new Map()
    this.snapshotCache = null
    this.snapshotInflight = null
    /** 当前已挂载的 tool disposers；null = 未挂载。 */
    this.toolDisposers = null
    /** 配置版本号：每次保存 +1，界面用它判断是否需要刷新。 */
    this.revision = 0
    /** 会话上下文：null=管理面（设置页，看全部）；{sessionId}=工具面（按授权过滤）。 */
    this._scopeContext = null
    this._sessionQuery = null
    this._workspaceLister = null
    /** 会话 → 所属工作区解析器：(sessionId) => { path, title } | null（宿主注入）。 */
    this._workspaceResolver = null

    // 构造末尾就按初始 enabled 对齐工具表：这样 runtime 自己就是权威，
    // 调用方不必记得"还要再 sync 一次"（漏调会导致开关与工具表不一致）。
    this.syncToolMount()
  }

  _makeSampler() {
    return createSampler(
      { cacheMs: this.cfg.sampleCacheMs, nvidiaSmi: this.cfg.nvidiaSmi, deps: this.deps.sysinfo ?? {} },
      (message) => this.log(message),
    )
  }

  // ==================== 旧授权模型迁移（poolVersion 1 → 2） ====================

  /**
   * 把旧模型折叠进统一条目池：
   *  - 旧 programs → kind='program'，sessions 来自旧**会话切片**里对它的授权；
   *  - 旧会话/工作区切片里独有的条目 → 补进池子；
   *  - 旧全局 allowedDirs 与各切片目录 → kind='directory' 条目
   *    （全局目录 sessions=[]，即收缩后默认不授权；会话切片目录授权给该会话）；
   *  - 工作区切片的授权需要「工作区 → 会话列表」展开，宿主服务到位前挂起
   *    （_pendingWorkspaceGrants），由 expandWorkspaceGrants 完成。
   * 迁移是幂等的：poolVersion===2 直接返回。
   */
  _migratePool() {
    if (this.cfg.poolVersion === 2) return
    const raw = this.store.load()
    const legacy = this.scopes.legacySlices()
    const sessionSlices = legacy.sessions ?? {}
    const workspaceSlices = legacy.workspaces ?? {}

    // 1) 旧会话切片里的程序授权：programId → Set(sessionId)
    const sessionGrants = new Map()
    for (const [sid, slice] of Object.entries(sessionSlices)) {
      for (const p of slice?.programs ?? []) {
        const pid = String(p?.id ?? '').trim()
        if (!pid) continue
        if (!sessionGrants.has(pid)) sessionGrants.set(pid, new Set())
        sessionGrants.get(pid).add(String(sid))
      }
    }

    const programs = (Array.isArray(raw.programs) ? raw.programs : []).map((p) => {
      const pid = String(p?.id ?? '').trim()
      const granted = sessionGrants.get(pid)
      return {
        ...p,
        kind: p?.kind ?? 'program',
        sessions: normalizeSessions([...(Array.isArray(p?.sessions) ? p.sessions : []), ...(granted ?? [])]),
      }
    })
    const existingIds = new Set(programs.map((p) => String(p.id ?? '').trim()))

    // 2) 切片里独有的条目补进池子（会话切片的直接带授权；工作区切片的等展开）
    for (const [sid, slice] of Object.entries(sessionSlices)) {
      for (const p of slice?.programs ?? []) {
        const pid = String(p?.id ?? '').trim()
        if (!pid || existingIds.has(pid)) continue
        existingIds.add(pid)
        programs.push({ ...p, kind: p?.kind ?? 'program', sessions: [String(sid)] })
      }
    }
    this._pendingWorkspaceGrants = []
    for (const [wpath, slice] of Object.entries(workspaceSlices)) {
      const programIds = []
      for (const p of slice?.programs ?? []) {
        const pid = String(p?.id ?? '').trim()
        if (!pid) continue
        programIds.push(pid)
        if (existingIds.has(pid)) continue
        existingIds.add(pid)
        programs.push({ ...p, kind: p?.kind ?? 'program', sessions: [] })
      }
      const dirs = Array.isArray(slice?.allowedDirs) ? slice.allowedDirs.map((d) => String(d)) : []
      if (programIds.length > 0 || dirs.length > 0) {
        this._pendingWorkspaceGrants.push({ workspacePath: String(wpath), programIds, dirs })
      }
    }

    // 3) 目录 → directory 条目。全局目录不授权给任何会话（收缩的本意）；
    //    会话切片目录授权给该会话；工作区切片目录等展开。
    const dirCandidates = new Map() // pathKey → { path, sessions:Set }
    const addDir = (dir, sid = null) => {
      const text = String(dir ?? '').trim()
      if (text === '') return
      const key = pathKey(text)
      if (!dirCandidates.has(key)) dirCandidates.set(key, { path: text, sessions: new Set() })
      if (sid) dirCandidates.get(key).sessions.add(String(sid))
    }
    for (const dir of raw.allowedDirs ?? []) addDir(dir)
    for (const [sid, slice] of Object.entries(sessionSlices)) {
      for (const dir of slice?.allowedDirs ?? []) addDir(dir, sid)
    }
    for (const slice of Object.values(workspaceSlices)) {
      for (const dir of slice?.allowedDirs ?? []) addDir(dir)
    }
    for (const { path: dirPath, sessions } of dirCandidates.values()) {
      const name = basename(dirPath) || dirPath
      const id = deriveId(name, [...existingIds])
      existingIds.add(id)
      programs.push({
        id,
        name,
        kind: 'directory',
        path: dirPath,
        sessions: [...sessions],
        enabled: true,
        description: '由旧版授权目录迁移而来',
      })
    }

    // 4) 落盘（直接写存储，不走 applyConfig：构造期 sampler 还没建）
    const next = { ...raw, poolVersion: 2, allowedDirs: [], programs }
    const stored = this.store.save(next)
    this.cfg = resolveConfig(stored)
    this.scopes.addGrant({
      scope: 'entry', kind: 'entry', action: 'migrate',
      target: `${programs.length} 个条目`,
      note: 'poolVersion 1→2：三层作用域与全局目录已折叠为条目级会话授权',
    })
    if (this._pendingWorkspaceGrants.length === 0) {
      this.scopes.consumeLegacySlices()
    }
    this.log(`授权模型迁移完成：${programs.length} 个条目（软件/脚本/目录），全局授权已废除`)
  }

  /**
   * 展开旧工作区授权：把「工作区路径」翻译成该工作区下的会话 id 列表，
   * 写进对应条目的 sessions。由 index.js 在 workspaceRegistry 到位后调用。
   *
   * @param {(workspacePath: string) => string[]|null} listWorkspaceSessions
   *   返回 null = 工作区已不存在（授权随之作废，审计里记一笔）。
   */
  expandWorkspaceGrants(listWorkspaceSessions) {
    const pending = this._pendingWorkspaceGrants ?? []
    if (pending.length === 0) return { expanded: 0, dropped: 0 }
    const raw = this.store.load()
    const programs = (raw.programs ?? []).map((p) => ({ ...p, sessions: normalizeSessions(p?.sessions) }))
    let expanded = 0
    let dropped = 0
    for (const item of pending) {
      let sids = null
      try {
        sids = listWorkspaceSessions(item.workspacePath)
      } catch {
        sids = null
      }
      if (!Array.isArray(sids)) {
        dropped += item.programIds.length + item.dirs.length
        this.scopes.addGrant({
          scope: 'entry', kind: 'entry', action: 'remove',
          target: item.workspacePath, note: '迁移：工作区已不存在，旧工作区授权作废',
        })
        continue
      }
      const ids = sids.map((s) => String(s))
      for (const pid of item.programIds) {
        const entry = programs.find((p) => String(p.id) === pid)
        if (!entry) continue
        entry.sessions = normalizeSessions([...entry.sessions, ...ids])
        expanded += 1
      }
      const dirKeys = new Set(item.dirs.map((d) => pathKey(d)))
      for (const entry of programs) {
        if (entry.kind !== 'directory' || !dirKeys.has(pathKey(entry.path))) continue
        entry.sessions = normalizeSessions([...entry.sessions, ...ids])
        expanded += 1
      }
    }
    this._pendingWorkspaceGrants = []
    this.scopes.consumeLegacySlices()
    if (expanded > 0) {
      const stored = this.store.save({ ...raw, programs })
      this.cfg = resolveConfig(stored)
      this.revision += 1
      this.snapshotCache = null
      this.scopes.addGrant({
        scope: 'entry', kind: 'entry', action: 'migrate',
        target: `${expanded} 条工作区授权`, note: '已展开为具体会话授权',
      })
    }
    return { expanded, dropped }
  }

  /** 整体换配置（保存后调用），并按 enabled 同步 tool 挂载状态。 */
  applyConfig(rawConfig) {
    const previousSampler = { cacheMs: this.cfg.sampleCacheMs, nvidiaSmi: this.cfg.nvidiaSmi }
    this.cfg = resolveConfig(rawConfig)
    this.snapshotCache = null
    this.revision += 1
    if (previousSampler.cacheMs !== this.cfg.sampleCacheMs || previousSampler.nvidiaSmi !== this.cfg.nvidiaSmi) {
      this.sampler = this._makeSampler()
    }
    this.syncToolMount()
    return this.cfg
  }

  /**
   * 按全局 enabled 挂载或卸载 tool。
   *
   * 这是"旧会话也能用"的实现点：tool 注册表是**进程级全局**的，注册后
   * 任何会话在下一次组装工具表时都会看到它，无需重开会话。
   */
  syncToolMount() {
    const wantMounted = this.cfg.enabled === true
    if (wantMounted && this.toolDisposers === null) {
      if (typeof this.mountTools !== 'function') return false
      this.toolDisposers = this.mountTools(this) ?? []
      this.log(`全局启用：已挂载 tool（新会话与已开着的会话都可直接调用）`)
      return true
    }
    if (!wantMounted && this.toolDisposers !== null) {
      if (typeof this.unmountTools === 'function') {
        this.unmountTools(this.toolDisposers)
      } else {
        // 没有外部卸载器时自己调 disposer：注销必须真的发生，
        // 否则"全局禁用"只是改了个标志位，工具仍然能被调用。
        for (const dispose of this.toolDisposers) {
          if (typeof dispose === 'function') {
            try {
              dispose()
            } catch {
              /* 重复 dispose 不致命 */
            }
          }
        }
      }
      this.toolDisposers = null
      this.log('全局禁用：已注销 tool（现有会话不会再看到它们）')
      return true
    }
    return false
  }

  /** 当前 tool 是否可见。 */
  get toolsMounted() {
    return this.toolDisposers !== null
  }

  // ==================== 会话列表（授权选择器用） ====================

  /** 注入宿主的 sessionQuery 服务（可选；缺失时降级到工作区会话列表）。 */
  setSessionQuery(service) {
    this._sessionQuery = service && typeof service.listSessions === 'function' ? service : null
  }

  /** 注入工作区列表器：() => [{ path, title, sessionIds }]（降级数据源）。 */
  setWorkspaceLister(lister) {
    this._workspaceLister = typeof lister === 'function' ? lister : null
  }

  /**
   * 注入「会话 → 所属工作区」解析器：(sessionId) => { path, title } | null。
   * 由 index.js 用宿主 workspaceRegistry 实现（遍历工作区找 sessionIds 命中）。
   * 工作区授权可见性靠它把会话映射到工作区路径。
   */
  setWorkspaceResolver(resolver) {
    this._workspaceResolver = typeof resolver === 'function' ? resolver : null
  }

  /** 会话所属工作区（规范路径）；无解析器/找不到/出错时返回 null。 */
  workspaceOfSession(sessionId) {
    const sid = String(sessionId ?? '')
    if (sid === '' || !this._workspaceResolver) return null
    try {
      const ws = this._workspaceResolver(sid)
      if (ws && typeof ws.path === 'string' && ws.path !== '') return ws
      return null
    } catch {
      return null
    }
  }

  /**
   * 列出可授权的工作区。数据源是宿主 workspaceRegistry（经 _workspaceLister）。
   * 返回 { source, workspaces:[{id,path,title,sessionCount}] }；无服务时 source='none'。
   */
  listWorkspaces() {
    if (!this._workspaceLister) return { source: 'none', workspaces: [] }
    try {
      const list = this._workspaceLister() ?? []
      const workspaces = (Array.isArray(list) ? list : [])
        .map((ws) => ({
          id: String(ws?.id ?? ''),
          path: String(ws?.path ?? ''),
          title: String(ws?.title ?? ''),
          sessionCount: Array.isArray(ws?.sessionIds) ? ws.sessionIds.length : 0,
        }))
        .filter((w) => w.path !== '')
      return { source: 'workspaceRegistry', workspaces }
    } catch {
      return { source: 'none', workspaces: [] }
    }
  }

  /**
   * 列出可授权的会话（新→旧）。
   * 首选 sessionQuery（有标题/存活状态），降级 workspaceRegistry（只有 id），
   * 再降级空列表。返回 { source, sessions:[{id,title,createdAt,cwd,live,subagent}] }。
   */
  async listSessions() {
    const sq = this._sessionQuery
    if (sq) {
      try {
        const records = await sq.listSessions()
        const list = Array.isArray(records) ? records : []
        const ids = list.map((r) => String(r?.header?.id ?? '')).filter((id) => id !== '')
        const titles = new Map()
        if (typeof sq.readTitleSnapshots === 'function' && ids.length > 0) {
          try {
            const observations = await sq.readTitleSnapshots(ids)
            for (const obs of observations ?? []) {
              const title = obs?.status === 'fulfilled' ? obs?.value?.title?.title : null
              if (title) titles.set(String(obs.sessionId), String(title))
            }
          } catch {
            /* 标题拿不到不影响选择器：显示 id 即可 */
          }
        }
        return {
          source: 'sessionQuery',
          sessions: list.slice(0, SESSION_LIST_CAP).map((r) => {
            const id = String(r?.header?.id ?? '')
            return {
              id,
              title: titles.get(id) ?? '',
              createdAt: r?.header?.createdAt ?? null,
              cwd: String(r?.header?.cwd ?? ''),
              live: r?.live === true,
              subagent: r?.header?.origin === 'subagent',
            }
          }).filter((s) => s.id !== ''),
        }
      } catch (error) {
        this.log(`读取会话列表失败（降级到工作区列表）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (this._workspaceLister) {
      try {
        const workspaces = this._workspaceLister() ?? []
        const seen = new Set()
        const sessions = []
        for (const ws of workspaces) {
          for (const sid of ws?.sessionIds ?? []) {
            const id = String(sid)
            if (id === '' || seen.has(id)) continue
            seen.add(id)
            sessions.push({
              id, title: '', createdAt: null,
              cwd: String(ws?.path ?? ''), live: false, subagent: false,
              workspaceTitle: String(ws?.title ?? ''),
            })
          }
        }
        return { source: 'workspaceRegistry', sessions: sessions.slice(0, SESSION_LIST_CAP) }
      } catch {
        /* 落到 none */
      }
    }
    return { source: 'none', sessions: [] }
  }

  /** 授权记录（审计）。 */
  grants(limit) {
    return this.scopes.grants(limit)
  }

  // ==================== 配置读写（设置页用） ====================

  /** 界面需要的完整编辑态（管理面：始终包含全部条目）。 */
  currentConfig() {
    const programs = (this.cfg.programs ?? []).map((program) => toPersistableProgram(program))
    return {
      revision: this.revision,
      path: this.store.path,
      hasUserLayer: this.store.hasUserLayer(),
      persisted: this.store.lastPersisted !== false,
      poolVersion: this.cfg.poolVersion,
      enabled: this.cfg.enabled,
      conflictPolicy: this.cfg.conflictPolicy,
      unreadableGpuPolicy: this.cfg.unreadableGpuPolicy,
      sampleCacheMs: this.cfg.sampleCacheMs,
      readyTimeoutMs: this.cfg.readyTimeoutMs,
      nvidiaSmi: this.cfg.nvidiaSmi,
      dryRun: this.cfg.dryRun,
      verbose: this.cfg.verbose,
      toolsMounted: this.toolsMounted,
      /** 尚未授权任何会话/工作区的条目数（界面提示用）。 */
      unauthCount: programs.filter((p) => (p.sessions ?? []).length === 0 && (p.workspaces ?? []).length === 0).length,
      /** 旧工作区授权还没展开（等宿主服务）时给界面一个说明。 */
      migrationPending: (this._pendingWorkspaceGrants ?? []).map((item) => item.workspacePath),
      // 界面把它当"可持久化的原始配置"整体回填；少了它，编辑态无从显示。
      programs,
    }
  }

  /** 保存原始配置（校验过的），落盘后立刻生效。 */
  saveRaw(rawConfig) {
    const stored = this.store.save(rawConfig)
    this.applyConfig(stored)
    return this.currentConfig()
  }

  setGlobal(patch) {
    const next = updateGlobal(this.store.load(), patch)
    return this.saveRaw(next)
  }

  // ==================== 会话级可见性 ====================

  /**
   * 在某个会话上下文里执行操作（设置页测试/管理操作用）。
   * 传 null/undefined 的 sessionId 表示回到管理面。
   */
  withScope(where, fn) {
    const previous = this._scopeContext
    this._scopeContext = where ? { sessionId: where.sessionId ? String(where.sessionId) : '' } : null
    try {
      return fn()
    } finally {
      this._scopeContext = previous
    }
  }

  /** 当前会话上下文：null=管理面；{sessionId}=工具面。 */
  scopeContext() {
    return this._scopeContext
  }

  /**
   * 在某个 agent 会话的作用域里执行操作。
   *
   * ★ 这是「授权热加载」的关键：每次 tool 调用都通过它带上调用者的 sessionId，
   * 于是设置页刚改的会话授权**下一次工具调用立刻生效**，
   * 不需要重开会话、不需要重启宿主。
   *
   * @param {object} exec tool 的 ToolRunContext（含 agent）
   * @param {Function} fn   要执行的操作
   */
  async withAgentScope(exec, fn) {
    const sessionId = exec?.agent?.id ? String(exec.agent.id) : ''
    const previous = this._scopeContext
    // sessionId 为空时保持 {sessionId:''} → 过滤结果为空（fail-closed），
    // 绝不退化成"管理面看全部"。
    this._scopeContext = { sessionId }
    try {
      return await fn()
    } finally {
      this._scopeContext = previous
    }
  }

  /** 当前上下文可见的全部条目（含目录）。管理面=全部；会话面=仅已授权。 */
  _visibleEntries() {
    const all = this.cfg.programs ?? []
    const ctx = this._scopeContext
    if (ctx === null || ctx === undefined) return all
    const sid = String(ctx.sessionId ?? '')
    if (sid === '') return []
    const ws = this.workspaceOfSession(sid)
    const wsKey = ws ? pathKey(ws.path) : null
    return all.filter((entry) => this._entryVisibleTo(entry, sid, wsKey))
  }

  /**
   * 条目是否对某会话可见：sessions 直接命中，或所属工作区在 workspaces 里。
   * 工作区授权是动态的——该工作区下之后新增的会话也自动可见。
   * @param {string|null} wsKey 会话所属工作区的 pathKey（null=未知工作区）
   */
  _entryVisibleTo(entry, sid, wsKey) {
    if ((entry.sessions ?? []).includes(sid)) return true
    if (wsKey === null) return false
    return (entry.workspaces ?? []).some((w) => pathKey(w) === wsKey)
  }

  /**
   * 当前可见的可启动条目（软件/脚本，不含目录）。
   * 所有查找程序的地方都应走这里，而不是直接读 this.cfg.programs。
   */
  visiblePrograms() {
    return this._visibleEntries().filter((entry) => entry.kind !== 'directory')
  }

  /** 当前可见的目录条目（授权浏览用）。 */
  visibleDirectories() {
    return this._visibleEntries().filter((entry) => entry.kind === 'directory')
  }

  /**
   * 按 id/name 查找当前作用域可见的程序。
   * @param {string} key
   * @param {{ sessionId?: string }} [where] 覆盖当前上下文
   */
  findVisibleProgram(key, where = null) {
    if (!where) return findProgram(this.visiblePrograms(), key)
    const sid = String(where.sessionId ?? '')
    if (sid === '') return null
    const ws = this.workspaceOfSession(sid)
    const wsKey = ws ? pathKey(ws.path) : null
    const pool = (this.cfg.programs ?? []).filter(
      (entry) => entry.kind !== 'directory' && this._entryVisibleTo(entry, sid, wsKey),
    )
    return findProgram(pool, key)
  }

  /**
   * 某个程序生效的授权目录 = 程序自己的 ∪ 当前可见的目录条目。
   * 没有全局兜底：目录条目同样要按会话授权。
   */
  allowedDirsOf(programId) {
    const program = programId ? this.findVisibleProgram(programId) : null
    const dirPaths = this.visibleDirectories().map((entry) => entry.path).filter((p) => p !== '')
    return mergeDirs(effectiveAllowedDirs(this.cfg, program), dirPaths)
  }

  /**
   * 传给 edit.mjs 的选项：允许测试注入路径探针（真实环境用默认 stat）。
   */
  editOptions() {
    const probe = this.deps.edit?.probe
    return probe ? { probe } : {}
  }

  /**
   * 列出授权范围内的目录内容。
   * 传 programId 时并入该程序自己的目录；目录条目 id 也可以传（只浏览目录池）。
   */
  async browse(target, programId) {
    const roots = this.allowedDirsOf(programId)
    return listAllowedDirectory(target, roots)
  }

  addEntry(entry) {
    const result = addProgram(this.store.load(), entry, this.editOptions())
    const saved = this.saveRaw(result.config)
    this.scopes.addGrant({
      scope: 'entry', scopeKey: result.program.id, kind: 'entry', action: 'add',
      target: (result.program.sessions ?? []).join('、') || '（未授权任何会话）',
      note: `新增${result.program.kind === 'directory' ? '目录' : result.program.kind === 'script' ? '脚本' : '软件'}条目`,
    })
    return { config: saved, program: result.program }
  }

  updateEntry(id, entry) {
    const before = (this.cfg.programs ?? []).find((p) => p.id === id)
    const result = updateProgram(this.store.load(), id, entry, this.editOptions())
    const saved = this.saveRaw(result.config)
    this._auditSessionDiff(id, before?.sessions ?? [], result.program.sessions ?? [], '修改条目')
    return { config: saved, program: result.program, previousId: result.previousId }
  }

  /**
   * 只改某个条目的会话授权（卡片上的「授权」按钮 / 会话菜单的快速开关）。
   * 不走整表校验，避免改授权时被无关条目的路径问题卡住。
   */
  setEntrySessions(id, sessions, note = '') {
    const result = this.setEntryGrants(id, { sessions }, note)
    return { config: result.config, sessions: result.sessions }
  }

  /** 只改某个条目的工作区授权。 */
  setEntryWorkspaces(id, workspaces, note = '') {
    const result = this.setEntryGrants(id, { workspaces }, note)
    return { config: result.config, workspaces: result.workspaces }
  }

  /**
   * 一次改某个条目的会话 + 工作区授权（授权弹框用）。
   * grants 里未提供的维度保持不变。不走整表校验。
   * @param {{ sessions?: string[], workspaces?: string[] }} grants
   */
  setEntryGrants(id, grants, note = '') {
    const raw = this.store.load()
    const programs = Array.isArray(raw.programs) ? raw.programs : []
    const index = programs.findIndex((p) => String(p?.id ?? '').trim() === id)
    if (index < 0) throw new ConfigValidationError(`找不到条目「${id}」`, 'id')
    const entry = programs[index]
    const sessionsBefore = normalizeSessions(entry.sessions)
    const wsBefore = normalizeWorkspaces(entry.workspaces)
    const next = { ...entry }
    let sessionsAfter = sessionsBefore
    let wsAfter = wsBefore
    if (grants.sessions !== undefined) {
      sessionsAfter = normalizeSessions(grants.sessions)
      next.sessions = sessionsAfter
    }
    if (grants.workspaces !== undefined) {
      wsAfter = normalizeWorkspaces(grants.workspaces)
      next.workspaces = wsAfter
    }
    const nextPrograms = programs.slice()
    nextPrograms[index] = next
    const saved = this.saveRaw({ ...raw, programs: nextPrograms })
    this._auditSessionDiff(id, sessionsBefore, sessionsAfter, note)
    this._auditWorkspaceDiff(id, wsBefore, wsAfter, note)
    return { config: saved, sessions: sessionsAfter, workspaces: wsAfter }
  }

  _auditSessionDiff(id, before, after, note) {
    const prev = normalizeSessions(before)
    const next = normalizeSessions(after)
    for (const sid of next.filter((s) => !prev.includes(s))) {
      this.scopes.addGrant({ scope: 'entry', scopeKey: id, kind: 'entry', action: 'add', target: sid, note })
    }
    for (const sid of prev.filter((s) => !next.includes(s))) {
      this.scopes.addGrant({ scope: 'entry', scopeKey: id, kind: 'entry', action: 'remove', target: sid, note })
    }
  }

  _auditWorkspaceDiff(id, before, after, note) {
    const prev = normalizeWorkspaces(before)
    const next = normalizeWorkspaces(after)
    const same = (a, b) => a.some((x) => pathKey(x) === pathKey(b))
    for (const w of next.filter((x) => !same(prev, x))) {
      this.scopes.addGrant({ scope: 'entry', scopeKey: id, kind: 'workspace', action: 'add', target: w, note })
    }
    for (const w of prev.filter((x) => !same(next, x))) {
      this.scopes.addGrant({ scope: 'entry', scopeKey: id, kind: 'workspace', action: 'remove', target: w, note })
    }
  }

  removeEntry(id) {
    const program = findProgram(this.cfg.programs ?? [], id)
    if (program && program.kind !== 'directory') {
      // 删除前先尽力停止本插件启动的进程，避免留下孤儿占着 GPU。
      const state = this.registry.stateOf(program.id)
      if (state.child) {
        stopProgram(program, state, (message) => this.log(message), this.deps.programs ?? {}).catch(() => {})
      }
    }
    const result = removeProgram(this.store.load(), id)
    const saved = this.saveRaw(result.config)
    this.scopes.addGrant({ scope: 'entry', scopeKey: id, kind: 'entry', action: 'remove', target: '条目删除' })
    return { config: saved }
  }

  resetConfig() {
    this.store.reset()
    this.cfg = resolveConfig(this.store.load())
    // 重置回种子后又是 poolVersion 1：再走一次迁移（切片已清空，只会补 kind/sessions=[]）
    this._migratePool()
    this.revision += 1
    this.snapshotCache = null
    this.syncToolMount()
    return this.currentConfig()
  }

  // ==================== 快照 / 生命周期 ====================

  /**
   * 状态快照。
   *
   * @param {object} options
   * @param {boolean} [options.fresh] 丢弃采样与快照缓存，强制重取
   * @param {boolean} [options.lazy]  懒加载：**不采样、不探针**，只给静态信息。
   *   设置页首次渲染用它，避免一打开就跑 nvidia-smi 而卡顿；
   *   资源检查改由「测试」按钮（fresh 非 lazy）与启动时的门控触发。
   */
  async snapshot({ fresh = false, lazy = false } = {}) {
    if (fresh) {
      this.snapshotCache = null
      this.sampler.invalidate()
    }
    // 缓存按会话上下文分键：管理面与某个会话的可见条目不同，不能互相复用。
    const ctx = this._scopeContext
    const cacheKey = ctx ? `session:${ctx.sessionId ?? ''}` : 'admin'
    // lazy 不读缓存（缓存里可能是完整快照，直接返回就等于做了采样）
    if (!lazy && this.snapshotCache && this.snapshotCache.key === cacheKey && Date.now() - this.snapshotCache.at < this.cfg.sampleCacheMs) {
      return this.snapshotCache.value
    }
    if (this.snapshotInflight) return this.snapshotInflight
    // 快照用**当前上下文可见的条目**：会话被授权的条目要能出现在 app_list 里，
    // 未授权的条目绝不能漏给别的会话。
    const scopedCfg = {
      ...this.cfg,
      programs: this.visiblePrograms(),
      allowedDirs: this.allowedDirsOf(undefined),
    }
    const directories = this.visibleDirectories().map((entry) => ({
      id: entry.id,
      name: entry.name,
      path: entry.path,
      sessions: (entry.sessions ?? []).slice(),
      workspaces: (entry.workspaces ?? []).slice(),
      description: entry.description,
      enabled: entry.enabled,
    }))
    this.snapshotInflight = statusSnapshot(scopedCfg, this.registry, this.sampler, {
      log: (message) => this.log(message),
      deps: this.deps.status ?? {},
      lazy,
    })
      .then((value) => {
        value.directories = directories
        // lazy 结果不进缓存：否则下次完整查询会误用这份"未采样"的快照
        if (!lazy) this.snapshotCache = { at: Date.now(), key: cacheKey, value }
        return value
      })
      .finally(() => {
        this.snapshotInflight = null
      })
    return this.snapshotInflight
  }

  async requestStart(id) {
    const program = this._requireProgram(id)
    if (!program.valid) throw new Error(`${program.name} 配置不完整：${program.invalidReason}`)
    if (!program.enabled) throw new Error(`${program.name} 已在配置里禁用（enabled=false），不启动`)
    if (!this.cfg.enabled) throw new Error('插件已全局禁用：不会启动任何程序（可先调用 app_toggle 或到设置页启用）')
    // 只能手动启动的程序：直接说清楚，不让用户白等一轮超时
    if (program.launchable === false) {
      throw new Error(
        `${program.name} 需要手动启动。${program.launchHint || '该程序只能从桌面会话启动，本插件无法在后台拉起它。'}（本插件仍会检测它的运行状态并允许停止）`,
      )
    }

    const state = this.registry.stateOf(program.id)
    if (state.inflight) {
      return { accepted: true, started: false, phase: 'starting', gate: null, reason: '已有启动流程在跑，复用同一次', suggestions: [] }
    }

    const snapshot = await this.snapshot({ fresh: true })
    const gate = snapshot.gates?.[program.id] ?? null

    if (gate?.action === 'already-running') {
      return { accepted: true, started: false, phase: 'ready', gate, reason: null, suggestions: [] }
    }
    if (!gate || !gate.ok) {
      return {
        accepted: false,
        started: false,
        phase: 'rejected',
        gate,
        reason: gate?.reason ?? '无法判定资源是否空闲',
        suggestions: gate?.suggestions ?? [],
      }
    }

    for (const otherId of gate.stopFirst ?? []) {
      const other = this.findVisibleProgram(otherId)
      if (!other) continue
      this.log(`互斥：先停止 ${other.name}（本插件启动的）`)
      await stopProgram(other, this.registry.stateOf(other.id), (message) => this.log(message), this.deps.programs ?? {})
    }
    if ((gate.stopFirst ?? []).length > 0) this.sampler.invalidate()

    const record = { inFlight: true, requestedAt: Date.now(), finishedAt: null, error: null, result: null }
    this.startStates.set(program.id, record)
    state.starting = true

    ensureRunning(program, state, { dryRun: this.cfg.dryRun, log: (message) => this.log(message) })
      .then((result) => {
        this.startStates.set(program.id, { ...record, inFlight: false, finishedAt: Date.now(), result })
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.log(`启动 ${program.name} 失败：${message}`)
        this.startStates.set(program.id, { ...record, inFlight: false, finishedAt: Date.now(), error: message })
      })
      .finally(() => {
        state.starting = false
        this.sampler.invalidate()
        this.snapshotCache = null
      })

    return {
      accepted: true,
      started: true,
      phase: 'starting',
      gate,
      reason: null,
      suggestions: gate.suggestions ?? [],
      dryRun: this.cfg.dryRun,
    }
  }

  async waitStart(id, timeoutMs) {
    const program = this.findVisibleProgram(id)
    if (!program) return null
    const budget = Math.max(0, Number(timeoutMs) || 0)
    const deadline = Date.now() + budget
    while (Date.now() < deadline) {
      const record = this.startStates.get(program.id)
      if (record && !record.inFlight) {
        return {
          ok: record.error === null,
          error: record.error,
          result: record.result,
          elapsedMs: record.finishedAt ? record.finishedAt - record.requestedAt : null,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const record = this.startStates.get(program.id)
    if (record && !record.inFlight) {
      return { ok: record.error === null, error: record.error, result: record.result }
    }
    return { ok: false, error: `等待 ${program.name} 就绪超过 ${budget}ms，仍在后台启动中`, pending: true }
  }

  async requestStop(id) {
    const program = this._requireProgram(id)
    if (!this.cfg.enabled) throw new Error('插件已全局禁用：不会停止任何程序')

    const state = this.registry.stateOf(program.id)
    const result = await stopProgram(program, state, (message) => this.log(message), this.deps.programs ?? {})
    this.sampler.invalidate()
    this.snapshotCache = null
    if (result.stopped) this.startStates.delete(program.id)
    return result
  }

  /**
   * 验证程序的实际状态（只读，不动任何进程）。
   *
   * 这是插件自己的职责：停止/启动之后由插件给出独立证据，而不是让外面
   * 提权跑 netstat / Get-Process 去核对。
   *
   * @param {string} [id]      只验证一个程序；省略则验证全部
   * @param {string} [expect]  'stopped'（默认）| 'running'
   */
  async verify(id, expect = 'stopped') {
    const want = expect === 'running' ? 'running' : 'stopped'
    const programsDeps = this.deps.programs ?? {}
    const deps = { ...programsDeps, sysinfo: this.deps.sysinfo }
    if (id === undefined || id === '') {
      // 目录条目没有进程可验；只验当前可见的可启动条目
      return verifyAll({ ...this.cfg, programs: this.visiblePrograms() }, { expect: want, deps })
    }
    const program = this._requireProgram(id)
    return verifyProgram(program, { expect: want, deps })
  }

  readLog(id, lines) {
    const program = this.findVisibleProgram(id)
    if (!program) return { error: `未知程序：${id}` }
    const tail = readLogTail(program, lines ?? this.cfg.logTailLines)
    return tail
      ? { path: program.logFile, lines: tail.tail, size: tail.size, mtime: tail.mtime }
      : { path: program.logFile, lines: [], size: 0, mtime: null }
  }

  listPrograms() {
    return (this.cfg.programs ?? []).map((program) => ({
      id: program.id,
      name: program.name,
      kind: program.kind,
      sessions: (program.sessions ?? []).slice(),
      workspaces: (program.workspaces ?? []).slice(),
      path: program.path,
      enabled: program.enabled,
      valid: program.valid,
      invalidReason: program.invalidReason,
      description: program.description,
      exclusive: program.exclusive,
      needs: program.needs,
      exe: program.launch.exe,
      readyUrl: program.ready.url,
    }))
  }

  _requireProgram(id) {
    // 走会话感知查找：只有授权给当前会话的条目才能被 app_start 找到
    const program = this.findVisibleProgram(id)
    if (!program) {
      const ids = this.visiblePrograms().map((item) => `${item.id}(${item.name})`).join('、')
      throw new Error(
        `未知程序：${id}。当前会话可见的程序：${ids || '（无）'}。` +
        '若条目存在但未授权给本会话，请到设置页「软件/脚本/目录」里把它授权给本会话。',
      )
    }
    return program
  }
}

export { ConfigValidationError }
