// client.cards.js — dsh-app-launcher 客户端 chunk（单一职责）。由 client.js 组合根经 require.async 加载，build(deps) 显式接收依赖。
window.__ModuleLoader__.load({
  id: 'dsh-app-launcher',
  chunk: 'client.cards.js',
  factory(require) {
    function build({ h, core, controls }) {
      const { S, PHASE, describeNeeds, formatMiB, formatClock } = core
      const { Pill } = controls

    // ==================== 应用卡片 ====================
    function AppCard({ program, logInfo, gate, editing, onEdit, onDelete, onStart, onStop, onVerify, onAuth, verifyResult, busy, confirmStop, setConfirmStop, t }) {
      const phase = PHASE[program.phase] ?? { key: 'phase_unknown', tone: 'muted' }
      const gateRunning = gate?.action === 'already-running'
      const gateOk = gate?.ok === true && !gateRunning
      // launchable=false 的程序（只能从桌面启动）不显示可点的启动按钮；
      // 但状态检测与停止照常 —— 它被人启动后我们仍要能认出来并可停。
      const manualOnly = program.launchable === false
      const canStart = program.enabled && program.valid && !manualOnly &&
        !gateRunning && gateOk && program.phase !== 'ready' && !busy
      const canStop = program.canStop && program.phase !== 'stopped'

      const pills = [
        h(Pill, { key: 'k', tone: 'muted' }, t(program.kind === 'script' ? 'kind_script' : 'kind_program')),
        h(Pill, { key: 'p', tone: phase.tone }, t(phase.key)),
      ]
      if (!program.enabled) pills.push(h(Pill, { key: 'd', tone: 'muted' }, t('disabled')))
      if (!program.valid) pills.push(h(Pill, { key: 'i', tone: 'error', title: program.invalidReason ?? '' }, t('invalid')))
      if (manualOnly) pills.push(h(Pill, { key: 'm', tone: 'warn', title: program.launchHint ?? '' }, t('manualOnly')))
      if (gateRunning) pills.push(h(Pill, { key: 'g', tone: 'brand' }, t('gate_running')))
      else if (program.enabled && program.valid) {
        pills.push(h(Pill, { key: 'g', tone: gateOk ? 'success' : 'warn', title: gate?.reason ?? '' }, gateOk ? t('gate_ok') : t('gate_block')))
      }
      // 会话授权概览：0 个会话＝对所有会话不可见，必须醒目提示
      const sessions = program.sessions ?? []
      pills.push(sessions.length === 0
        ? h(Pill, { key: 's', tone: 'warn', title: t('authTip') }, t('sessionsNone'))
        : h(Pill, { key: 's', tone: 'brand', title: sessions.join('\n') }, t('sessionsCount').replace('{n}', sessions.length)))

      return h('div', { style: S.appCard },
        h('div', { style: S.appTop },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0, flex: '1 1 180px' } },
            h('div', { style: S.appName }, program.name),
            program.description ? h('div', { style: S.appDesc }, program.description) : null),
          h('div', { style: S.actions },
            h('button', {
              style: { ...S.btnPrimary, ...(canStart ? {} : S.btnOff) },
              disabled: !canStart,
              onClick: () => onStart(program.id),
            }, busy === `${program.id}:start` ? `${t('start')}…` : t('start')),
            h('button', {
              style: { ...(confirmStop === program.id ? S.btnDanger : S.btn), ...(canStop ? {} : S.btnOff) },
              disabled: !canStop,
              title: program.stopBlockedReason ?? '',
              onClick: () => {
                if (confirmStop === program.id) { onStop(program.id); setConfirmStop(null) } else setConfirmStop(program.id)
              },
            }, confirmStop === program.id ? t('stopConfirm') : t('stop')),
            h('button', {
              style: S.btn,
              disabled: Boolean(busy) || !program.enabled || !program.valid,
              title: t('verifyHint'),
              onClick: () => onVerify(program.id),
            }, busy === `${program.id}:verify` ? `${t('verify')}…` : t('verify')),
            h('button', { style: S.btn, title: t('authTip'), onClick: () => onAuth(program.id) }, t('authBtn')),
            h('button', { style: S.btn, onClick: () => onEdit(editing ? null : program.id) }, editing ? t('cancel') : t('edit')),
            h('button', { style: S.btnDanger, onClick: () => onDelete(program.id) }, t('del'))),
        ),

        // 字段竖向排列，不会横向溢出
        h('div', { style: S.pathLine, title: program.launch?.exe ?? '' }, program.launch?.exe ?? '—'),
        h('div', { style: S.pills }, pills),
        h('div', { style: S.tiny }, `${t('f_needs')}: ${describeNeeds(program.needs, t)}`),
        manualOnly
          ? h('div', { style: S.hint }, `${t('manualOnlyHint')}${program.launchHint ? ` ${program.launchHint}` : ''}`)
          : null,
        program.stopBlockedReason && program.running ? h('div', { style: S.tinyWarn }, program.stopBlockedReason) : null,
        gate?.ok === false && !gateRunning && program.enabled && !manualOnly ? h('div', { style: S.tinyWarn }, gate.reason) : null,

        // 验证结果：把三条独立证据（端口 / 进程 / 探针）逐条摊开，
        // 用户不用去外面跑 netstat 也能确认"到底停干净没有"。
        verifyResult
          ? h('div', { style: verifyResult.ok ? S.hint : S.tinyWarn },
            h('div', { style: { fontWeight: 600 } },
              `${t('verifyResult')}: ${verifyResult.ok ? t('verifyPass') : t('verifyFail')}` +
              (verifyResult.verdict === 'unknown' ? `（${t('verifyUnknown')}）` : '')),
            ...(verifyResult.evidence ?? []).map((ev, index) =>
              h('div', { key: `ev${index}`, style: S.tiny }, `${ev.ok === null ? '·' : ev.ok ? '✓' : '✗'} ${ev.detail}`)),
            (verifyResult.problems ?? []).length > 0
              ? h('div', { style: S.tiny }, `${t('verifyProblems')}: ${verifyResult.problems.join('；')}`)
              : null)
          : null,

        logInfo
          ? h('details', { style: { padding: '2px 0' } },
            h('summary', { style: S.summary }, t('log')),
            h('pre', { style: S.pre }, (logInfo.tail ?? []).length > 0 ? logInfo.tail.join('\n') : t('logEmpty')))
          : null)
    }

    // ==================== 目录条目卡片 ====================
    /** 目录条目：没有启动/停止/验证，只有路径 + 会话授权 + 编辑/删除。 */
    function DirectoryCard({ entry, t, editing, onEdit, onDelete, onAuth }) {
      const sessions = entry.sessions ?? []
      return h('div', { style: S.appCard },
        h('div', { style: S.appTop },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0, flex: '1 1 180px' } },
            h('div', { style: S.appName }, entry.name || entry.id),
            entry.description ? h('div', { style: S.appDesc }, entry.description) : null),
          h('div', { style: S.actions },
            h('button', { style: S.btn, title: t('authTip'), onClick: () => onAuth(entry.id) }, t('authBtn')),
            h('button', { style: S.btn, onClick: () => onEdit(editing ? null : entry.id) }, editing ? t('cancel') : t('edit')),
            h('button', { style: S.btnDanger, onClick: () => onDelete(entry.id) }, t('del')))),
        h('div', { style: S.pathLine, title: entry.path ?? '' }, entry.path ?? '—'),
        h('div', { style: S.pills },
          h(Pill, { tone: 'muted' }, t('kind_directory')),
          entry.enabled === false ? h(Pill, { tone: 'muted' }, t('disabled')) : null,
          sessions.length === 0
            ? h(Pill, { tone: 'warn', title: t('authTip') }, t('sessionsNone'))
            : h(Pill, { tone: 'brand', title: sessions.join('\n') }, t('sessionsCount').replace('{n}', sessions.length))))
    }

    // ==================== 资源条 ====================
    /**
     * 资源卡。
     *
     * 懒加载：未测试时 `system.lazy` 为 true、各项为 null，显示「未检查」，
     * 不显示假的 0%；用户点「测试」后才做完整采样。
     */
    function SystemCard({ system, t, onProbe, checking }) {
      const unchecked = system?.lazy === true
      const gpu = system?.gpu ?? {}
      const mem = system?.memory ?? {}
      const cpu = system?.cpu ?? {}
      const holders = system?.gpuHolders ?? []

      const pills = unchecked
        ? [h(Pill, { key: 'unchecked', tone: 'muted' }, t('notCheckedYet'))]
        : [
          h(Pill, {
            key: 'gpu',
            tone: !gpu.available ? 'muted' : gpu.utilPct >= 50 ? 'warn' : 'success',
          }, `${t('f_gpu')}: ${gpu.available ? `${gpu.name ?? 'GPU'} · ${gpu.utilPct}% · ${formatMiB(gpu.freeMiB)} free` : (gpu.reason ?? '—')}`),
          h(Pill, { key: 'cpu', tone: cpu.pct >= 80 ? 'warn' : 'success' }, `${t('f_cpu')}: ${cpu.pct ?? '—'}%`),
          h(Pill, {
            key: 'mem',
            tone: (mem.freeMiB && mem.totalMiB && mem.freeMiB / mem.totalMiB < 0.15) ? 'warn' : 'success',
          }, `${t('f_mem')}: ${formatMiB(mem.freeMiB)} / ${formatMiB(mem.totalMiB)}`),
        ]

      let holdersBlock = null
      if (holders.length > 0) {
        const chips = holders.slice(0, 6).map((item) => h(Pill, { key: String(item.pid), tone: 'brand' },
          `${item.name} · ${formatMiB(item.usedMiB)}`))
        holdersBlock = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('div', { style: S.tiny }, t('f_holders')),
          h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } }, chips))
      }

      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          t('sec_system'),
          h('div', { style: S.actions },
            unchecked ? h('span', { style: S.tiny }, t('lazyTip')) : null,
            h('span', { style: S.tiny }, formatClock(system?.at) ?? ''),
            h('button', {
              style: { ...S.btn, padding: '2px 10px', ...(checking ? S.btnOff : {}) },
              type: 'button',
              disabled: checking,
              title: t('testTip'),
              onClick: onProbe,
            }, checking ? t('testing') : t('test')))),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, pills),
        holdersBlock)
    }

    // ==================== 主体 ====================
    // ==================== 弹框（覆盖层） ====================

      return { AppCard, DirectoryCard, SystemCard }
    }
    return { build }
  },
})
