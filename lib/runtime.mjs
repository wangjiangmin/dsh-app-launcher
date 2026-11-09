/**
 * dsh-app-launcher — 运行时。
 *
 * 把「配置存储 / 采样 / 程序生命周期 / 状态快照 / 工具挂载」串成一体，
 * 供 tool（lib/tools.mjs）与设置页 HTTP 接口（lib/http.mjs）共用。
 *
 * 关键契约：
 * - **配置持久化**：用户层 $DSH_HOME/app-launcher/config.json，界面改完立刻生效；
 * - **动态生效**（需求 6）：全局 enabled 切换时，直接注册/注销 4 个 tool。tool 注册表
 *   是全局的，注册后**所有会话（含已开着的旧会话）下一次取工具表时就能看到**；
 * - **启动必须先过门控**：结论取自 statusSnapshot.gates[id]，与界面完全同一份；
 * - **停止只停本插件启动的进程**。
 */
import { addProgram, ConfigValidationError, normalizeSubmittedEntry, removeProgram, updateGlobal, updateProgram } from './edit.mjs'
import { listAllowedDirectory } from './browse.mjs'
import { createConfigStore, programToPersistable as toPersistableProgram } from './store.mjs'
import { effectiveAllowedDirs, findProgram, resolveConfig } from './config.mjs'
import { createRegistry, ensureRunning, readLogTail, stopProgram } from './programs.mjs'
import { statusSnapshot } from './status.mjs'
import { createSampler } from './sysinfo.mjs'
import { verifyAll, verifyProgram } from './verify.mjs'

export class LauncherRuntime {
  /**
   * @param {object} options
   * @param {object} options.seed      来自 patch 的种子配置
   * @param {Function} options.log
   * @param {object} options.deps      测试注入
   * @param {Function} options.mountTools    (runtime) => dispose[]，注册 4 个 tool
   * @param {Function} options.unmountTools  (disposers) => void
   */
  constructor({ seed = {}, log = () => {}, deps = {}, mountTools = null, unmountTools = null, dataDir = null } = {}) {
    this.log = log
    this.deps = deps
    this.mountTools = mountTools
    this.unmountTools = unmountTools

    const provisional = resolveConfig(seed)
    // dataDir 可显式指定：测试要隔离到临时目录，生产走 $DSH_HOME/app-launcher。
    this.store = createConfigStore({ seed, dataDir: dataDir ?? provisional.dataDir })
    this.cfg = resolveConfig(this.store.load())
    this.registry = createRegistry()
    this.sampler = this._makeSampler()
    this.startStates = new Map()
    this.snapshotCache = null
    this.snapshotInflight = null
    /** 当前已挂载的 tool disposers；null = 未挂载。 */
    this.toolDisposers = null
    /** 配置版本号：每次保存 +1，界面用它判断是否需要刷新。 */
    this.revision = 0

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
      this.log(`全局启用：已挂载 4 个 tool（新会话与已开着的会话都可直接调用）`)
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
      this.log('全局禁用：已注销 4 个 tool（现有会话不会再看到它们）')
      return true
    }
    return false
  }

  /** 当前 tool 是否可见。 */
  get toolsMounted() {
    return this.toolDisposers !== null
  }

  // ==================== 配置读写（设置页用） ====================

  /** 界面需要的完整编辑态。 */
  currentConfig() {
    return {
      revision: this.revision,
      path: this.store.path,
      hasUserLayer: this.store.hasUserLayer(),
      persisted: this.store.lastPersisted !== false,
      enabled: this.cfg.enabled,
      conflictPolicy: this.cfg.conflictPolicy,
      unreadableGpuPolicy: this.cfg.unreadableGpuPolicy,
      sampleCacheMs: this.cfg.sampleCacheMs,
      readyTimeoutMs: this.cfg.readyTimeoutMs,
      nvidiaSmi: this.cfg.nvidiaSmi,
      dryRun: this.cfg.dryRun,
      verbose: this.cfg.verbose,
      toolsMounted: this.toolsMounted,
      /** 授权目录白名单：设置页的文件浏览器只能在这些目录内活动。 */
      allowedDirs: (this.cfg.allowedDirs ?? []).slice(),
      // 界面把它当"可持久化的原始配置"整体回填；少了它，编辑态无从显示。
      programs: (this.cfg.programs ?? []).map((program) => toPersistableProgram(program)),
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

  // ==================== 授权目录 / 文件浏览 ====================

  /** 某个程序生效的授权目录（程序自己的 ∪ 全局兜底）。 */
  allowedDirsOf(programId) {
    const program = programId ? findProgram(this.cfg.programs, programId) : null
    return effectiveAllowedDirs(this.cfg, program)
  }

  /**
   * 传给 edit.mjs 的选项：允许测试注入路径探针（真实环境用默认 stat）。
   */
  editOptions() {
    const probe = this.deps.edit?.probe
    return probe ? { probe } : {}
  }

  /**
   * 列出某个程序授权范围内的目录内容。
   *
   * 授权目录跟着程序走：传了 programId 就只在该程序的目录里浏览，
   * 不传则用全局兜底（兼容旧调用）。
   */
  async browse(target, programId) {
    const roots = this.allowedDirsOf(programId)
    return listAllowedDirectory(target, roots)
  }

  /** 改全局兜底授权目录（所有程序都能用）。 */
  setAllowedDirs(dirs) {
    const next = updateGlobal(this.store.load(), { allowedDirs: dirs })
    return { config: this.saveRaw(next) }
  }

  addEntry(entry) {
    const result = addProgram(this.store.load(), entry, this.editOptions())
    return { config: this.saveRaw(result.config), program: result.program }
  }

  updateEntry(id, entry) {
    const result = updateProgram(this.store.load(), id, entry, this.editOptions())
    const saved = this.saveRaw(result.config)
    return { config: saved, program: result.program, previousId: result.previousId }
  }

  removeEntry(id) {
    const program = findProgram(this.cfg.programs, id)
    if (program) {
      // 删除前先尽力停止本插件启动的进程，避免留下孤儿占着 GPU。
      const state = this.registry.stateOf(program.id)
      if (state.child) {
        stopProgram(program, state, (message) => this.log(message), this.deps.programs ?? {}).catch(() => {})
      }
    }
    const result = removeProgram(this.store.load(), id)
    return { config: this.saveRaw(result.config) }
  }

  resetConfig() {
    const seed = this.store.reset()
    this.applyConfig(seed)
    return this.currentConfig()
  }

  // ==================== 快照 / 生命周期 ====================

  async snapshot({ fresh = false } = {}) {
    if (fresh) {
      this.snapshotCache = null
      this.sampler.invalidate()
    }
    if (this.snapshotCache && Date.now() - this.snapshotCache.at < this.cfg.sampleCacheMs) {
      return this.snapshotCache.value
    }
    if (this.snapshotInflight) return this.snapshotInflight
    this.snapshotInflight = statusSnapshot(this.cfg, this.registry, this.sampler, {
      log: (message) => this.log(message),
      deps: this.deps.status ?? {},
    })
      .then((value) => {
        this.snapshotCache = { at: Date.now(), value }
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
      const other = findProgram(this.cfg.programs, otherId)
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
    const program = findProgram(this.cfg.programs, id)
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
      return verifyAll(this.cfg, { expect: want, deps })
    }
    const program = this._requireProgram(id)
    return verifyProgram(program, { expect: want, deps })
  }

  readLog(id, lines) {
    const program = findProgram(this.cfg.programs, id)
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
    const program = findProgram(this.cfg.programs, id)
    if (!program) {
      const ids = (this.cfg.programs ?? []).map((item) => `${item.id}(${item.name})`).join('、')
      throw new Error(`未知程序：${id}。已配置的程序：${ids || '（无）'}`)
    }
    return program
  }
}

export { ConfigValidationError }
