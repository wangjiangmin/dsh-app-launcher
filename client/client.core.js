// client.core.js — dsh-app-launcher 客户端 chunk（单一职责）。由 client.js 组合根经 require.async 加载，build(deps) 显式接收依赖。
window.__ModuleLoader__.load({
  id: 'dsh-app-launcher',
  chunk: 'client.core.js',
  factory(require) {
    function build() {
    const NS = 'dsh-app-launcher'

    const API = '/dsh-app-launcher'

    const POLL_MS = 3000

    // ==================== 样式 ====================
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px', maxWidth: '100%', boxSizing: 'border-box' },
      head: { display: 'flex', flexDirection: 'column', gap: '4px' },
      title: { fontSize: '15px', fontWeight: 700, color: 'var(--dsw-alias-label-primary)' },
      sub: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      card: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '10px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '100%', boxSizing: 'border-box' },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', fontSize: '12.5px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      // 应用卡片：竖向排列，绝不横向溢出
      appCard: { display: 'flex', flexDirection: 'column', gap: '8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-1)', padding: '10px 12px', maxWidth: '100%', boxSizing: 'border-box' },
      appTop: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' },
      appName: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
      appDesc: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5, overflowWrap: 'anywhere' },
      pathLine: { fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere', wordBreak: 'break-all', lineHeight: 1.5 },
      pills: { display: 'flex', gap: '5px', flexWrap: 'wrap' },
      actions: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      tiny: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      tinyWarn: { fontSize: '11px', color: 'var(--dsw-alias-state-warn-primary)', lineHeight: 1.5, overflowWrap: 'anywhere' },
      pill: { display: 'inline-flex', alignItems: 'center', gap: '5px', borderRadius: '999px', padding: '1px 9px', fontSize: '11.5px', fontWeight: 600, border: '1px solid transparent', whiteSpace: 'nowrap' },
      dot: { width: '6px', height: '6px', borderRadius: '50%', background: 'currentColor', display: 'inline-block' },
      btn: { font: 'inherit', fontSize: '12px', cursor: 'pointer', borderRadius: '6px', padding: '4px 12px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' },
      btnPrimary: { font: 'inherit', fontSize: '12px', cursor: 'pointer', borderRadius: '6px', padding: '4px 12px', border: '1px solid transparent', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)', whiteSpace: 'nowrap' },
      btnDanger: { font: 'inherit', fontSize: '12px', cursor: 'pointer', borderRadius: '6px', padding: '4px 12px', border: '1px solid var(--dsw-alias-state-error-primary)', background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)', color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'nowrap' },
      btnOff: { opacity: 0.45, cursor: 'not-allowed' },
      notice: { borderRadius: '8px', padding: '7px 10px', fontSize: '12px', lineHeight: 1.5, overflowWrap: 'anywhere' },
      // 表单：标签在上、控件在下，宽度自适应
      form: { display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '10px', marginTop: '2px' },
      field: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
      label: { fontSize: '11.5px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      hint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.4 },
      input: { font: 'inherit', fontSize: '12px', width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
      textarea: { font: 'inherit', fontSize: '12px', width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', resize: 'vertical', minHeight: '48px', fontFamily: 'inherit' },
      rowInline: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
      twoCol: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' },
      switchRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      pre: { margin: 0, maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', fontSize: '11px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px', padding: '8px' },
      details: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '10px', padding: '8px 12px' },
      summary: { cursor: 'pointer', fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      divider: { height: '1px', background: 'var(--dsw-alias-border-l1)', margin: '2px 0' },
      // 文件浏览器
      browseBox: {
        display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2)', padding: '8px',
        maxWidth: '100%', boxSizing: 'border-box',
      },
      browseList: {
        maxHeight: '200px', overflowY: 'auto', overflowX: 'hidden',
        display: 'flex', flexDirection: 'column', gap: '1px',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-1)', padding: '3px',
      },
      browseItem: {
        font: 'inherit', fontSize: '11.5px', textAlign: 'left', cursor: 'pointer',
        background: 'transparent', border: 'none', borderRadius: '4px',
        padding: '3px 6px', color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        maxWidth: '100%', boxSizing: 'border-box',
      },
    }

    const TONES = {
      success: { color: 'var(--dsw-alias-state-success-primary)', bg: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)', bg: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)' },
      error: { color: 'var(--dsw-alias-state-error-primary)', bg: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)' },
      muted: { color: 'var(--dsw-alias-label-secondary)', bg: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent)' },
      brand: { color: 'var(--dsw-alias-brand-primary, var(--color-blue-500))', bg: 'color-mix(in srgb, var(--dsw-alias-brand-primary, var(--color-blue-500)) 12%, transparent)' },
    }

    const PHASE = {
      ready: { key: 'phase_ready', tone: 'success' },
      starting: { key: 'phase_starting', tone: 'warn' },
      failed: { key: 'phase_failed', tone: 'error' },
      stopped: { key: 'phase_stopped', tone: 'muted' },
    }

    function formatMiB(mib) {
      if (mib === null || mib === undefined || !Number.isFinite(Number(mib))) return '—'
      const n = Number(mib)
      if (n >= 1024) return `${(n / 1024).toFixed(1)} GiB`
      return `${Math.round(n)} MiB`
    }

    function formatClock(ms) {
      if (!ms) return null
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    function describeNeeds(needs, t) {
      if (!needs) return t('needs_none')
      const parts = []
      if (needs.gpuUtilPctMax !== null && needs.gpuUtilPctMax !== undefined) parts.push(t('needs_gpuUtil').replace('{v}', needs.gpuUtilPctMax))
      if (needs.freeVramMiBMin !== null && needs.freeVramMiBMin !== undefined) parts.push(t('needs_vram').replace('{v}', formatMiB(needs.freeVramMiBMin)))
      if (needs.freeRamMiBMin !== null && needs.freeRamMiBMin !== undefined) parts.push(t('needs_ram').replace('{v}', formatMiB(needs.freeRamMiBMin)))
      if (needs.cpuPctMax !== null && needs.cpuPctMax !== undefined) parts.push(t('needs_cpu').replace('{v}', needs.cpuPctMax))
      return parts.length > 0 ? parts.join(' · ') : t('needs_none')
    }

    function noticeTone(tone) {
      const style = tone === 'error'
        ? { background: TONES.error.bg, color: TONES.error.color }
        : tone === 'success'
          ? { background: TONES.success.bg, color: TONES.success.color }
          : { background: TONES.warn.bg, color: TONES.warn.color }
      return { ...S.notice, ...style }
    }

    async function jsonFetch(path, init) {
      const res = await fetch(`${API}${path}`, { cache: 'no-store', ...init })
      const text = await res.text()
      let body = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = { raw: text }
      }
      return { ok: res.ok, status: res.status, body }
    }

    const post = (path, body = {}, method = 'POST') => jsonFetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    /** GET，返回解包后的 body（与 run()/post() 的用法保持一致）。 */
    const get = (path) => jsonFetch(path, { method: 'GET' })

    function scopeLabel(scope, t) {
      if (scope === 'entry') return t('grantEntry')
      if (scope === 'workspace') return t('scopeWorkspace')
      if (scope === 'session') return t('scopeSession')
      return t('scopeGlobal')
    }

    function formatTime(ms) {
      try {
        const d = new Date(Number(ms))
        const pad = (n) => String(n).padStart(2, '0')
        return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      } catch {
        return '—'
      }
    }

    // ==================== 设置页主面板 ====================

      return { NS, API, POLL_MS, S, TONES, PHASE, formatMiB, formatClock, describeNeeds, noticeTone, jsonFetch, post, get, scopeLabel, formatTime }
    }
    return { build }
  },
})
