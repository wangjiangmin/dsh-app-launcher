/**
 * dsh-app-launcher —— 设置页客户端半边。
 *
 * 手写客户端插件：`window.__ModuleLoader__.load({id, factory})`，factory 里
 * `require('react')`，最后 return `{ name, inject, apply }`。没有构建步骤。
 *
 * 布局原则（修复横向溢出）：**一行一个条目卡片，字段竖向排列**，
 * 不把「名称 / 路径 / 需求 / 状态 / 操作」塞进同一行 grid。
 * 编辑/新建/授权都用弹框（Modal + ErrorBoundary），避免窄面板里内联表单被挤没。
 *
 * 权限模型（poolVersion 2）：统一条目池「软件/脚本/目录」，每个条目带
 * sessions[] 会话授权；没有全局授权层。设置页是管理面（看全部条目），
 * Agent 工具只能看到授权给自己会话的条目。
 *
 * 接口：
 *   GET    /dsh-app-launcher/status
 *   GET    /dsh-app-launcher/config
 *   GET    /dsh-app-launcher/sessions          会话选择器数据源
 *   POST   /dsh-app-launcher/config/global     { patch: {...} }
 *   POST   /dsh-app-launcher/config/program    { entry }
 *   PATCH  /dsh-app-launcher/config/program    { id, entry }
 *   DELETE /dsh-app-launcher/config/program    { id }
 *   POST   /dsh-app-launcher/config/entry-sessions { id, sessions }
 *   POST   /dsh-app-launcher/config/reset
 *   GET    /dsh-app-launcher/grants
 *   POST   /dsh-app-launcher/start             { id }
 *   POST   /dsh-app-launcher/stop              { id }
 *   GET    /dsh-app-launcher/verify?id=
 *   GET    /dsh-app-launcher/log?id=
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
      nav: '本地授权',
      title: '软件 / 脚本 / 目录',
      subtitle: '统一管理本地软件、脚本与目录；每个条目按会话授权，只有被授权的会话才能看到并使用',
      globalOn: '插件已启用',
      globalOff: '插件已禁用',
      globalTipOn: 'Agent 可以直接调用 app_list / app_start；切换后旧会话立刻生效',
      globalTipOff: '已从 Agent 的工具表注销，现有会话也不会再看到',
      sec_system: '当前资源',
      test: '测试',
      testing: '检查中…',
      testTip: '手动检查一次 CPU / GPU / 内存（进入页面时不做检查，避免卡顿）',
      notCheckedYet: '资源未检查',
      lazyTip: '进入页面不自动检查，点「测试」或启动程序时才查',
      sec_programs: '软件/脚本/目录',
      sec_advanced: '高级设置',
      empty: '还没有条目，点上方按钮添加软件、脚本或目录',
      addApp: '添加条目',
      edit: '编辑',
      del: '删除',
      save: '保存',
      cancel: '取消',
      confirmDel: '确认删除？',
      start: '启动',
      stop: '停止',
      stopConfirm: '确认停止？',
      verify: '验证',
      verifyHint: '只读验证：检查端口、残留进程与就绪探针，不会启动或停止任何东西',
      verifyResult: '验证结果',
      verifyPass: '通过（状态符合预期）',
      verifyFail: '未通过',
      verifyUnknown: '证据不足，无法判定',
      verifyProblems: '问题',
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
      manualOnly: '需手动启动',
      manualOnlyHint: '这个程序只能从桌面手动启动，插件不代为拉起；状态检测与停止仍然可用。',
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
      f_manualOnly: '只能手动启动（插件不代拉）',
      f_launchHint: '手动启动说明',
      f_launchHintTip: '会显示在卡片上，告诉用户为什么不能自动启动、该怎么启动',
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
      needAllowedDir: '还没有可浏览的目录。请先添加「目录」条目并授权给相应会话（只授权需要的文件夹，不是整盘）。',
      sec_allowed: '授权目录',
      close: '关闭',
      addProgram: '添加软件',
      addScript: '添加脚本',
      addDirectory: '添加目录',
      addDir: '添加目录',
      dirAdded: '目录已加入本作用域',
      dirRemoved: '目录已移除',
      programAdded: '程序已加入本作用域',
      programRemoved: '程序已移除',
      sec_dirs: '授权目录',
      sec_grants: '授权记录',
      noPrograms: '本作用域还没有添加软件/脚本',
      noGrants: '还没有授权记录',
      effectiveScope: '合并生效',
      dirsUnit: '个目录',
      programsUnit: '个程序',
      scopeGlobal: '全局',
      scopeWorkspace: '工作区',
      scopeSession: '会话',
      f_dirPath: '目录路径',
      f_dirPathTip: '必须是绝对路径，例如 D:\\models 或 \\\\nas\\share',
      needDirPath: '请填写目录路径',
      needAbsolute: '必须是绝对路径（盘符开头或 UNC 路径）',
      dirExists: '这个目录已在列表里',
      needName: '请填写名称',
      needExe: '请填写启动路径',
      idExists: '这个 id 已存在',
      navWorkspace: '工作区应用',
      navAuth: '授权',
      globalScopeTip: '对所有工作区、所有会话生效',
      workspaceScopeTip: '只对这个工作区下的所有会话生效',
      sessionScopeTip: '管理授权给本会话的条目；勾选立即生效',
      openPanel: '打开设置',
      workspaceUnavailable: '当前没有活动工作区，无法设置工作区级授权',
      jsonErr: '返回数据不是有效 JSON',
      belongsToWorkspace: '所属工作区',
      workspaceUnresolved: '未能确定所属工作区（工作区级授权此时不参与合并）',
      allowedTip: '「选择文件」只能浏览这里列出的目录。留空则无法浏览，但可以手动填路径。',
      dirPlaceholder: 'C:\\Users\\wjm\\AppData\\Local\\Programs',
      removeDir: '移除',
      noDirs: '还没有授权目录',
      saveDirs: '保存授权目录',
      dirsSaved: '授权目录已保存',
      notDirectory: '这个条目不是目录',
      browseTitle: '选择位置',
      // —— 统一条目池 + 会话授权（poolVersion 2）——
      kind_program: '软件',
      kind_script: '脚本',
      kind_directory: '目录',
      f_kind: '条目类型',
      f_scriptPath: '脚本路径',
      f_scriptPathTip: '脚本文件的完整路径（.ps1 / .bat / .cmd / .py / .js / .sh 等）；保存时按扩展名自动选择解释器',
      f_interpreter: '解释器（可选）',
      f_interpreterTip: '留空 = 按扩展名自动选择；填写则强制用指定解释器（完整路径，或 PATH 里能找到的名字）',
      authBtn: '授权',
      authTitle: '会话授权',
      authTip: '只有勾选的会话能看到并使用这个条目；未勾选的会话完全看不到它',
      sessionsNone: '未授权任何会话',
      sessionsCount: '已授权 {n} 个会话',
      sessionsLoading: '正在加载会话列表…',
      sessionsEmpty: '没有可选的会话',
      sessionsFail: '会话列表加载失败',
      searchSessions: '搜索会话标题或 id…',
      untitledSession: '（无标题）',
      liveBadge: '进行中',
      subagentBadge: '子代理',
      saveAuth: '保存授权',
      authSaved: '授权已更新，立即生效',
      unauthNotice: '有 {n} 个条目未授权任何会话——它们对所有会话都不可见。点卡片上的「授权」选择会话',
      migrationPending: '旧的工作区授权正在等待展开：工作区列表就绪后会自动转成会话授权',
      thisSessionAuth: '本会话授权',
      thisSessionTip: '勾选条目即授权给本会话；改动立即生效，无需重启',
      noEntries: '还没有条目，请先到设置页「本地授权」添加',
      grantEntry: '条目',
      noSessionId: '拿不到会话 id，无法做会话授权',
    }

    const en = {
      nav: 'Local authorization',
      title: 'Software / Scripts / Directories',
      subtitle: 'Unified management of local software, scripts and directories; each entry is authorized per session — only authorized sessions can see and use it',
      globalOn: 'Plugin enabled',
      globalOff: 'Plugin disabled',
      globalTipOn: 'The Agent can call app_list / app_start; existing sessions pick this up immediately',
      globalTipOff: 'Removed from the Agent tool table; existing sessions will not see it',
      sec_system: 'Current load',
      test: 'Test',
      testing: 'Checking…',
      testTip: 'Run a one-off CPU / GPU / RAM check (opening this page does not sample, to stay fast)',
      notCheckedYet: 'Resources not checked',
      lazyTip: 'Not checked on open — hit Test, or start an app',
      sec_programs: 'Software / scripts / directories',
      sec_advanced: 'Advanced',
      empty: 'No entries yet — add software, scripts or directories above',
      addApp: 'Add entry',
      edit: 'Edit',
      del: 'Delete',
      save: 'Save',
      cancel: 'Cancel',
      confirmDel: 'Delete?',
      start: 'Start',
      stop: 'Stop',
      stopConfirm: 'Confirm stop?',
      verify: 'Verify',
      verifyHint: 'Read-only check: port, leftover processes and readiness probe. Starts/stops nothing',
      verifyResult: 'Verification',
      verifyPass: 'passed (state as expected)',
      verifyFail: 'FAILED',
      verifyUnknown: 'not enough evidence to decide',
      verifyProblems: 'Problems',
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
      manualOnly: 'Manual start',
      manualOnlyHint: 'This app can only be started from the desktop; the plugin will not launch it. Status and stop still work.',
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
      f_manualOnly: 'Manual start only (plugin will not launch it)',
      f_launchHint: 'Manual start note',
      f_launchHintTip: 'Shown on the card: why it cannot be auto-started and how to start it',
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
      needAllowedDir: 'No browsable directories yet. Add "directory" entries and authorize them to sessions first (only the folders you need, never a whole drive).',
      sec_allowed: 'Authorized directories',
      close: 'Close',
      addProgram: 'Add software',
      addScript: 'Add script',
      addDirectory: 'Add directory',
      addDir: 'Add directory',
      dirAdded: 'Directory added to this scope',
      dirRemoved: 'Directory removed',
      programAdded: 'App added to this scope',
      programRemoved: 'App removed',
      sec_dirs: 'Authorized directories',
      sec_grants: 'Grant log',
      noPrograms: 'No apps in this scope yet',
      noGrants: 'No grants recorded yet',
      effectiveScope: 'Merged effective',
      dirsUnit: 'dirs',
      programsUnit: 'apps',
      scopeGlobal: 'Global',
      scopeWorkspace: 'Workspace',
      scopeSession: 'Session',
      f_dirPath: 'Directory path',
      f_dirPathTip: 'Absolute path required, e.g. D:\\models or \\\\nas\\share',
      needDirPath: 'Enter a directory path',
      needAbsolute: 'Must be an absolute path (drive letter or UNC)',
      dirExists: 'That directory is already listed',
      needName: 'Enter a name',
      needExe: 'Enter the executable path',
      idExists: 'That id already exists',
      navWorkspace: 'Workspace apps',
      navAuth: 'Authorize',
      globalScopeTip: 'Applies to every workspace and session',
      workspaceScopeTip: 'Applies to every session in this workspace',
      sessionScopeTip: 'Manage entries authorized to this session; changes apply immediately',
      openPanel: 'Open settings',
      workspaceUnavailable: 'No active workspace, so workspace-level grants are unavailable',
      jsonErr: 'Response was not valid JSON',
      belongsToWorkspace: 'Workspace',
      workspaceUnresolved: 'Workspace could not be resolved (workspace-level grants are not merged)',
      allowedTip: '"Browse" can only see the folders listed here. Empty means browsing is unavailable, but you can still type a path.',
      dirPlaceholder: 'C:\\Users\\wjm\\AppData\\Local\\Programs',
      removeDir: 'Remove',
      noDirs: 'No authorized directories yet',
      saveDirs: 'Save authorized directories',
      dirsSaved: 'Authorized directories saved',
      notDirectory: 'That entry is not a directory',
      browseTitle: 'Choose a location',
      // —— Unified entry pool + per-session authorization (poolVersion 2) ——
      kind_program: 'Software',
      kind_script: 'Script',
      kind_directory: 'Directory',
      f_kind: 'Entry type',
      f_scriptPath: 'Script path',
      f_scriptPathTip: 'Full path to the script (.ps1 / .bat / .cmd / .py / .js / .sh …); the interpreter is inferred from the extension on save',
      f_interpreter: 'Interpreter (optional)',
      f_interpreterTip: 'Blank = inferred from the extension; set to force a specific interpreter (full path, or a name on PATH)',
      authBtn: 'Authorize',
      authTitle: 'Session authorization',
      authTip: 'Only checked sessions can see and use this entry; unchecked sessions cannot see it at all',
      sessionsNone: 'Not authorized to any session',
      sessionsCount: '{n} session(s) authorized',
      sessionsLoading: 'Loading sessions…',
      sessionsEmpty: 'No sessions available',
      sessionsFail: 'Failed to load sessions',
      searchSessions: 'Search by title or id…',
      untitledSession: '(untitled)',
      liveBadge: 'live',
      subagentBadge: 'subagent',
      saveAuth: 'Save authorization',
      authSaved: 'Authorization updated — effective immediately',
      unauthNotice: '{n} entries are not authorized to any session — invisible to every session. Use "Authorize" on a card to pick sessions',
      migrationPending: 'Legacy workspace grants are pending expansion into session grants once the workspace list is available',
      thisSessionAuth: 'Grants for this session',
      thisSessionTip: 'Check an entry to authorize it to this session; changes apply immediately, no restart',
      noEntries: 'No entries yet — add them in Settings → Local authorization first',
      grantEntry: 'Entry',
      noSessionId: 'No session id available for authorization',
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

    /** GET，返回解包后的 body（与 run()/post() 的用法保持一致）。 */
    const get = (path) => jsonFetch(path, { method: 'GET' })

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

    /** 单条目会话授权弹框：只改 sessions，走 /config/entry-sessions 快速通道。 */
    function SessionAuthDialog({ entry, t, onClose, onSaved }) {
      const [selected, setSelected] = React.useState(() => (entry.sessions ?? []).slice())
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const save = async () => {
        setBusy(true)
        setNotice(null)
        try {
          const res = await post('/config/entry-sessions', { id: entry.id, sessions: selected })
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
        h(SessionPicker, { selected, onChange: setSelected, t }),
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
                    `${entry.name || entry.id} · ${t(kindKey(entry))}`),
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
        }, `🔐 ${t('thisSessionAuth')}`),
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
        }, `🔐 ${t('thisSessionAuth')}`),
        open
          ? h(Modal, { title: t('thisSessionAuth'), width: '680px', onClose: () => setOpen(false), t },
            h(SessionGrantPanel, { sessionId: String(sessionId ?? ''), t }))
          : null)
    }

    /** 由 apply() 注入的服务读取器（组件是模块级函数，拿不到 ctx）。 */
    let ctxGetService = () => undefined
    const ctxGet = (name) => ctxGetService(name)

    // ==================== 插件栏入口与主面板 ====================

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
      h('span', { style: { fontSize: '15px', lineHeight: 1 } }, '🔐'),
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

    // ==================== 插件接线 ====================
    // 只声明 slot 与 locale 这两个硬依赖。uiWorkspace 用 ctx.get 软读取：
    // 它是内置浏览器的数据源，但缺了它整套设置页仍应正常工作（浏览器降级为手填）。
    // 若放进 inject，服务缺失会让整个设置页都不显示——代价过大。
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`)
      const t = ctx.locale.bind(NS)

      // 给模块级组件一个读服务的能力（layout.selectPanel 用于切到本插件的面板）
      ctxGetService = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)

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

      // ==================== 主页插件栏入口（与「插件」「自动化任务」「上下文洞察」并列） ====================
      // DSH 没有开放「工作区标题菜单」的 slot，所以改放在最常用的位置：
      // 侧边栏插件栏的图标 + （配对）主面板。
      // 配对规则：sidebar.panellist 注册的 id 决定 key，main 按同一 key 渲染面板。
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: NS,
        order: 120,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ t }),
      }, (props) => h(ErrorBoundary, null,
        h(PanelLauncherIcon, { t, wide: props?.wide }))))

      // 对应的主面板：点侧边栏图标后在中栏渲染
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: NS,
        locale: NS,
      }, () => h(ErrorBoundary, null, h(LauncherPanel, { t }))))

      // ==================== 会话顶部入口（只影响当前会话） ====================
      // 挂在会话标题旁的动作区：能拿到 sessionId，作用域自然是"本会话"。
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: `${NS}-session`,
        order: 120,
        label: () => t('navAuth'),
        locale: NS,
        inject: () => ({ t }),
      }, (props) => h(ErrorBoundary, null,
        h(SessionScopeButton, { t, sessionId: props?.sessionId }))))

      // ==================== 为什么没有「工作区入口」 ====================
      // ★ poolVersion 2 起授权粒度是「条目 × 会话」，不再有工作区/全局授权层，
      //   所以不需要工作区入口。历史背景：DSH 也没有开放「工作区行 / 工作区菜单」
      //   的 slot（`sidebar.workspaces` 是 single，整块替换官方浏览器风险太高；
      //   `sidebar.workspaces.session.menu.item` 的 ownerProps 只有 sessionId）。
      //   旧版工作区授权在宿主侧迁移时展开成会话授权（runtime.expandWorkspaceGrants）。

      // ==================== 会话「...」菜单入口（与会话的重命名/归档并列） ====================
      // 这个 slot 就是会话行「...」菜单，官方已在这里放 pin/rename/fork/archive。
      // 我们的行排在 archive 之后，符合"和重命名、删除放一起"的诉求。
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: `${NS}-menu`,
        order: 460,
        label: () => t('navAuth'),
        locale: NS,
        inject: () => ({ t }),
      }, (props) => h(ErrorBoundary, null,
        h(MenuScopeRow, { t, sessionId: props?.sessionId }))))
    }

    return { name: NS, inject, apply }
  },
})
