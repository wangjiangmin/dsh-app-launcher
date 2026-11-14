// client.panel.js — dsh-app-launcher 客户端 chunk（单一职责）。由 client.js 组合根经 require.async 加载，build(deps) 显式接收依赖。
window.__ModuleLoader__.load({
  id: 'dsh-app-launcher',
  chunk: 'client.panel.js',
  factory(require) {
    function build({ React, h, core, controls, cards, sessions, form, hooks, ctxGet }) {
      const { S, TONES, NS, noticeTone, post, get } = core
      const { ErrorBoundary, Switch, Modal } = controls
      const { AppCard, DirectoryCard, SystemCard } = cards
      const { SessionAuthDialog, GrantsLog, SessionGrantPanel } = sessions
      const { emptyForm, toForm, ProgramForm } = form
      const { useStatus, useConfig } = hooks

    function LauncherSection({ t }) {
      // live=false 时只取懒快照（秒开）；点「测试」或有程序在跑才切完整模式
      const [live, setLive] = React.useState(false)
      const { data, error, refresh, probe, checking } = useStatus(live)
      const { config, refresh: refreshConfig } = useConfig()
      const [busy, setBusy] = React.useState(null)
      const [confirmStop, setConfirmStop] = React.useState(null)
      const [verifyResults, setVerifyResults] = React.useState({})
      const [editing, setEditing] = React.useState(null) // 'new:program'|'new:script'|'new:directory' | 条目 id | null
      const [authDialog, setAuthDialog] = React.useState(null) // 条目 id：会话授权弹框
      const [notice, setNotice] = React.useState(null)
      const [formNotice, setFormNotice] = React.useState(null)
      const [confirmDelete, setConfirmDelete] = React.useState(null)
      const [confirmReset, setConfirmReset] = React.useState(false)

      const run = async (fn, okText) => {
        setNotice(null)
        try {
          const res = await fn()
          const body = res.body ?? {}
          if (!res.ok) {
            setNotice({ tone: 'error', text: body.error ?? `HTTP ${res.status}` })
            return null
          }
          setNotice({ tone: 'success', text: okText ?? t('savedTip') })
          await Promise.all([refresh(), refreshConfig()])
          return body
        } catch (err) {
          setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err) })
          return null
        }
      }

      const toggleGlobal = async (next) => {
        setBusy('global')
        await run(() => post('/config/global', { patch: { enabled: next } }), next ? t('globalTipOn') : t('globalTipOff'))
        setBusy(null)
      }

      if (!data) {
        return h('div', { style: S.wrap },
          h('div', { style: S.card },
            error ? h('div', { style: noticeTone('error') }, `${t('connFail')}：${error}`) : h('div', { style: S.sub }, '…')))
      }

      const plugin = data.plugin ?? {}
      const gates = data.gates ?? {}
      const logs = data.logs ?? {}
      const dryRun = plugin.dryRun === true
      const globalEnabled = plugin.enabled !== false
      const cfg = config ?? {}
      // ★ 统一条目池：列表以配置全池为准（含目录条目与 sessions 字段），
      //   运行态（phase/日志/门控）按 id 从状态快照合并进来。
      const entries = cfg.programs ?? []
      const liveById = new Map((data.programs ?? []).map((p) => [p.id, p]))
      const isNewEditing = typeof editing === 'string' && editing.startsWith('new:')
      const newKind = isNewEditing ? editing.slice(4) : 'program'

      const saveNew = async (entry) => {
        setBusy('form')
        setFormNotice(null)
        const body = await run(() => post('/config/program', { entry }), t('savedTip'))
        setBusy(null)
        if (body) { setEditing(null); setFormNotice(null) } else setFormNotice(t('saveFail'))
      }

      const saveEdit = async (id, entry) => {
        setBusy('form')
        const body = await run(() => post('/config/program', { id, entry }, 'PATCH'), t('savedTip'))
        setBusy(null)
        if (body) setEditing(null)
      }

      const deleteProgram = async (id) => {
        if (confirmDelete !== id) { setConfirmDelete(id); return }
        setConfirmDelete(null)
        await run(() => post('/config/program', { id }, 'DELETE'), t('savedTip'))
      }

      // ---- 头部：全局开关 ----
      const header = h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('div', { style: S.head },
            h('div', { style: S.title }, t('title')),
            h('div', { style: S.sub }, t('subtitle'))),
          h('div', { style: S.actions },
            h('button', { style: S.btn, onClick: refresh }, t('refresh')),
            confirmReset
              ? h('button', {
                style: S.btnDanger,
                onClick: async () => { setConfirmReset(false); await run(() => post('/config/reset'), t('savedTip')) },
              }, t('resetConfirm'))
              : h('button', { style: S.btn, onClick: () => setConfirmReset(true) }, t('reset')))),
        h('div', { style: S.switchRow },
          h(Switch, { checked: globalEnabled, onChange: toggleGlobal, label: globalEnabled ? t('globalOn') : t('globalOff') }),
          h('span', { style: { fontSize: '12px', fontWeight: 600, color: globalEnabled ? TONES.success.color : TONES.muted.color } },
            globalEnabled ? t('globalOn') : t('globalOff')),
          busy === 'global' ? h('span', { style: S.tiny }, '…') : null),
        h('div', { style: S.hint }, globalEnabled ? t('globalTipOn') : t('globalTipOff')),
        dryRun ? h('div', { style: noticeTone('warn') }, t('dryRunOn')) : null,
        cfg.migrationPending ? h('div', { style: noticeTone('warn') }, t('migrationPending')) : null,
        (cfg.unauthCount ?? 0) > 0
          ? h('div', { style: noticeTone('warn') }, t('unauthNotice').replace('{n}', String(cfg.unauthCount)))
          : null,
        cfg.path ? h('div', { style: S.tiny }, `${t('cfgPath')}: ${cfg.path}`) : null,
        notice ? h('div', { style: noticeTone(notice.tone) }, notice.text) : null)

      // ---- 软件/脚本/目录 列表（统一条目池） ----
      const openAuth = (id) => setAuthDialog(id)
      const list = h('div', { style: S.card },
        h('div', { style: S.cardHead },
          t('sec_programs'),
          h('div', { style: S.actions },
            h('button', {
              style: S.btnPrimary,
              onClick: () => setEditing('new:program'),
            }, t('addProgram')),
            h('button', {
              style: S.btn,
              onClick: () => setEditing('new:script'),
            }, t('addScript')),
            h('button', {
              style: S.btn,
              onClick: () => setEditing('new:directory'),
            }, t('addDirectory')))),
        entries.length === 0 ? h('div', { style: S.sub }, t('empty')) : null,
        entries.map((entry) => {
          if (entry.kind === 'directory') {
            return h(DirectoryCard, {
              key: entry.id,
              entry,
              t,
              editing: editing === entry.id,
              onEdit: (next) => setEditing(next),
              onDelete: deleteProgram,
              onAuth: openAuth,
            })
          }
          // 配置条目 + 运行态快照按 id 合并（快照里没有的字段以配置为准）
          const program = { ...entry, ...(liveById.get(entry.id) ?? {}) }
          return h(React.Fragment, { key: entry.id },
            h(AppCard, {
              program,
              logInfo: logs[entry.id],
              gate: gates[entry.id],
              editing: editing === entry.id,
              busy,
              confirmStop,
              setConfirmStop,
              t,
              onEdit: (next) => setEditing(next),
              onDelete: deleteProgram,
              onAuth: openAuth,
              onStart: async (id) => {
                // 启动后需要看进度与状态，切到完整模式（含轮询）
                setLive(true)
                setBusy(`${id}:start`)
                await run(() => post('/start', { id }), t('startedTip'))
                setBusy(null)
              },
              onStop: async (id) => {
                setBusy(`${id}:stop`)
                const body = await run(() => post('/stop', { id }), t('stop'))
                if (body && body.ok === false) setNotice({ tone: 'error', text: body.result?.reason ?? t('stop') })
                setBusy(null)
              },
              onVerify: async (id) => {
                setBusy(`${id}:verify`)
                const body = await run(() => get(`/verify?id=${encodeURIComponent(id)}`), t('verify'))
                setBusy(null)
                if (body && body.ok !== undefined) {
                  setVerifyResults((prev) => ({ ...prev, [id]: body }))
                }
              },
              verifyResult: verifyResults[entry.id],
            }))
        }))
      // 编辑 / 新建表单统一用弹框（不再在列表里内联展开）：
      // 列表可能很长，内联表单会被挤到看不见的位置。
      const newTitleKey = newKind === 'script' ? 'addScript' : newKind === 'directory' ? 'addDirectory' : 'addProgram'
      const formDialog = editing === null
        ? null
        : h(Modal, {
          title: isNewEditing ? t(newTitleKey) : t('edit'),
          width: '720px',
          onClose: () => setEditing(null),
          t,
        },
        h(ErrorBoundary, { key: `form-${editing}` },
          h(ProgramForm, {
            initial: isNewEditing
              ? { ...emptyForm(), kind: newKind }
              : toForm(entries.find((p) => p.id === editing) ?? {}),
            isNew: isNewEditing,
            busy: busy === 'form',
            notice: formNotice,
            t,
            onCancel: () => setEditing(null),
            onSave: isNewEditing
              ? saveNew
              : (entry) => saveEdit(editing, entry),
          })))

      // 会话授权弹框：只改 sessions，不动条目其它字段
      const authEntry = authDialog === null ? null : (entries.find((p) => p.id === authDialog) ?? null)
      const authModal = authEntry === null
        ? null
        : h(Modal, {
          title: `${t('authTitle')} · ${authEntry.name || authEntry.id}`,
          width: '640px',
          onClose: () => setAuthDialog(null),
          t,
        },
        h(ErrorBoundary, { key: `auth-${authDialog}` },
          h(SessionAuthDialog, {
            entry: authEntry,
            t,
            onClose: () => setAuthDialog(null),
            onSaved: async () => { await Promise.all([refresh(), refreshConfig()]) },
          })))

      return h('div', { style: S.wrap },
        header,
        formDialog,
        authModal,
        h(SystemCard, {
          system: data.system,
          t,
          checking,
          // 点「测试」：先切到完整模式（这样后续会轮询），再强制取样
          onProbe: async () => {
            setLive(true)
            await probe()
          },
        }),
        list,
        // 授权记录（审计）：三层作用域切片已废除，只剩条目级会话授权记录
        h('div', { style: S.card },
          h(GrantsLog, { t })))
    }


    // ==================== 会话入口按钮 ====================

    /**
     * 会话「...」菜单里的一行：打开「本会话授权」面板。
     *
     * 放在这里而不是侧边栏别处，是因为这是唯一开放给插件的会话菜单扩展点，
     * 官方已在此放了 pin/rename/fork/archive；我们的行排在 archive 之后。
     */
    function MenuScopeRow({ t, sessionId }) {
      const [open, setOpen] = React.useState(false)
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          role: 'menuitem',
          style: {
            display: 'block', width: '100%', textAlign: 'left',
            font: 'inherit', fontSize: '12px', cursor: 'pointer',
            padding: '5px 10px', border: 'none', background: 'transparent',
            color: 'var(--dsw-alias-label-primary)', borderRadius: '4px',
          },
          onClick: (e) => { e.stopPropagation(); setOpen(true) },
        }, `${t('thisSessionAuth')}`),
        open
          ? h(Modal, { title: t('thisSessionAuth'), width: '680px', onClose: () => setOpen(false), t },
            h(SessionGrantPanel, { sessionId: String(sessionId ?? ''), t }))
          : null)
    }

    /** 会话顶部入口：点了弹出「本会话授权」面板（逐条目开关）。 */
    function SessionScopeButton({ t, sessionId }) {
      const [open, setOpen] = React.useState(false)
      return h(React.Fragment, null,
        h('button', {
          style: { ...S.btn, padding: '2px 8px', fontSize: '11.5px' },
          type: 'button',
          title: t('thisSessionTip'),
          onClick: () => setOpen(true),
        }, `${t('thisSessionAuth')}`),
        open
          ? h(Modal, { title: t('thisSessionAuth'), width: '680px', onClose: () => setOpen(false), t },
            h(SessionGrantPanel, { sessionId: String(sessionId ?? ''), t }))
          : null)
    }

    /**
     * 侧边栏插件栏的图标（与「插件」「自动化任务」「上下文洞察」并列）。
     * wide=false 时侧边栏是收起状态，只显示图标。
     */
    function PanelLauncherIcon({ t, wide }) {
      return h('button', {
        type: 'button',
        style: {
          display: 'flex', alignItems: 'center', gap: '8px',
          width: '100%', boxSizing: 'border-box',
          padding: wide ? '6px 10px' : '6px',
          justifyContent: wide ? 'flex-start' : 'center',
          font: 'inherit', fontSize: '12px', cursor: 'pointer',
          border: 'none', borderRadius: '6px', background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
        },
        title: t('nav'),
        onClick: () => {
          // 用 layout 服务切到我们注册的 main key
          const layout = ctxGet('layout')
          if (layout?.selectPanel) layout.selectPanel(NS)
        },
      },
      h('span', { style: { fontSize: '15px', lineHeight: 1 } }, ''),
      wide ? h('span', null, t('nav')) : null)
    }

    /**
     * 主面板：点插件栏图标后在中栏渲染。
     *
     * 内容与设置页的「本地授权」一致（同一份数据），
     * 但这里是**常驻入口**，不必先打开设置。
     */
    function LauncherPanel({ t }) {
      return h('div', { style: { padding: '16px', overflow: 'auto', height: '100%', boxSizing: 'border-box' } },
        h(ErrorBoundary, null, h(LauncherSection, { t })))
    }

      return { LauncherSection, MenuScopeRow, SessionScopeButton, PanelLauncherIcon, LauncherPanel }
    }
    return { build }
  },
})
