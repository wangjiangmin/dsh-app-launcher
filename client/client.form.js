// client.form.js — dsh-app-launcher 客户端 chunk（单一职责）。由 client.js 组合根经 require.async 加载，build(deps) 显式接收依赖。
window.__ModuleLoader__.load({
  id: 'dsh-app-launcher',
  chunk: 'client.form.js',
  factory(require) {
    function build({ React, h, core, controls, sessions }) {
      const { S, noticeTone } = core
      const { Field, TextInput, TextArea, Switch } = controls
      const { SessionPicker } = sessions

    // ==================== 编辑表单 ====================
    function emptyForm() {
      return {
        kind: 'program',
        id: '', name: '', enabled: true, description: '',
        sessions: [],
        path: '',
        exe: '', args: '', cwd: '', envText: '', interpreter: '',
        allowedDirs: [],
        launchable: true,
        launchHint: '',
        needs: { gpuUtilPctMax: 10, freeVramMiBMin: 0, freeRamMiBMin: 0, cpuPctMax: 80 },
        exclusive: 'gpu-heavy',
        readyUrl: '', readyTimeoutMs: 180000, stopTimeoutMs: 20000,
      }
    }

    function toForm(program) {
      return {
        kind: program.kind ?? 'program',
        id: program.id,
        name: program.name,
        enabled: program.enabled,
        description: program.description ?? '',
        sessions: (program.sessions ?? []).slice(),
        path: program.path ?? '',
        exe: program.launch?.exe ?? '',
        args: (program.launch?.args ?? []).join(' '),
        cwd: program.launch?.cwd ?? '',
        envText: Object.entries(program.launch?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
        interpreter: program.launch?.interpreter ?? '',
        allowedDirs: (program.allowedDirs ?? []).slice(),
        launchable: program.launchable !== false,
        launchHint: program.launchHint ?? '',
        needs: {
          gpuUtilPctMax: program.needs?.gpuUtilPctMax ?? '',
          freeVramMiBMin: program.needs?.freeVramMiBMin ?? '',
          freeRamMiBMin: program.needs?.freeRamMiBMin ?? '',
          cpuPctMax: program.needs?.cpuPctMax ?? '',
        },
        exclusive: program.exclusive ?? '',
        readyUrl: program.ready?.url ?? '',
        readyTimeoutMs: program.ready?.timeoutMs ?? 180000,
        stopTimeoutMs: program.stopTimeoutMs ?? 20000,
      }
    }

    /**
     * 表单 → 提交体。args / env 在这里仍是原始文本，由宿主侧 edit.mjs
     * 的 splitArgs / parseEnvText 解析（客户端不重复实现一遍解析规则）。
     */
    function fromForm(form) {
      const kind = form.kind ?? 'program'
      const base = {
        id: String(form.id ?? '').trim(),
        name: String(form.name ?? '').trim(),
        kind,
        enabled: form.enabled !== false,
        description: String(form.description ?? '').trim(),
        sessions: (form.sessions ?? []).slice(),
      }
      // 目录条目只有路径，没有启动参数
      if (kind === 'directory') {
        return { ...base, path: String(form.path ?? '').trim() }
      }
      return {
        ...base,
        launch: {
          exe: String(form.exe ?? '').trim(),
          args: String(form.args ?? '').trim(),
          cwd: String(form.cwd ?? '').trim(),
          env: String(form.envText ?? ''),
          interpreter: String(form.interpreter ?? '').trim(),
        },
        allowedDirs: (form.allowedDirs ?? []).slice(),
        launchable: form.launchable !== false,
        launchHint: String(form.launchHint ?? '').trim(),
        needs: {
          gpuUtilPctMax: form.needs?.gpuUtilPctMax,
          freeVramMiBMin: form.needs?.freeVramMiBMin,
          freeRamMiBMin: form.needs?.freeRamMiBMin,
          cpuPctMax: form.needs?.cpuPctMax,
        },
        exclusive: String(form.exclusive ?? '').trim(),
        ready: {
          url: String(form.readyUrl ?? '').trim(),
          timeoutMs: form.readyTimeoutMs,
        },
        stopTimeoutMs: form.stopTimeoutMs,
      }
    }

    function ProgramForm({ initial, isNew, onSave, onCancel, busy, notice, t }) {
      const [form, setForm] = React.useState(() => initial ?? emptyForm())
      const [dirInput, setDirInput] = React.useState('')
      const set = (patch) => setForm((prev) => ({ ...prev, ...patch }))
      const setNeed = (key, value) => setForm((prev) => ({ ...prev, needs: { ...prev.needs, [key]: value } }))

      const kind = form.kind ?? 'program'
      const isDir = kind === 'directory'
      const isScript = kind === 'script'

      const addDir = () => {
        const text = dirInput.trim()
        if (text === '') return
        const dirs = form.allowedDirs ?? []
        if (dirs.some((d) => d.toLowerCase() === text.toLowerCase())) {
          setDirInput('')
          return
        }
        set({ allowedDirs: [...dirs, text] })
        setDirInput('')
      }

      const removeDir = (dir) => {
        set({ allowedDirs: (form.allowedDirs ?? []).filter((d) => d !== dir) })
      }

      const kindBtn = (k, labelKey) => h('button', {
        type: 'button',
        style: {
          ...S.btn,
          ...(kind === k ? {
            borderColor: 'var(--dsw-alias-brand-primary, var(--color-blue-500))',
            color: 'var(--dsw-alias-brand-primary, var(--color-blue-500))',
            fontWeight: 700,
          } : {}),
        },
        onClick: () => set({ kind: k }),
      }, t(labelKey))

      return h('div', { style: S.form },
        // 条目类型：软件 / 脚本 / 目录（统一管理，字段随类型变化）
        h(Field, { label: t('f_kind') },
          h('div', { style: S.rowInline },
            kindBtn('program', 'kind_program'),
            kindBtn('script', 'kind_script'),
            kindBtn('directory', 'kind_directory'))),

        h(Field, { label: t('f_name') },
          h(TextInput, { value: form.name, onChange: (v) => set({ name: v }), placeholder: 'ComfyUI' })),

        h(Field, { label: t('f_id'), hint: t('f_idTip') },
          h(TextInput, { value: form.id, onChange: (v) => set({ id: v }), placeholder: 'comfyui' })),

        h(Field, { label: t('f_desc'), hint: t('f_descTip') },
          h(TextArea, { value: form.description, onChange: (v) => set({ description: v }), rows: 2, placeholder: t('f_descTip') })),

        // 目录条目：只有路径；软件/脚本：启动路径（脚本按扩展名推导解释器）
        isDir
          ? h(Field, { label: t('f_dirPath'), hint: t('f_dirPathTip') },
            h(TextInput, { value: form.path, onChange: (v) => set({ path: v }), placeholder: 'D:\\models' }))
          : h(Field, { label: isScript ? t('f_scriptPath') : t('f_exe'), hint: isScript ? t('f_scriptPathTip') : t('f_exeTip') },
            h(TextInput, {
              value: form.exe,
              onChange: (v) => set({ exe: v }),
              placeholder: isScript ? 'C:\\...\\task.ps1' : 'C:\\...\\ComfyUI.exe',
            })),

        isScript
          ? h(Field, { label: t('f_interpreter'), hint: t('f_interpreterTip') },
            h(TextInput, { value: form.interpreter, onChange: (v) => set({ interpreter: v }), placeholder: '(留空 = 按扩展名自动)' }))
          : null,

        // 授权目录跟着这个程序走：每个软件只管自己的目录
        isDir ? null : h(Field, { label: t('f_dirs'), hint: t('f_dirsTip') },
          (form.allowedDirs ?? []).length === 0
            ? h('div', { style: S.tiny }, t('noDirs'))
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              (form.allowedDirs ?? []).map((dir) => h('div', { key: dir, style: S.rowInline },
                h('div', { style: { ...S.pathLine, flex: '1 1 200px', minWidth: 0 } }, dir),
                h('button', {
                  style: S.btnDanger, type: 'button',
                  onClick: () => removeDir(dir),
                }, t('removeDir'))))),
          h('div', { style: S.rowInline },
            h('div', { style: { flex: '1 1 220px', minWidth: 0 } },
              h(TextInput, { value: dirInput, onChange: setDirInput, placeholder: t('dirPlaceholder') })),
            h('button', { style: S.btn, type: 'button', onClick: addDir }, t('addDir')))),

        isDir ? null : h(Field, { label: t('f_args'), hint: t('f_argsTip') },
          h(TextInput, { value: form.args, onChange: (v) => set({ args: v }), placeholder: '--port 8188' })),

        isDir ? null : h(Field, { label: t('f_env'), hint: t('f_envTip') },
          h(TextArea, { value: form.envText, onChange: (v) => set({ envText: v }), rows: 2, placeholder: 'CUDA_VISIBLE_DEVICES=0' })),

        // 启动时的当前目录是少见的高级项：默认折叠，避免用户误以为是"安装目录"
        isDir ? null : h('details', { style: S.details },
          h('summary', { style: S.summary }, t('f_advanced')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' } },
            h(Field, { label: t('f_cwd'), hint: t('f_cwdTip') },
              h(TextInput, { value: form.cwd, onChange: (v) => set({ cwd: v }), placeholder: '(留空 = exe 目录)' })),
            h(Field, { label: t('f_exclusive'), hint: t('f_exclusiveTip') },
              h(TextInput, { value: form.exclusive, onChange: (v) => set({ exclusive: v }), placeholder: 'gpu-heavy' })),

            h('div', { style: S.twoCol },
              h(Field, { label: t('f_readyTimeout') }, h(TextInput, { type: 'number', value: form.readyTimeoutMs, onChange: (v) => set({ readyTimeoutMs: v }) })),
              h(Field, { label: t('f_stopTimeout') }, h(TextInput, { type: 'number', value: form.stopTimeoutMs, onChange: (v) => set({ stopTimeoutMs: v }) }))))),

        isDir ? null : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h('div', { style: S.divider }),
          h('div', { style: S.label }, t('f_needs')),
          h('div', { style: S.tiny }, t('f_needsTip')),
          h('div', { style: S.twoCol },
            h(Field, { label: t('f_gpuUtil') }, h(TextInput, { type: 'number', value: form.needs.gpuUtilPctMax, onChange: (v) => setNeed('gpuUtilPctMax', v) })),
            h(Field, { label: t('f_vram') }, h(TextInput, { type: 'number', value: form.needs.freeVramMiBMin, onChange: (v) => setNeed('freeVramMiBMin', v) })),
            h(Field, { label: t('f_ram') }, h(TextInput, { type: 'number', value: form.needs.freeRamMiBMin, onChange: (v) => setNeed('freeRamMiBMin', v) })),
            h(Field, { label: t('f_cpuMax') }, h(TextInput, { type: 'number', value: form.needs.cpuPctMax, onChange: (v) => setNeed('cpuPctMax', v) })))),

        isDir ? null : h(Field, { label: t('f_readyUrl'), hint: t('f_readyUrlTip') },
          h(TextInput, { value: form.readyUrl, onChange: (v) => set({ readyUrl: v }), placeholder: 'http://127.0.0.1:8188/system_stats' })),

        // 会话授权：所有类型的条目都有；不勾选任何会话＝对所有会话不可见
        h('div', { style: S.divider }),
        h(Field, { label: t('authTitle'), hint: t('authTip') },
          h(SessionPicker, { selected: form.sessions, onChange: (v) => set({ sessions: v }), t })),

        h('div', { style: S.divider }),
        h('div', { style: S.switchRow },
          h(Switch, { checked: form.enabled, onChange: (v) => set({ enabled: v }), label: t('f_enabled') })),
        // 只能手动启动：像 ComfyUI Desktop 这类 Electron 程序，从后台起会静默秒退
        isDir ? null : h('div', { style: S.switchRow },
          h(Switch, {
            checked: form.launchable === false,
            onChange: (v) => set({ launchable: !v }),
            label: t('f_manualOnly'),
          })),
        !isDir && form.launchable === false
          ? h(Field, { label: t('f_launchHint'), hint: t('f_launchHintTip') },
            h(TextInput, {
              value: form.launchHint,
              onChange: (v) => set({ launchHint: v }),
              placeholder: t('f_launchHint'),
            }))
          : null,

        notice ? h('div', { style: noticeTone('error') }, notice) : null,

        h('div', { style: S.actions },
          h('button', {
            style: { ...S.btnPrimary, ...(busy ? S.btnOff : {}) },
            disabled: Boolean(busy),
            onClick: () => onSave(fromForm(form)),
          }, busy ? '…' : t('save')),
          h('button', { style: S.btn, onClick: onCancel }, t('cancel')))
      )
    }

      return { emptyForm, toForm, fromForm, ProgramForm }
    }
    return { build }
  },
})
