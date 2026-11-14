/**
 * dsh-app-launcher 客户端入口（组合根 / composition root）。
 *
 * ★ 架构（poolVersion 2 之后的拆分）：
 *   本文件只做三件事——加载 chunk、按依赖装配、注册 slot。所有 UI 逻辑都在
 *   同目录的 package-local chunk 里（DSH 原生 `require.async('./client.*.js')`
 *   机制，无需构建步骤）。每个 chunk 导出 `{ build(deps) }`，依赖由这里显式传入，
 *   chunk 之间不互相 require，接口即 build 的入参与返回值。
 *
 *   chunk 职责（单一职责）：
 *     client.i18n.js      文案字典 zh / en
 *     client.core.js      常量 + 样式 S + 纯函数工具（格式化 / HTTP / 提示色）
 *     client.hooks.js     数据 hooks：useStatus / useConfig / useSessions / useWorkspaces
 *     client.controls.js  基础控件：Pill / Field / TextInput / TextArea / ErrorBoundary / Switch / Modal
 *     client.cards.js     展示卡片：AppCard / DirectoryCard / SystemCard
 *     client.sessions.js  会话/工作区授权：SessionPicker / WorkspacePicker / SessionAuthDialog / SessionGrantPanel / GrantsLog
 *     client.form.js      条目表单：emptyForm / toForm / fromForm / ProgramForm
 *     client.panel.js     面板与入口：LauncherSection / MenuScopeRow / SessionScopeButton /
 *                         PanelLauncherIcon / LauncherPanel
 *
 *   依赖方向（无环）：i18n / core ← hooks / controls ← cards / sessions ← form ← panel。
 *
 * ★ 权限模型：统一「软件/脚本/目录」条目池 + 每条目按会话/工作区授权
 *   （sessions[] + workspaces[]）。授权工作区＝其下所有会话默认可用（含新增）。
 *   无全局授权层；设置页是管理面（看全部），工具调用按会话过滤。
 *
 * ★ 接口（宿主侧 lib/http.mjs）：/status /config /config/global /config/program
 *   /config/entry-sessions /config/entry-grants /config/reset /sessions /workspaces
 *   /grants /browse /start /stop /verify /log。
 *
 * ★ 弹框用 react-dom createPortal 挂到 document.body：会话标题动作带会裁剪
 *   overflow（slot 契约 overlays must portal），内联覆盖层会被裁掉。
 */
window.__ModuleLoader__.load({
  id: 'dsh-app-launcher',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const NS = 'dsh-app-launcher'

    // 给面板组件一个读宿主服务的能力（layout.selectPanel 用于切到本插件面板）。
    // apply 里绑定到当前 ctx；未绑定时安全返回 undefined。
    let ctxGetService = () => undefined
    const ctxGet = (name) => ctxGetService(name)

    async function apply(ctx) {
      // 1) 并行加载全部 chunk（彼此独立，加载无依赖）。
      const [i18nM, coreM, hooksM, controlsM, cardsM, sessionsM, formM, panelM] = await Promise.all([
        require.async('./client.i18n.js'),
        require.async('./client.core.js'),
        require.async('./client.hooks.js'),
        require.async('./client.controls.js'),
        require.async('./client.cards.js'),
        require.async('./client.sessions.js'),
        require.async('./client.form.js'),
        require.async('./client.panel.js'),
      ])

      // 2) 按依赖顺序装配（build 的入参就是该模块的显式接口）。
      const i18n = i18nM.build()
      const core = coreM.build()
      const hooks = hooksM.build({ React, core })
      const controls = controlsM.build({ React, ReactDOM, h, core })
      const cards = cardsM.build({ h, core, controls })
      const sessions = sessionsM.build({ React, h, core, controls, hooks })
      const form = formM.build({ React, h, core, controls, sessions })
      const panel = panelM.build({ React, h, core, controls, cards, sessions, form, hooks, ctxGet })

      // 测试接缝：test/render.mjs 注入钩子抓取已装配的模块做真渲染测试；生产无副作用。
      if (typeof globalThis !== 'undefined' && typeof globalThis.__DSH_LAUNCHER_TEST_HOOK__ === 'function') {
        globalThis.__DSH_LAUNCHER_TEST_HOOK__({ i18n, core, hooks, controls, cards, sessions, form, panel })
      }

      const { zh, en } = i18n
      const { ErrorBoundary } = controls
      const { LauncherSection, MenuScopeRow, SessionScopeButton, PanelLauncherIcon, LauncherPanel } = panel

      // 3) 注册文案与 slot。
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`)
      const t = ctx.locale.bind(NS)
      ctxGetService = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)

      // 文件浏览走插件自己的 /browse（宿主侧实现，受授权目录限制），不依赖宿主 uiWorkspace。

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 57,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ t }),
      }, () => h(ErrorBoundary, null, h(LauncherSection, { t }))))

      // ============ 主页插件栏入口（与「插件」「自动化任务」「上下文洞察」并列） ============
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

      // 对应的主面板：点侧边栏图标后在中栏渲染。
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: NS,
        locale: NS,
      }, () => h(ErrorBoundary, null, h(LauncherPanel, { t }))))

      // ============ 会话顶部入口（只影响当前会话） ============
      // ★ inject 回调第一参就是 sessionId（session-scope slot 契约）；显式接住并回传，
      //   不依赖 props 自动注入，确保弹框一定拿得到会话 id。
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: `${NS}-session`,
        order: 120,
        label: () => t('navAuth'),
        locale: NS,
        inject: (sessionId) => ({ t, sessionId }),
      }, (props) => h(ErrorBoundary, null,
        h(SessionScopeButton, { t, sessionId: props?.sessionId }))))

      // ============ 工作区授权说明 ============
      // ★ poolVersion 2 起授权粒度是「条目 × 会话 / 工作区」：每个条目可授权给若干会话，
      //   也可授权给整个工作区（其下所有会话默认可用，含之后新增的）。没有独立的
      //   「工作区入口」slot——工作区授权在条目授权弹框/表单里完成。旧版工作区切片
      //   授权在宿主侧迁移时展开成会话授权（runtime.expandWorkspaceGrants）。

      // ============ 会话「...」菜单入口（与会话的重命名/归档并列） ============
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: `${NS}-menu`,
        order: 460,
        label: () => t('navAuth'),
        locale: NS,
        inject: (sessionId) => ({ t, sessionId }),
      }, (props) => h(ErrorBoundary, null,
        h(MenuScopeRow, { t, sessionId: props?.sessionId }))))
    }

    const inject = ['slots', 'locale']
    return { name: NS, inject, apply }
  },
})