// client.sessions.js — dsh-app-launcher 客户端 chunk（单一职责）。由 client.js 组合根经 require.async 加载，build(deps) 显式接收依赖。
window.__ModuleLoader__.load({
  id: 'dsh-app-launcher',
  chunk: 'client.sessions.js',
  factory(require) {
    function build({ React, h, core, controls, hooks }) {
      const { S, TONES, noticeTone, post, jsonFetch, formatTime, scopeLabel } = core
      const { TextInput, Switch } = controls
      const { useSessions, useWorkspaces } = hooks

    /**
     * 会话多选选择器：搜索 + 勾选列表。
     * 已选但不在列表里的 id（比如已归档的旧会话）单独列出来，仍可移除。
     */
    function SessionPicker({ selected, onChange, t }) {
      const { sessions, loading, error } = useSessions()
      const [query, setQuery] = React.useState('')
      const sel = selected ?? []
      const toggle = (id) => onChange(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id])
      const q = query.trim().toLowerCase()
      const shown = q === '' ? sessions : sessions.filter((s) => `${s.title ?? ''} ${s.id}`.toLowerCase().includes(q))
      const missing = sel.filter((id) => !sessions.some((s) => s.id === id))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h(TextInput, { value: query, onChange: setQuery, placeholder: t('searchSessions') }),
        missing.length > 0
          ? h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } },
            missing.map((id) => h('span', { key: id, style: { ...S.pill, color: TONES.muted.color, background: TONES.muted.bg, borderColor: TONES.muted.color } },
              h('span', { style: { overflowWrap: 'anywhere', maxWidth: '220px' } }, id),
              h('button', {
                type: 'button',
                style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', font: 'inherit', padding: 0 },
                onClick: () => toggle(id),
              }, '✕'))))
          : null,
        loading
          ? h('div', { style: S.tiny }, t('sessionsLoading'))
          : error
            ? h('div', { style: S.tinyWarn }, `${t('sessionsFail')}: ${error}`)
            : shown.length === 0
              ? h('div', { style: S.tiny }, t('sessionsEmpty'))
              : h('div', { style: { ...S.browseList, maxHeight: '240px' } },
                shown.map((s) => {
                  const checked = sel.includes(s.id)
                  return h('label', {
                    key: s.id,
                    style: {
                      display: 'flex', gap: '8px', alignItems: 'flex-start',
                      padding: '4px 6px', cursor: 'pointer', borderRadius: '4px',
                      background: checked ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, var(--color-blue-500)) 10%, transparent)' : 'transparent',
                    },
                  },
                  h('input', { type: 'checkbox', checked, onChange: () => toggle(s.id), style: { marginTop: '3px' } }),
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 } },
                    h('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' } },
                      s.title || t('untitledSession'),
                      s.live ? h('span', { style: { ...S.tiny, marginLeft: '6px', color: TONES.success.color } }, t('liveBadge')) : null,
                      s.subagent ? h('span', { style: { ...S.tiny, marginLeft: '6px' } }, t('subagentBadge')) : null),
                    h('div', { style: { ...S.pathLine, fontSize: '10.5px' } }, s.id)))
                })))
    }

    /**
     * 工作区多选选择器：搜索 + 勾选列表。按工作区路径勾选。
     * 授权一个工作区＝它名下的所有会话（含之后新增的）默认可用该条目。
     * 已选但不在列表里的路径（工作区已删除）单独列出，仍可移除。
     */
    function WorkspacePicker({ selected, onChange, t }) {
      const { workspaces, loading, error } = useWorkspaces()
      const [query, setQuery] = React.useState('')
      const sel = selected ?? []
      const toggle = (path) => onChange(sel.includes(path) ? sel.filter((x) => x !== path) : [...sel, path])
      const q = query.trim().toLowerCase()
      const shown = q === '' ? workspaces : workspaces.filter((w) => `${w.title ?? ''} ${w.path}`.toLowerCase().includes(q))
      const missing = sel.filter((path) => !workspaces.some((w) => w.path === path))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h(TextInput, { value: query, onChange: setQuery, placeholder: t('searchWorkspaces') }),
        missing.length > 0
          ? h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } },
            missing.map((path) => h('span', { key: path, style: { ...S.pill, color: TONES.muted.color, background: TONES.muted.bg, borderColor: TONES.muted.color } },
              h('span', { style: { overflowWrap: 'anywhere', maxWidth: '220px' } }, path),
              h('button', {
                type: 'button',
                style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', font: 'inherit', padding: 0 },
                onClick: () => toggle(path),
              }, '✕'))))
          : null,
        loading
          ? h('div', { style: S.tiny }, t('workspacesLoading'))
          : error
            ? h('div', { style: S.tinyWarn }, `${t('workspacesFail')}: ${error}`)
            : shown.length === 0
              ? h('div', { style: S.tiny }, t('workspacesEmpty'))
              : h('div', { style: { ...S.browseList, maxHeight: '200px' } },
                shown.map((w) => {
                  const checked = sel.includes(w.path)
                  return h('label', {
                    key: w.path,
                    style: {
                      display: 'flex', gap: '8px', alignItems: 'flex-start',
                      padding: '4px 6px', cursor: 'pointer', borderRadius: '4px',
                      background: checked ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, var(--color-blue-500)) 10%, transparent)' : 'transparent',
                    },
                  },
                  h('input', { type: 'checkbox', checked, onChange: () => toggle(w.path), style: { marginTop: '3px' } }),
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 } },
                    h('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' } },
                      w.title || w.path,
                      h('span', { style: { ...S.tiny, marginLeft: '6px' } }, t('workspaceSessionCount').replace('{n}', w.sessionCount ?? 0))),
                    h('div', { style: { ...S.pathLine, fontSize: '10.5px' } }, w.path)))
                })))
    }

    /** 单条目授权弹框：会话 + 工作区两段，走 /config/entry-grants 一次保存。 */
    function SessionAuthDialog({ entry, t, onClose, onSaved }) {
      const [selected, setSelected] = React.useState(() => (entry.sessions ?? []).slice())
      const [selectedWs, setSelectedWs] = React.useState(() => (entry.workspaces ?? []).slice())
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const save = async () => {
        setBusy(true)
        setNotice(null)
        try {
          const res = await post('/config/entry-grants', { id: entry.id, sessions: selected, workspaces: selectedWs })
          if (!res.ok) throw new Error(res.body?.error ?? `HTTP ${res.status}`)
          if (typeof onSaved === 'function') {
            try { await onSaved() } catch { /* 外层刷新失败不影响保存结果 */ }
          }
          onClose()
        } catch (err) {
          setNotice(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: S.tiny }, t('authTip')),
        h('div', { style: S.label }, t('authSessions')),
        h(SessionPicker, { selected, onChange: setSelected, t }),
        h('div', { style: S.divider }),
        h('div', { style: S.label }, t('authWorkspaces')),
        h('div', { style: S.tiny }, t('authWorkspacesTip')),
        h(WorkspacePicker, { selected: selectedWs, onChange: setSelectedWs, t }),
        notice ? h('div', { style: noticeTone('error') }, notice) : null,
        h('div', { style: S.actions },
          h('button', {
            style: { ...S.btnPrimary, ...(busy ? S.btnOff : {}) },
            disabled: busy,
            onClick: save,
          }, busy ? '…' : t('saveAuth')),
          h('button', { style: S.btn, onClick: onClose }, t('cancel'))))
    }

    /**
     * 「本会话授权」面板：列出全部条目，每条一个开关。
     * 会话顶部按钮 / 会话「...」菜单复用；勾选即把该条目授权给这个会话。
     */
    function SessionGrantPanel({ sessionId, t }) {
      const [entries, setEntries] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const sid = String(sessionId ?? '')

      const load = React.useCallback(async () => {
        try {
          const res = await jsonFetch('/config')
          if (!res.ok) throw new Error(res.body?.error ?? `HTTP ${res.status}`)
          setEntries(res.body?.config?.programs ?? [])
        } catch (err) {
          setNotice(err instanceof Error ? err.message : String(err))
        }
      }, [])
      React.useEffect(() => { load() }, [load])

      const toggle = async (entry) => {
        if (busy) return
        const has = (entry.sessions ?? []).includes(sid)
        const next = has ? (entry.sessions ?? []).filter((x) => x !== sid) : [...(entry.sessions ?? []), sid]
        setBusy(entry.id)
        setNotice(null)
        try {
          const res = await post('/config/entry-sessions', { id: entry.id, sessions: next })
          if (!res.ok) throw new Error(res.body?.error ?? `HTTP ${res.status}`)
          setEntries((prev) => (prev ?? []).map((e) => (e.id === entry.id ? { ...e, sessions: next } : e)))
        } catch (err) {
          setNotice(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(null)
        }
      }

      if (sid === '') return h('div', { style: S.tinyWarn }, t('noSessionId'))

      const kindKey = (entry) => (entry.kind === 'script' ? 'kind_script' : entry.kind === 'directory' ? 'kind_directory' : 'kind_program')

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: S.tiny }, t('thisSessionTip')),
        h('div', { style: S.pathLine }, sid),
        notice ? h('div', { style: noticeTone('error') }, notice) : null,
        entries === null
          ? h('div', { style: S.tiny }, '…')
          : entries.length === 0
            ? h('div', { style: S.tiny }, t('noEntries'))
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              entries.map((entry) => h('div', { key: entry.id, style: S.rowInline },
                h('div', { style: { flex: '1 1 200px', minWidth: 0 } },
                  h('div', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' } },
                    `${entry.name || entry.id} · ${t(kindKey(entry))}`,
                    (entry.workspaces ?? []).length > 0
                      ? h('span', { style: { ...S.tiny, marginLeft: '6px', color: TONES.brand.color }, title: (entry.workspaces ?? []).join('\n') },
                        t('workspacesCount').replace('{n}', entry.workspaces.length))
                      : null),
                  h('div', { style: S.pathLine }, entry.kind === 'directory' ? (entry.path ?? '') : (entry.launch?.exe ?? ''))),
                busy === entry.id
                  ? h('span', { style: S.tiny }, '…')
                  : h(Switch, { checked: (entry.sessions ?? []).includes(sid), onChange: () => toggle(entry) })))))
    }

    /** 授权记录（审计）：GET /grants，折叠展示。 */
    function GrantsLog({ t }) {
      const [grants, setGrants] = React.useState(null)
      React.useEffect(() => {
        (async () => {
          try {
            const res = await jsonFetch('/grants?limit=40')
            setGrants(res.ok ? (res.body.grants ?? []) : [])
          } catch {
            setGrants([])
          }
        })()
      }, [])
      const rows = grants ?? []
      return h('details', { style: S.details },
        h('summary', { style: S.summary }, `${t('sec_grants')}${grants === null ? '' : `（${rows.length}）`}`),
        grants === null
          ? h('div', { style: { ...S.tiny, marginTop: '6px' } }, '…')
          : rows.length === 0
            ? h('div', { style: { ...S.tiny, marginTop: '6px' } }, t('noGrants'))
            : h('div', { style: { marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '3px' } },
              rows.map((g, i) => h('div', {
                key: `${g.at}-${i}`,
                style: { ...S.tiny, display: 'flex', gap: '8px', flexWrap: 'wrap' },
              },
              h('span', { style: { opacity: 0.7 } }, formatTime(g.at)),
              h('span', { style: { fontWeight: 600 } }, scopeLabel(g.scope, t)),
              h('span', null, g.action),
              h('span', { style: { opacity: 0.8, overflowWrap: 'anywhere' } }, g.target)))))
    }

      return { SessionPicker, WorkspacePicker, SessionAuthDialog, SessionGrantPanel, GrantsLog }
    }
    return { build }
  },
})
