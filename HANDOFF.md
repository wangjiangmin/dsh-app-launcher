# 交接文档：dsh-app-launcher（显示名：本地授权）

> 更新 2026-11-14（T24 权限重构 `b273496`；客户端拆分组合根+8 chunk `0f6c58d`；工作区授权+弹框 portal 修复 见 §〇）· 取代 11/9 版（旧版在 git `7fd7ce9`）· 给新会话接手用
> 来源会话「资源监控与软件自启动插件方案」= `session-2be05f3c-fa59-4574-8127-b502bcf27867`
> （2026-11-08 19:57 → 11-14 01:00，27 轮，1269 次工具调用；上下文 ~1,048,365 tokens 溢出而死）。
> 原始日志：`C:\Users\wjm\.dsh\sessions\--D-wjm-Documents-deepseek-harness-default-workspace--\session-2be05f3c-fa59-4574-8127-b502bcf27867\session.v4.jsonl.zstd`（多帧 zstd，按 magic `28 B5 2F FD` 切帧解）。

---

## 〇、一句话现状

插件**已安装可用**：desktop profile bundles 已选中、Junction 链接指向工作区、用户层配置在位、
**244 项逻辑测试全绿** + 门面/渲染测试（17 用例+反向验证）、工作区干净。
客户端已拆为组合根 + 8 个职责 chunk（commit `0f6c58d`，详见 §四与 README「客户端文件结构」）。

**★ 本轮修复 3 个授权问题（用户 m01212，2026-11-14）：**

> 「1. 会话顶部的`授权`入口有问题,无法正常弹框. 2. 没有工作区授权功能,功能区授权后,整个工作区的会话默认可用. 3. 授权页面,无法正常获取会话和工作区,照成无法正常授权.」

- **问题1（弹框打不开）根因＝内联 Modal 被会话标题动作带裁剪**。slot 契约原文「overflow is clipped and faded … overlays must portal」。
  修复：`client.controls.js` 的 Modal 用 `react-dom` `createPortal(overlay, document.body)`（无 DOM 时退回内联，保渲染测试）；
  entry 两个会话 slot 的 `inject` 改 `(sessionId)=>({t,sessionId})` 稳妥送达会话 id。render.mjs 用例16/17 点击按钮真弹框+断言 portal。
- **问题2（工作区授权）＝条目加 `workspaces:[]`**（规范工作区路径，pathKey 归一）。可见性＝`sessions.includes(sid)` **或** 所属工作区 pathKey ∈ `workspaces`（`_entryVisibleTo` runtime.mjs:542）——
  **授权工作区＝其下所有会话默认可用，含之后新增的**（动态，不展开成会话 id）。新增 `setEntryGrants(id,{sessions,workspaces})`/`setEntryWorkspaces`/`listWorkspaces()`；
  HTTP `GET /workspaces`、`POST /config/entry-grants`；client 加 `WorkspacePicker` + `useWorkspaces`，授权弹框/表单/卡片都带工作区段。poolVersion 仍 2（workspaces 默认 [] 无需迁移）。
- **问题3（取不到会话/工作区）根因＝运行中的宿主还是 pre-T24 旧代码（从未重启）**：实测 `GET /sessions`→404、`/config` 返回旧形状。
  代码本身正确（`listSessions`/`listWorkspaces` + `/sessions`/`/workspaces` 路由 + 宿主 `sessionQuery`/`workspaceRegistry` inject 都在），**重启 DSH 后即恢复**。

**⚠️ 用户侧必做**：host 改动需**重启 DSH**、client 改动需**刷新浏览器**才生效（Junction 磁盘代码已即时最新）。
**当前运行的宿主仍是 pre-T24 旧代码——不重启则问题3 依旧、工作区授权也不生效。** 重启后旧 config.json（poolVersion 1）自动迁移成 2，
4 个出厂程序变 `sessions=[]`（未授权）——**这是收缩的本意**：需在设置页把它们勾选授权给相应会话/工作区，Agent 才能看到/启动。

**会话死因（旧会话）**：T26 `/compact` 未真正压缩；T27 切模型后 `400 … "Range of input length should be [1, 983616]"`，
code=CONTEXT_WINDOW_EXCEEDED（~1,048,365 tokens）。**新会话不要试图复活旧会话，直接以本文档接手。**

---

## 一、位置 / 安装 / 配置

| 项 | 值 |
|---|---|
| 源码 | `D:\wjm\Documents\deepseek-harness\default-workspace\dsh-app-launcher` |
| 安装 | `C:\Users\wjm\.dsh\profiles\desktop\node_modules\dsh-app-launcher`（Junction → 工作区，代码即时生效） |
| profile | `C:\Users\wjm\.dsh\profiles\desktop\package.json`：bundles 含 `dsh-app-launcher`；dependencies `link:D:/wjm/Documents/deepseek-harness/default-workspace/dsh-app-launcher` |
| 用户层配置 | `C:\Users\wjm\.dsh\app-launcher\config.json`（patch 只当出厂种子） |
| 作用域存储 | `C:\Users\wjm\.dsh\app-launcher\scopes.json`（poolVersion 2 后**只留 `grants[]` 审计**，MAX_GRANTS=500；旧 workspaces/sessions 切片迁移后清空） |
| 启动日志 | `C:\Users\wjm\.dsh\app-launcher\comfyui.log` 等（插件侧诊断也落盘，不再 0 字节） |

**git 全链（新→旧）**：
`b273496` ★T24 权限收缩（统一条目池+按会话授权，poolVersion 2）→ `59994b9` HANDOFF 更新至 11/14 →
`d897803` 主页插件栏入口 → `3cd6a54` 忽略提交信息临时文件 → `1f67669` 授权热加载两阻断 bug →
`6eecc48` 懒加载+改名本地授权+弹框 → `fc990ec` 「本会话应用」改名「授权」 → `5140aa2` 工作区入口位置修复 →
`e8b9154` 三级作用域授权+三入口+弹框 → `de42ef7`/`5d15f51`/`54a7d60`/`9949293`/`fdde6e2`/`b367aef`/`3c03449`/`e999c71`
（verify 功能与归属/秒退/门面系列修复，含 `lib/verify.mjs`）→ `7fd7ce9` 旧 HANDOFF → `d562e6b` 剔除 ELECTRON_RUN_AS_NODE →
`c943afb`/`ccbba85` 行尾 LF → `1f6930d` 启动诊断三缺陷 → `4c9f3e1` ignore → `815804a` 基线。
**约定：每修一个问题做一个提交**（用户 TURN 14 要求）；中文提交信息用 `_msg.txt` + `git commit -F`（引号撞 shell 踩过坑）。

---

## 二、插件做什么 / 工具 / 门控

让 Agent **自主启动本地 AI 软件**：先查 CPU/GPU/内存，空闲才发车；配置一次后无需二次授权
（落点＝插件内部 spawn，不走带审批的外部 shell 链；Agent 不能传任意命令，只能选配置里 enabled 的条目）。

**6 个工具**：`system_status()`、`app_list()`、`app_start(id, wait=true, timeout_ms 0..600000 默认180000)`、
`app_stop(id)`（只停本插件启动的进程，沿父子链认归属）、`app_verify`（只读验证）、
`app_toggle(enabled?)` **常驻**（全局开关；其余 5 个按 enabled 动态挂/卸，旧会话即时生效）。
6 个 execute 全部包在 `runtime.withAgentScope(exec, fn)` 里（热加载关键，见§三）。

**门控默认值**（`lib/config.mjs` LAUNCHER_DEFAULTS）：`sampleCacheMs:3000`、`unreadableGpuPolicy:'reject'`、
`conflictPolicy:'reject'`（只拒绝+建议，绝不杀别人起的）、`readyTimeoutMs:180000`、`logTailLines:40`。
`MIN_LIVENESS_MS=5000`（`lib/programs.mjs`）：无 HTTP 探针的 GUI 必须活过 5s 才认就绪（exitCode 异步 null 会把秒退当成功）。

**4 个程序**（`cordis.patch.yml` 种子；共同 gpuUtilPctMax:10、cpuPctMax:80、stopTimeoutMs:20000）：
- comfyui：exe `C:\Users\wjm\AppData\Local\Programs\ComfyUI\Comfy Desktop\Comfy Desktop.exe`、args []（★入口式配置，见§五坑4）；freeVram 6000/freeRam 4096；ready `http://127.0.0.1:8188/system_stats` timeout 240000；allowedDirs 含 `F:\program\ComfyUI\{models,input,output,user}`、`H:\apps\ComfyUI\models`。
- lm-studio：`F:\program\LM Studio\resources\app\.webpack\lms.exe` args ['server','start']；12000/8192；ready 1234/v1/models。
- ninfer：`H:\apps\infer-engine-sm120a-20261002\engine\ninfer-serve-120a.exe`；ready 8094/v1/models；env NINFER_KV_* 若干。
- blender：`E:\SteamLibrary\steamapps\common\Blender\blender.exe`；4096/8192；**exclusive:'' 故意留空**（启动瞬间 GPU 利用率低，进 gpu-heavy 组会互卡）；ready.url:'' 走进程名检测。

---

## 三、授权模型四代演进（理解现行 poolVersion 2 的前提）

1. **一代**：全局 allowedDirs 总表 → 被用户否定：「授权目录应该是跟着软件走的」。
2. **二代**：per-program allowedDirs（生效＝程序自己的 ∪ 全局兜底）；路径**边界**比较（`C:\Apps2` 不被 `C:\Apps` 放行）；空名单一律拒绝；相对路径抛 ConfigValidationError。
3. **三代（e8b9154，已被四代取代）**：global/workspace/session 三级并集。目录三层并集；程序同 id 后者覆盖。工作区 key 用 canonical 路径不用 workspaceId。
4. **四代（b273496，现行 poolVersion 2）**：用户 T24 要求**收缩**——取消全局层，改**统一条目池 + 每条目按会话/工作区授权**。
   - 条目 `kind=program/script/directory`，各带 `sessions:[会话id]` + `workspaces:[工作区路径]`；两者都空=未授权（默认）。
   - 可见性：`_scopeContext===null`=管理面（设置页看全部）；`withAgentScope` 设 `{sessionId}`→`_entryVisibleTo`＝`sessions.includes(sid)` 或 所属工作区 pathKey∈`workspaces`（`_visibleEntries` runtime.mjs:526）；`sid===''` fail-closed。**工作区授权是动态的**：经 `setWorkspaceResolver`（index.js 用 workspaceRegistry 把 sid→工作区路径）解析，该工作区下新增会话自动可见，不展开成 id。
   - `visiblePrograms()` 排除 directory；`visibleDirectories()` 只 directory；`allowedDirsOf`=程序自身 dirs ∪ 可见目录条目 path。
   - 快照缓存键按视角分 `admin` / `session:<sid>`（管理面与会话面不互用）。
   - 迁移 `_migratePool()`（runtime.mjs:94）：全局目录→sessions=[] 目录条目；会话切片折进 sessions[]；工作区切片暂存 `_pendingWorkspaceGrants`，`expandWorkspaceGrants`（:203）由 index.js 的 workspaceRegistry inject 展开。
   - 会话选择器：`setSessionQuery`/`listSessions()`（:326，cap 300，标题走 readTitleSnapshots）；HTTP `GET /sessions`、`POST /config/entry-sessions`；删 `/scope`、`/config/allowed-dirs`。
   - 脚本：`buildCommand` 按 `launch.interpreter` 或扩展名推导解释器（SCRIPT_INTERPRETERS 表 config.mjs）；运行状态按解释器进程名探测 `detectProcessName`（.bat/.cmd 无法按名识别、同解释器串名——已知限制）。

**热加载（1f67669）**：修了两个阻断 bug——① `withScope` 只定义从未调用 → 会话/工作区授权对 Agent 完全不生效；② `setScopeSlice('global')` 静默丢 `slice.programs`。
修后：`withAgentScope` 从 `exec.agent.id`(=SessionId) 经宿主 `workspaceRegistry` resolver 补工作区路径再执行；写入即清 `snapshotCache`（清理点约 runtime.mjs 243/260 行）；`app_start` 的长等待 `waitStart` 也在作用域内。语义：设置页保存→下一次工具调用立即生效；撤销同样立即失效。

**懒加载（6eecc48）**：实测 **lazy 2ms vs full 4362ms**（真实 nvidia-smi+探针）。`?lazy=1` 不采样/不探针/不查端口；**lazy 结果不进快照缓存**；lazy 门控不下结论 `action=unknown, ok=null`（防 null 误判「不可启动」）；3s 轮询仅在有程序 starting/ready 时开；资源卡「测试」按钮手动取样；未检查显示「资源未检查」而非假 0%。

**入口演进**：settings.section(order 57) → 工作区侧栏入口放错致无法切换工作区（5140aa2 修）→ 会话「...」菜单 MenuScopeRow(order 460) → 用户要「工作区标题菜单加授权按钮」但 **DSH 无该 slot**（`shell.overlay` 的 workspace.session-rename/archive 证明重命名/删除是弹框、ui-workspace 内部实现）→ 用户让步 T23：**主页插件栏** `sidebar.panellist`(id=dsh-app-launcher, order 120) + `main` 同 key 配对 + `layout.selectPanel('dsh-app-launcher')`。**main.key 必须等于 panellist.id**，否则注册成功但点不开（最隐蔽失败模式，render.mjs 用例5 守着）。
显示名「本地授权」/「Local Authorization」，**包名不改**（改包名破坏安装路径与 patch id）。

---

## 四、代码结构与测试

```
lib/ index.js(入口/门面★必须显式转发每个新方法) config.mjs store.mjs edit.mjs browse.mjs
     gate.mjs sysinfo.mjs programs.mjs(★buildChildEnv) status.mjs http.mjs tools.mjs
     runtime.mjs scopes.mjs verify.mjs
client/client.js（★组合根：加载+装配+注册 slot）+ 8 个职责 chunk：client.i18n/core/hooks/
     controls/cards/sessions/form/panel.js（各导出 build(deps)，依赖显式传入，无构建步骤）
test/ verify.mjs(137) scopes.mjs(19) workspace-scope.mjs(56) lazy.mjs(19) hot-reload.mjs(13)
      facade.mjs(静态核对面面转发) render.mjs(按组件实例分派 hook 真渲染到加载分支+反向验证，17 用例)
```

跑测试：`npm run verify`（package.json scripts.verify 串起全部 7 个）。**244 项逻辑全绿**（137+19+56+19+13）+ facade + render。
workspace-scope.mjs 含工作区授权可见性（sessions OR workspaces、pathKey 归一、目录条目、fail-closed）、setEntryGrants/setEntryWorkspaces 审计、listWorkspaces、unauthCount 双空。
render.mjs 必须**反向验证**（故意改坏组件名确认会报 ReferenceError），否则假通过；v4 已修「全局 hookStore 让嵌套组件 hook 互踩」与「children 没进 props 导致子组件没渲染」两个假通过隐患。**v5（拆分后）**：loadPlugin() 模拟 `require.async` 逐个加载 chunk、await 异步 apply、用 `__DSH_LAUNCHER_TEST_HOOK__` 抓已装配模块；假 React 的 **useEffect/useCallback/useMemo 都各占一个 hook 槽、每个 effect 独立跑一次**——旧版单个 effectRan 标志会让 LauncherSection 里 useConfig 的 effect 被 useStatus 的挤掉（配置加载不出、整面板假通过）。反向验证改为替换 client.form.js 源码再加载。**v6（工作区授权）**：加 react-dom seed（createPortal 原样返回+记录 portalCalls）、假 document.body、renderNode 收集节点供点击；用例16/17 点 SessionScopeButton/MenuScopeRow 真弹框并断言 Modal+portal；点击 onClick 必须传 `{stopPropagation(){}}`。
**工具 execute 签名**：app_list/system_status 是 `execute(exec)` 单参；app_start/app_stop/app_verify/app_toggle 是 `execute(args, exec)` 双参（写测试别搞混）。

---

## 五、接手必读：极易复发的坑

1. **ELECTRON_RUN_AS_NODE**：DSH 宿主注入该变量，子进程继承 → 任何 Electron GUI 秒退零输出（实测 57ms/code=0）。`buildChildEnv()` 剔除 `ELECTRON_HOST_ENV_KEYS=['ELECTRON_RUN_AS_NODE','ELECTRON_NO_ATTACH_CONSOLE','ELECTRON_ENABLE_LOGGING','ELECTRON_ENABLE_STACK_DUMPING','ELECTRON_DEFAULT_ERROR_MODE']`，用户显式 env 优先。**别删或简化成 {...process.env}**。识别捷径：子进程报 `bad option: --xxx` ＝被当 node 跑了。PATH 有 `PATH/Path/path` 三键并存，必须大小写不敏感删全写一。
2. **新增配置字段同步三处**：normalizeX → toPersistable → 表单 toForm/fromForm。allowedDirs、launchable 各漏过一次（「界面配好重启全没」）。加字段必补「落盘再读回」测试。
3. **client 白屏＝ReferenceError**，node --check 抓不到；DSH 把崩溃 slot 整块移除。**绝不用脚本批量改/删 client.js**（曾 1081 行毁成 39 行）。
4. **配置＝软件启动入口**，不是绕 GUI 的命令（用户原话批评「你直接写了脚本在里面」）。python+main.py 入 args 的形态已否定。
5. **install_bundle/remove_bundle 半完成态**：pnpm `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`(minimumReleaseAge) 中断但已产生副作用 → 必查三处：node_modules 包在不在、`dsh.profile.bundles` 选中没、dependencies link 在不在；用 Python 补（PS 写 JSON 不可靠）。
6. **patch `config:` 整体替换不合并** → 双层配置：patch 种子 + `$DSH_HOME/app-launcher/config.json` 用户层。
7. **host 改动必须重启 DSH；client 改动刷新浏览器**；Junction 磁盘代码即时最新。GUI 端口随重启变化。
8. **asar 虚拟路径只有 read 工具能读**（grep/Python 报 os error 3）。
9. **null（读不到）≠ []（没有）**：沙箱内 spawn nvidia-smi/tasklist EPERM，宿主进程内不受限；读不到显示「未知」并拒绝危险操作。
10. PS5.1 编码/JSON 全套坑见 `C:\Users\wjm\.dsh\AGENTS.md`（改文件一律 write/edit；JSON 一律 Python）。

---

## 六、Open items（按优先级）

1. **★ 用户侧验证（必做）**：**重启 DSH + 刷新浏览器**（当前运行的宿主还是 pre-T24 旧代码，不重启则问题3「取不到会话/工作区」依旧、工作区授权也不生效）→ 旧 config 自动迁移 poolVersion 2 → 设置页「软件/脚本/目录」把 4 个出厂程序勾选授权给相应会话/工作区 → 会话内 `app_list` 应只见已授权条目；会话顶部「授权」按钮应能弹框（portal）；授权工作区后其下所有会话默认可用；不重开会话经「授权」加会话后再 `app_list` 应即时见变化（热加载）。
2. **5 秒 MiniMax H3 视频**（TURN 7 起遗留）：工作流 `F:\program\ComfyUI\user\default\workflows\my_video_minimax_h3_t2v.json`（UI 图含子图「Image to Video (MiniMax H3)」21 节点，**子图不支持提取**；路径①请用户在面板转回普通节点再提取，②手工拼 API）。**模型名待用户拍板**：工作流写 `minimax_h3_fl2va_pruned_int8_convrot` / `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16`，本机实有 `minimax_h3_fl2va_pruned_fp8_scaled`(19.52GB, H:\apps\ComfyUI\models\diffusion_models) / `minimax_h3_turbo_v4_step600_ema_pruned_comfyui`(0.58GB, loras)。5 秒=124 帧@24fps（17k+5 网格对齐）。MiniMaxH3ImageToVideo 签名：clip/vae/prompt/width(1344,step32)/height(768)/length，optional first_frame/last_frame。
3. **TURN 8 INBOX 从未处理**：「清理旧版 comfyui 是否有问题? 没有问题就删除了.同时记得更新相关记忆.」——旧后端 `C:\Users\wjm\AppData\Local\Programs\ComfyUI\resources\ComfyUI` 是 0.17.1 过时路径；未删、未写记忆。
4. （已完成）T24 权限重构：见 §〇 / §三四代，commit `b273496`。
5. （已被取代）工作区标题菜单授权按钮：无 slot，用户已接受插件栏方案。

---

## 七、环境事实

| 项 | 值 |
|---|---|
| Shell | PowerShell 5.1（pwsh.exe 不存在）；Python `C:\Users\wjm\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`（3.12，PYTHONIOENCODING=utf-8） |
| GPU | RTX 5080 / 16303 MiB |
| 沙箱 | workspace-write；写 ~/.dsh、F:\、H:\ 需 danger-full-access（用户已授权） |
| ComfyUI | 入口 `...\Programs\ComfyUI\Comfy Desktop\Comfy Desktop.exe`；后端 `C:\Users\wjm\AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\`；数据 `F:\program\ComfyUI`；模型 `H:\apps\ComfyUI\models`；**extra_model_paths.yaml 必须放 main.py 同目录**；后端直跑必须 `--base-directory F:\program\ComfyUI`；tokenizers 损坏修法＝物理删 site-packages\tokenizers* 后 `pip install --no-deps tokenizers==0.22.2`；冷启动 1–2 分钟 |

---

## 八、参考资料

- Mnemon Documents（本项目记录，搜索关键词 dsh-app-launcher）：`f1d86363` 三级作用域、`ae6c68ed` 工作区 resolver、`5b1271a3` 热加载+懒加载、`c7b4e112` 插件栏入口。
- `C:\Users\wjm\.dsh\AGENTS.md`「DSH 插件开发实测踩坑清单」。
- 底座参考：本机 `dsh-ninfer-autostart`（C:\Users\wjm\.dsh\local-plugins\，覆盖 ~80% 机制，单引擎短板）；外部 `developerdh/dsh-sandbox-allowlist`（仅借思路）。
- 会话时间线：T1–4(11/8) 调研+首版+配置可编辑+Blender；T5–10(11/8夜–11/9) 安装半完成修复/Blender 实测+手机模型交付/ComfyUI 启动苦战/授权目录；T11–16(11/9) 三点整改/白屏/记忆/git 化/ELECTRON 根因/旧 HANDOFF；T17(11/13) 三级作用域；T18–23(11/13) 入口纠偏/懒加载/改名/热加载/插件栏；T24(11/14 00:10) 权限重构需求→旧会话溢出；**T24 实现于 11/14 新会话完成（b273496）**。
