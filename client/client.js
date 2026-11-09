/**
 * dsh-app-launcher —— 设置页客户端半边。
 *
 * 手写客户端插件：`window.__ModuleLoader__.load({id, factory})`，factory 里
 * `require('react')`，最后 return `{ name, inject, apply }`。没有构建步骤。
 *
 * 布局原则（修复横向溢出）：**一行一个应用卡片，字段竖向排列**，
 * 不把「名称 / 路径 / 需求 / 状态 / 操作」塞进同一行 grid。
 * 编辑用内联展开的表单，不弹模态框，避免窄面板里弹窗被裁切。
 *
 * 接口：
 *   GET    /dsh-app-launcher/status
 *   GET    /dsh-app-launcher/config
 *   POST   /dsh-app-launcher/config/global     { patch: {...} }
 *   POST   /dsh-app-launcher/config/program    { entry }
 *   PATCH  /dsh-app-launcher/config/program    { id, entry }
 *   DELETE /dsh-app-launcher/config/program    { id }
 *   POST   /dsh-app-launcher/config/reset
 *   POST   /dsh-app-launcher/start             { id }
 *   POST   /dsh-app-launcher/stop              { id }
 */
window.__ModuleLoader__.load({
  id: 'dsh-app-launcher',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-app-launcher'
    const API = '/dsh-app-launcher'
    const POLL_MS = 3000

    // ==================== 文案 ====================
    const zh = {
      nav: '本地应用',
      title: '本地应用启动器',
      subtitle: '按 CPU / GPU / 内存空闲情况按需拉起本地软件；Agent 无需二次授权即可启动',
      globalOn: '插件已启用',
      globalOff: '插件已禁用',
      globalTipOn: 'Agent 可以直接调用 app_list / app_start；切换后旧会话立刻生效',
      globalTipOff: '已从 Agent 的工具表注销，现有会话也不会再看到',
      sec_system: '当前资源',
      sec_programs: '应用列表',
      sec_advanced: '高级设置',
      empty: '还没有任何应用，点「添加应用」开始配置',
      addApp: '添加应用',
      edit: '编辑',
      del: '删除',
      save: '保存',
      cancel: '取消',
      confirmDel: '确认删除？',
      start: '启动',
      stop: '停止',
      stopConfirm: '确认停止？',
      refresh: '刷新',
      reset: '恢复默认配置',
      resetConfirm: '确认恢复为 patch 里的初始配置？当前修改会丢失',
      f_gpu: 'GPU',
      f_cpu: 'CPU',
      f_mem: '内存',
      f_holders: '占用 GPU 的进程',
      phase_ready: '运行中',
      phase_starting: '启动中',
      phase_stopped: '已停止',
      phase_failed: '启动失败',
      phase_unknown: '状态未知',
      enabled: '启用',
      disabled: '已禁用',
      gate_ok: '可启动',
      gate_block: '不可启动',
      gate_running: '已在运行',
      needs_none: '无限制',
      needs_gpuUtil: 'GPU 利用率 < {v}%',
      needs_vram: '空闲显存 ≥ {v}',
      needs_ram: '空闲内存 ≥ {v}',
      needs_cpu: 'CPU < {v}%',
      invalid: '配置不完整',
      connFail: '无法连接宿主',
      log: '日志',
      logEmpty: '暂无日志',
      dryRunOn: 'dryRun 模式：只打印命令，不会真的启动',
      startedTip: '已在后台启动，就绪后状态会变绿',
      // 表单
      f_name: '名称',
      f_id: '内部 id',
      f_idTip: '留空自动生成；Agent 用它来指代这个应用',
      f_desc: '用途说明',
      f_descTip: '写给 AI 看：这个软件是做什么的、什么时候该用它',
      f_exe: '启动路径',
      f_exeTip: '可执行文件的完整路径。保存时会检查该文件是否存在；一般直接选软件主程序（.exe），脚本才需要填解释器。',
      f_dirs: '这个程序的授权目录',
      f_dirsTip: '只有列在这里的文件夹，Agent 才能读写该程序的数据（如模型/输出目录）。按软件分别授权，不要填整个盘符。',
      f_browse: '选择文件…',
      f_cwd: '启动时的当前目录',
      f_cwdTip: '一般留空（默认用启动路径所在目录）。只有脚本要用相对路径当基准时才填，它不影响软件的数据/工作流位置',
      f_cwdBrowse: '选择目录…',
      f_advanced: '高级选项',
      f_args: '启动参数',
      f_argsTip: '用空格分隔；含空格的路径请用双引号包起来',
      f_env: '环境变量',
      f_envTip: '每行一个 KEY=VALUE',
      f_needs: '资源需求（不满足时拒绝启动）',
      f_gpuUtil: 'GPU 利用率上限 %',
      f_vram: '空闲显存下限 MiB',
      f_ram: '空闲内存下限 MiB',
      f_cpuMax: 'CPU 占用上限 %',
      f_needsTip: '留空 = 该项不参与判定',
      f_exclusive: '互斥组',
      f_exclusiveTip: '同名组内只允许跑一个（如 gpu-heavy）；留空则不互斥',
      f_readyUrl: '就绪探针地址',
      f_readyUrlTip: '返回 2xx 即视为就绪；留空则进程起来就算启动完成',
      f_readyTimeout: '就绪超时（毫秒）',
      f_stopTimeout: '停止超时（毫秒）',
      f_enabled: '启用这个应用',
      f_conflictPolicy: '资源冲突策略',
      f_conflictReject: '只拒绝并给建议（绝不杀别人的进程）',
      f_conflictStopOwn: '允许先停止本插件启动的旧程序',
      f_unreadable: '读不到 GPU 时',
      f_unreadableReject: '拒绝启动',
      f_unreadableAllow: '仍然启动',
      f_sampleCache: '采样缓存（毫秒）',
      f_nvidiaSmi: 'nvidia-smi 路径',
      f_readyTimeoutGlobal: '默认就绪超时（毫秒）',
      cfgPath: '配置文件',
      pickFail: '无法打开文件选择器，请手动填写路径',
      savedTip: '已保存并立即生效',
      saveFail: '保存失败，请检查上方提示',
      pickUnavailable: '宿主未提供目录选择器，请手动填写路径',
      pickExeHint: '已填入所在目录，请在末尾补上可执行文件名（如 Comfy Desktop.exe）',
      dirEmpty: '（空目录）',
      useThisDir: '用这个目录',
      useThisPath: '用这个路径',
      notExecutable: '这个条目不是可执行脚本（exe/bat/cmd/ps1/py…），请进入目录或手动填写',
      manualTip: '找不到？可直接粘贴完整路径',
      needAllowedDir: '还没有授权任何目录。请到本页底部「授权目录」添加要浏览的文件夹（只授权这几个文件夹，不是整盘）。',
      sec_allowed: '授权目录',
      allowedTip: '「选择文件」只能浏览这里列出的目录。留空则无法浏览，但可以手动填路径。',
      addDir: '添加目录',
      dirPlaceholder: 'C:\\Users\\wjm\\AppData\\Local\\Programs',
      removeDir: '移除',
      noDirs: '还没有授权目录',
      saveDirs: '保存授权目录',
      dirsSaved: '授权目录已保存',
      notExecutable: '这个条目不是可执行脚本，请进入目录或手动填写',
      notDirectory: '这个条目不是目录',
      dirEmpty: '（空目录）',
      useThisDir: '用这个目录',
      browseTitle: '选择位置',
    }

    const en = {
      nav: 'Local apps',
      title: 'Local App Launcher',
      subtitle: 'Launches local software only when CPU / GPU / RAM are idle; the Agent needs no second approval',
      globalOn: 'Plugin enabled',
      globalOff: 'Plugin disabled',
      globalTipOn: 'The Agent can call app_list / app_start; existing sessions pick this up immediately',
      globalTipOff: 'Removed from the Agent tool table; existing sessions will not see it',
      sec_system: 'Current load',
      sec_programs: 'Applications',
      sec_advanced: 'Advanced',
      empty: 'No applications yet — click "Add application"',
      addApp: 'Add application',
      edit: 'Edit',
      del: 'Delete',
      save: 'Save',
      cancel: 'Cancel',
      confirmDel: 'Delete?',
      start: 'Start',
      stop: 'Stop',
      stopConfirm: 'Confirm stop?',
      refresh: 'Refresh',
      reset: 'Reset to defaults',
      resetConfirm: 'Reset to the patch seed? Current edits are lost',
      f_gpu: 'GPU',
      f_cpu: 'CPU',
      f_mem: 'RAM',
      f_holders: 'GPU processes',
      phase_ready: 'Running',
      phase_starting: 'Starting',
      phase_stopped: 'Stopped',
      phase_failed: 'Failed',
      phase_unknown: 'Unknown',
      enabled: 'Enabled',
      disabled: 'Disabled',
      gate_ok: 'Can start',
      gate_block: 'Cannot start',
      gate_running: 'Already running',
      needs_none: 'No limit',
      needs_gpuUtil: 'GPU util < {v}%',
      needs_vram: 'Free VRAM ≥ {v}',
      needs_ram: 'Free RAM ≥ {v}',
      needs_cpu: 'CPU < {v}%',
      invalid: 'Incomplete',
      connFail: 'Cannot reach host',
      log: 'Log',
      logEmpty: 'No log yet',
      dryRunOn: 'dryRun: prints the command only',
      startedTip: 'Starting in background',
      f_name: 'Name',
      f_id: 'Internal id',
      f_idTip: 'Blank = auto-generated; the Agent uses it to refer to this app',
      f_desc: 'Purpose',
      f_descTip: 'Written for the AI: what this software does and when to use it',
      f_exe: 'Executable path',
      f_exeTip: 'Full path to the executable. Saving verifies the file exists; pick the app binary itself (utility scripts excepted).',
      f_dirs: 'Authorized directories for this app',
      f_dirsTip: 'Only folders listed here may be used for this app data (models/output). Authorize per app — never a whole drive.',
      f_browse: 'Browse…',
      f_cwd: 'Startup working directory',
      f_cwdTip: 'Usually leave blank (defaults to the executable directory). Only needed when a script resolves relative paths from its cwd; it does not change where the app keeps its data',
      f_cwdBrowse: 'Browse…',
      f_advanced: 'Advanced options',
      f_args: 'Arguments',
      f_argsTip: 'Space separated; quote paths that contain spaces',
      f_env: 'Environment',
      f_envTip: 'One KEY=VALUE per line',
      f_needs: 'Resource requirements (start is refused when unmet)',
      f_gpuUtil: 'Max GPU util %',
      f_vram: 'Min free VRAM MiB',
      f_ram: 'Min free RAM MiB',
      f_cpuMax: 'Max CPU %',
      f_needsTip: 'Blank = this check is skipped',
      f_exclusive: 'Exclusive group',
      f_exclusiveTip: 'Only one member runs at a time (e.g. gpu-heavy); blank = no grouping',
      f_readyUrl: 'Readiness probe URL',
      f_readyUrlTip: 'Any 2xx means ready; blank = the process alone counts as started',
      f_readyTimeout: 'Ready timeout (ms)',
      f_stopTimeout: 'Stop timeout (ms)',
      f_enabled: 'Enable this application',
      f_conflictPolicy: 'Conflict policy',
      f_conflictReject: 'Refuse and explain (never kills foreign processes)',
      f_conflictStopOwn: 'May stop our own previous app first',
      f_unreadable: 'When GPU is unreadable',
      f_unreadableReject: 'Refuse to start',
      f_unreadableAllow: 'Start anyway',
      f_sampleCache: 'Sample cache (ms)',
      f_nvidiaSmi: 'nvidia-smi path',
      f_readyTimeoutGlobal: 'Default ready timeout (ms)',
      cfgPath: 'Config file',
      pickFail: 'Cannot open the picker; type the path manually',
      savedTip: 'Saved and applied',
      saveFail: 'Save failed — see the message above',
      pickUnavailable: 'The host provides no directory picker; type the path manually',
      pickExeHint: 'Directory filled in — append the executable name (e.g. Comfy Desktop.exe)',
      dirEmpty: '(empty directory)',
      useThisDir: 'Use this directory',
      useThisPath: 'Use this path',
      notExecutable: 'That entry is not an executable script (exe/bat/cmd/ps1/py…); enter a folder or type the path',
      manualTip: 'Cannot find it? Paste the full path directly',
      needAllowedDir: 'No authorized directories yet. Add the folders you want to browse under "Authorized directories" below (only those folders, not the whole drive).',
      sec_allowed: 'Authorized directories',
      allowedTip: '"Browse" can only see the folders listed here. Empty means browsing is unavailable, but you can still type a path.',
      addDir: 'Add directory',
      dirPlaceholder: 'C:\\Users\\wjm\\AppData\\Local\\Programs',
      removeDir: 'Remove',
      noDirs: 'No authorized directories yet',
      saveDirs: 'Save authorized directories',
      dirsSaved: 'Authorized directories saved',
      notExecutable: 'That entry is not an executable script — enter a folder or type the path',
      notDirectory: 'That entry is not a directory',
      dirEmpty: '(empty directory)',
      useThisDir: 'Use this directory',
      browseTitle: 'Choose a location',
    }

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

    // ==================== 小工具 ====================
    function Pill({ tone = 'muted', children, title }) {
      const toneDef = TONES[tone] ?? TONES.muted
      return h('span', { title: title ?? undefined, style: { ...S.pill, color: toneDef.color, background: toneDef.bg, borderColor: toneDef.color } },
        h('i', { style: S.dot }), children)
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

    function useStatus() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const refresh = React.useCallback(async () => {
        try {
          const res = await jsonFetch('/status')
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          setData(res.body)
          setError(null)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }, [])
      React.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
      }, [refresh])
      return { data, error, refresh }
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

    // ==================== 应用卡片 ====================
    function AppCard({ program, logInfo, gate, editing, onEdit, onDelete, onStart, onStop, busy, confirmStop, setConfirmStop, t }) {
      const phase = PHASE[program.phase] ?? { key: 'phase_unknown', tone: 'muted' }
      const gateRunning = gate?.action === 'already-running'
      const gateOk = gate?.ok === true && !gateRunning
      const canStart = program.enabled && program.valid && !gateRunning && gateOk && program.phase !== 'ready' && !busy
      const canStop = program.canStop && program.phase !== 'stopped'

      const pills = [h(Pill, { key: 'p', tone: phase.tone }, t(phase.key))]
      if (!program.enabled) pills.push(h(Pill, { key: 'd', tone: 'muted' }, t('disabled')))
      if (!program.valid) pills.push(h(Pill, { key: 'i', tone: 'error', title: program.invalidReason ?? '' }, t('invalid')))
      if (gateRunning) pills.push(h(Pill, { key: 'g', tone: 'brand' }, t('gate_running')))
      else if (program.enabled && program.valid) {
        pills.push(h(Pill, { key: 'g', tone: gateOk ? 'success' : 'warn', title: gate?.reason ?? '' }, gateOk ? t('gate_ok') : t('gate_block')))
      }

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
            h('button', { style: S.btn, onClick: () => onEdit(editing ? null : program.id) }, editing ? t('cancel') : t('edit')),
            h('button', { style: S.btnDanger, onClick: () => onDelete(program.id) }, t('del'))),
        ),

        // 字段竖向排列，不会横向溢出
        h('div', { style: S.pathLine, title: program.launch?.exe ?? '' }, program.launch?.exe ?? '—'),
        h('div', { style: S.pills }, pills),
        h('div', { style: S.tiny }, `${t('f_needs')}: ${describeNeeds(program.needs, t)}`),
        program.stopBlockedReason && program.running ? h('div', { style: S.tinyWarn }, program.stopBlockedReason) : null,
        gate?.ok === false && !gateRunning && program.enabled ? h('div', { style: S.tinyWarn }, gate.reason) : null,

        logInfo
          ? h('details', { style: { padding: '2px 0' } },
            h('summary', { style: S.summary }, t('log')),
            h('pre', { style: S.pre }, (logInfo.tail ?? []).length > 0 ? logInfo.tail.join('\n') : t('logEmpty')))
          : null)
    }

    // ==================== 编辑表单 ====================
    function emptyForm() {
      return {
        id: '', name: '', enabled: true, description: '',
        exe: '', args: '', cwd: '', envText: '',
        allowedDirs: [],
        needs: { gpuUtilPctMax: 10, freeVramMiBMin: 0, freeRamMiBMin: 0, cpuPctMax: 80 },
        exclusive: 'gpu-heavy',
        readyUrl: '', readyTimeoutMs: 180000, stopTimeoutMs: 20000,
      }
    }

    function toForm(program) {
      return {
        id: program.id,
        name: program.name,
        enabled: program.enabled,
        description: program.description ?? '',
        exe: program.launch?.exe ?? '',
        args: (program.launch?.args ?? []).join(' '),
        cwd: program.launch?.cwd ?? '',
        envText: Object.entries(program.launch?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
        allowedDirs: (program.allowedDirs ?? []).slice(),
        needs: {
          gpuUtilPctMax: program.needs?.gpuUtilPctMax ?? '',
          freeVramMiBMin: program.needs?.freeVramMiBMin ?? '',
          freeRamMiBMin: program.needs?.freeRamMiBMin ?? '',
          cpuPctMax: program.needs?.cpuPctMax ?? '',
        },
        exclusive: program.exclusive ?? '',
        readyUrl: program.ready?.url ?? '',
        readyTimeoutMs: program.ready?.timeoutMs ?? 180000,
        stopTimeoutMs: 20000,
      }
    }

    /**
     * 表单 → 提交体。args / env 在这里仍是原始文本，由宿主侧 edit.mjs
     * 的 splitArgs / parseEnvText 解析（客户端不重复实现一遍解析规则）。
     */
    function fromForm(form) {
      return {
        id: String(form.id ?? '').trim(),
        name: String(form.name ?? '').trim(),
        enabled: form.enabled !== false,
        description: String(form.description ?? '').trim(),
        launch: {
          exe: String(form.exe ?? '').trim(),
          args: String(form.args ?? '').trim(),
          cwd: String(form.cwd ?? '').trim(),
          env: String(form.envText ?? ''),
        },
        allowedDirs: (form.allowedDirs ?? []).slice(),
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

      return h('div', { style: S.form },
        h(Field, { label: t('f_name') },
          h(TextInput, { value: form.name, onChange: (v) => set({ name: v }), placeholder: 'ComfyUI' })),

        h(Field, { label: t('f_id'), hint: t('f_idTip') },
          h(TextInput, { value: form.id, onChange: (v) => set({ id: v }), placeholder: 'comfyui' })),

        h(Field, { label: t('f_desc'), hint: t('f_descTip') },
          h(TextArea, { value: form.description, onChange: (v) => set({ description: v }), rows: 2, placeholder: t('f_descTip') })),

        h(Field, { label: t('f_exe'), hint: t('f_exeTip') },
          h(TextInput, { value: form.exe, onChange: (v) => set({ exe: v }), placeholder: 'C:\\...\\ComfyUI.exe' })),

        // 授权目录跟着这个程序走：每个软件只管自己的目录
        h(Field, { label: t('f_dirs'), hint: t('f_dirsTip') },
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

        h(Field, { label: t('f_args'), hint: t('f_argsTip') },
          h(TextInput, { value: form.args, onChange: (v) => set({ args: v }), placeholder: '--port 8188' })),

        h(Field, { label: t('f_env'), hint: t('f_envTip') },
          h(TextArea, { value: form.envText, onChange: (v) => set({ envText: v }), rows: 2, placeholder: 'CUDA_VISIBLE_DEVICES=0' })),

        // 启动时的当前目录是少见的高级项：默认折叠，避免用户误以为是"安装目录"
        h('details', { style: S.details },
          h('summary', { style: S.summary }, t('f_advanced')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' } },
            h(Field, { label: t('f_cwd'), hint: t('f_cwdTip') },
              h(TextInput, { value: form.cwd, onChange: (v) => set({ cwd: v }), placeholder: '(留空 = exe 目录)' })),
            h(Field, { label: t('f_exclusive'), hint: t('f_exclusiveTip') },
              h(TextInput, { value: form.exclusive, onChange: (v) => set({ exclusive: v }), placeholder: 'gpu-heavy' })),

            h('div', { style: S.twoCol },
              h(Field, { label: t('f_readyTimeout') }, h(TextInput, { type: 'number', value: form.readyTimeoutMs, onChange: (v) => set({ readyTimeoutMs: v }) })),
              h(Field, { label: t('f_stopTimeout') }, h(TextInput, { type: 'number', value: form.stopTimeoutMs, onChange: (v) => set({ stopTimeoutMs: v }) }))))),

        h('div', { style: S.divider }),
        h('div', { style: S.label }, t('f_needs')),
        h('div', { style: S.tiny }, t('f_needsTip')),
        h('div', { style: S.twoCol },
          h(Field, { label: t('f_gpuUtil') }, h(TextInput, { type: 'number', value: form.needs.gpuUtilPctMax, onChange: (v) => setNeed('gpuUtilPctMax', v) })),
          h(Field, { label: t('f_vram') }, h(TextInput, { type: 'number', value: form.needs.freeVramMiBMin, onChange: (v) => setNeed('freeVramMiBMin', v) })),
          h(Field, { label: t('f_ram') }, h(TextInput, { type: 'number', value: form.needs.freeRamMiBMin, onChange: (v) => setNeed('freeRamMiBMin', v) })),
          h(Field, { label: t('f_cpuMax') }, h(TextInput, { type: 'number', value: form.needs.cpuPctMax, onChange: (v) => setNeed('cpuPctMax', v) }))),

        h(Field, { label: t('f_readyUrl'), hint: t('f_readyUrlTip') },
          h(TextInput, { value: form.readyUrl, onChange: (v) => set({ readyUrl: v }), placeholder: 'http://127.0.0.1:8188/system_stats' })),

        h('div', { style: S.divider }),
        h('div', { style: S.switchRow },
          h(Switch, { checked: form.enabled, onChange: (v) => set({ enabled: v }), label: t('f_enabled') })),

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


    // ==================== 资源条 ====================
    function SystemCard({ system, t }) {
      const gpu = system?.gpu ?? {}
      const mem = system?.memory ?? {}
      const cpu = system?.cpu ?? {}
      const holders = system?.gpuHolders ?? []

      const pills = [
        h(Pill, { key: 'gpu', tone: !gpu.available ? 'muted' : gpu.utilPct >= 50 ? 'warn' : 'success' },
          `${t('f_gpu')}: ${gpu.available ? `${gpu.name ?? 'GPU'} · ${gpu.utilPct}% · ${formatMiB(gpu.freeMiB)} free` : (gpu.reason ?? '—')}`),
        h(Pill, { key: 'cpu', tone: cpu.pct >= 80 ? 'warn' : 'success' }, `${t('f_cpu')}: ${cpu.pct ?? '—'}%`),
        h(Pill, { key: 'mem', tone: (mem.freeMiB && mem.totalMiB && mem.freeMiB / mem.totalMiB < 0.15) ? 'warn' : 'success' },
          `${t('f_mem')}: ${formatMiB(mem.freeMiB)} / ${formatMiB(mem.totalMiB)}`),
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
          h('span', { style: S.tiny }, formatClock(system?.at) ?? '')),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, pills),
        holdersBlock)
    }

    // ==================== 主体 ====================
    function LauncherSection({ t }) {
      const { data, error, refresh } = useStatus()
      const { config, refresh: refreshConfig } = useConfig()
      const [busy, setBusy] = React.useState(null)
      const [confirmStop, setConfirmStop] = React.useState(null)
      const [editing, setEditing] = React.useState(null) // 'new' | program id | null
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
      const programs = data.programs ?? []
      const gates = data.gates ?? {}
      const logs = data.logs ?? {}
      const dryRun = plugin.dryRun === true
      const globalEnabled = plugin.enabled !== false
      const cfg = config ?? {}

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
        cfg.path ? h('div', { style: S.tiny }, `${t('cfgPath')}: ${cfg.path}`) : null,
        notice ? h('div', { style: noticeTone(notice.tone) }, notice.text) : null)

      // ---- 应用列表 ----
      const list = h('div', { style: S.card },
        h('div', { style: S.cardHead },
          t('sec_programs'),
          h('div', { style: S.actions },
            h('button', {
              style: S.btnPrimary,
              onClick: () => { setEditing(editing === 'new' ? null : 'new') },
            }, t('addApp')))),
        programs.length === 0 ? h('div', { style: S.sub }, t('empty')) : null,
        programs.map((program) => h(React.Fragment, { key: program.id },
          h(AppCard, {
            program,
            logInfo: logs[program.id],
            gate: gates[program.id],
            editing: editing === program.id,
            busy,
            confirmStop,
            setConfirmStop,
            t,
            onEdit: (next) => setEditing(next),
            onDelete: deleteProgram,
            onStart: async (id) => {
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
          }),
          editing === program.id
            ? h(ErrorBoundary, { key: `form-${program.id}` },
              h(ProgramForm, {
                initial: toForm(program),
                isNew: false,
                busy: busy === 'form',
                notice: formNotice,
                t,
                onCancel: () => setEditing(null),
                onSave: (entry) => saveEdit(program.id, entry),
              }))
            : null)),
        editing === 'new'
          ? h(ErrorBoundary, { key: 'form-new' },
            h(ProgramForm, {
              initial: null,
              isNew: true,
              busy: busy === 'form',
              notice: formNotice,
              t,
              onCancel: () => setEditing(null),
              onSave: saveNew,
            }))
          : null)

      return h('div', { style: S.wrap },
        header,
        h(SystemCard, { system: data.system, t }),
        list)
    }


    // ==================== 插件接线 ====================
    // 只声明 slot 与 locale 这两个硬依赖。uiWorkspace 用 ctx.get 软读取：
    // 它是内置浏览器的数据源，但缺了它整套设置页仍应正常工作（浏览器降级为手填）。
    // 若放进 inject，服务缺失会让整个设置页都不显示——代价过大。
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`)
      const t = ctx.locale.bind(NS)

      // 文件浏览走插件自己的 /browse（宿主侧实现，受 allowedDirs 白名单限制），
      // 不依赖宿主 uiWorkspace 的 listDirectory —— 本机只装配了 native 能力，
      // 那条路会报 "needs the browse capability"。

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 57,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ t }),
      }, () => h(ErrorBoundary, null, h(LauncherSection, { t }))))
    }

    return { name: NS, inject, apply }
  },
})
