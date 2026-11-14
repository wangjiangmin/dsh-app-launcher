// client.controls.js — dsh-app-launcher 客户端 chunk（单一职责）。由 client.js 组合根经 require.async 加载，build(deps) 显式接收依赖。
window.__ModuleLoader__.load({
  id: 'dsh-app-launcher',
  chunk: 'client.controls.js',
  factory(require) {
    function build({ React, h, core }) {
      const { S, TONES } = core

    // ==================== 小工具 ====================
    function Pill({ tone = 'muted', children, title }) {
      const toneDef = TONES[tone] ?? TONES.muted
      return h('span', { title: title ?? undefined, style: { ...S.pill, color: toneDef.color, background: toneDef.bg, borderColor: toneDef.color } },
        h('i', { style: S.dot }), children)
    }

    // ==================== 表单控件 ====================
    function Field({ label, hint, children }) {
      return h('div', { style: S.field },
        h('label', { style: S.label }, label),
        children,
        hint ? h('div', { style: S.hint }, hint) : null)
    }

    function TextInput({ value, onChange, placeholder, type }) {
      return h('input', {
        style: S.input,
        type: type ?? 'text',
        value: value ?? '',
        placeholder: placeholder ?? '',
        onChange: (e) => onChange(e.target.value),
      })
    }

    function TextArea({ value, onChange, placeholder, rows }) {
      return h('textarea', {
        style: { ...S.textarea, minHeight: rows ? `${rows * 18}px` : undefined },
        value: value ?? '',
        placeholder: placeholder ?? '',
        onChange: (e) => onChange(e.target.value),
      })
    }

    /**
     * 错误边界：组件树里任何渲染异常都只在本区域内显示错误，
     * 不再让整个 settings 分区崩溃（DSH 会把崩掉的 slot entry 整块移除，
     * 表现就是"点一下编辑，界面全没了"）。
     *
     * 之前的真实事故：表单引用了已被删除的 TextInput2，点「编辑」即白屏。
     */
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        // 打印到宿主控制台，便于从日志定位（不弹窗、不打断其它分区）
        console.error('[dsh-app-launcher] 渲染异常:', error)
      }

      render() {
        if (this.state.error) {
          const message = this.state.error?.message ?? String(this.state.error)
          return h('div', { style: S.card },
            h('div', { style: S.cardHead }, '本地应用启动器 — 渲染出错'),
            h('div', { style: S.tinyWarn }, message),
            h('div', { style: S.hint }, '配置没有被修改。修复后可点下面按钮重试；若持续失败请刷新页面。'),
            h('div', { style: S.actions },
              h('button', {
                style: S.btn,
                type: 'button',
                onClick: () => this.setState({ error: null }),
              }, '重试')))
        }
        return this.props.children
      }
    }

    /** 开关：host 风格 + role=switch，和宿主控件一致。 */
    function Switch({ checked, onChange, label }) {
      return h('div', { style: S.switchRow },
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': checked === true,
          'aria-label': label,
          onClick: () => onChange(!checked),
          style: {
            position: 'relative', width: '38px', height: '20px', flex: '0 0 auto',
            borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)',
            cursor: 'pointer', padding: 0,
            background: checked
              ? 'var(--dsw-alias-button-primary-fill)'
              : 'color-mix(in srgb, var(--dsw-alias-label-secondary) 22%, transparent)',
            transition: 'background .15s',
          },
        }, h('span', {
          style: {
            position: 'absolute', top: '2px', left: checked ? '19px' : '2px',
            width: '14px', height: '14px', borderRadius: '50%',
            background: 'var(--dsw-alias-bg-layer-1)',
            transition: 'left .15s',
          },
        })),
        label ? h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-primary)' } }, label) : null)
    }

    /**
     * 通用模态框。
     *
     * 为什么不用内联展开：列表很长时，展开表单会把「添加」按钮和表单拉开很远，
     * 用户点了按钮还得往下滚才能填。弹框把表单固定在视野中央，填完关掉。
     */
    function Modal({ title, width, onClose, children, t }) {
      React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'color-mix(in srgb, #000 45%, transparent)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          padding: '6vh 16px 16px', overflow: 'auto',
        },
        onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
      },
      h('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        style: {
          width: width ?? '640px', maxWidth: '100%', boxSizing: 'border-box',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '12px',
          boxShadow: '0 12px 40px color-mix(in srgb, #000 35%, transparent)',
          display: 'flex', flexDirection: 'column', maxHeight: '88vh',
        },
      },
      h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '12px', padding: '12px 16px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
        },
      },
      h('div', { style: { fontSize: '13.5px', fontWeight: 700, color: 'var(--dsw-alias-label-primary)' } }, title),
      h('button', {
        style: { ...S.btn, padding: '2px 9px' },
        type: 'button',
        onClick: onClose,
        'aria-label': t('close'),
      }, '✕')),
      h('div', { style: { padding: '14px 16px', overflow: 'auto' } }, children)))
    }

    // ==================== 会话授权（统一条目池，poolVersion 2） ====================

      return { Pill, Field, TextInput, TextArea, ErrorBoundary, Switch, Modal }
    }
    return { build }
  },
})
