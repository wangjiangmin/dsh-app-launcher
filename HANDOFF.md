# 交接文档：dsh-app-launcher（显示名：本地授权）

> 更新 2026-11-14 · 取代 11/9 版（旧版在 git `7fd7ce9`）· 给新会话接手用
> 来源会话「资源监控与软件自启动插件方案」= `session-2be05f3c-fa59-4574-8127-b502bcf27867`
> （2026-11-08 19:57 → 11-14 01:00，27 轮，1269 次工具调用；上下文 ~1,048,365 tokens 溢出而死）。
> 原始日志：`C:\Users\wjm\.dsh\sessions\--D-wjm-Documents-deepseek-harness-default-workspace--\session-2be05f3c-fa59-4574-8127-b502bcf27867\session.v4.jsonl.zstd`（多帧 zstd，按 magic `28 B5 2F FD` 切帧解）。

---

## 〇、一句话现状与置顶未完成项

插件**已安装可用**：desktop profile bundles 已选中、Junction 链接指向工作区、用户层配置在位、
**183 项逻辑测试全绿** + 门面/渲染测试、git HEAD `d897803`、工作区干净。

**★ 置顶未完成 = 用户最后一条需求（TURN 24，11-14 00:10），一行代码都没写：**

> 「1. 收缩权限 , 不允许全局开发授权.将目录合并到软件/脚本这个面板上,更新为 `软件/脚本/目录`面板,进行统一管理. 2. 每一条`软件/脚本/目录`的面板上添加一个会话授权,可选择授权给那个会话.」

- 已确认代码无痕迹（grep `软件/脚本/目录|会话授权` 零命中），git 停在 `d897803`。
- 会话里唯一动作：`cordis_inspect_query listConfigs` 返回的是**配置目录不是会话列表**（不对路）。
- 下一步原计划：查宿主 `sessions` / `sessionQuery` 服务拿会话列表（会话选择器的前置依赖）。
- 设计草案（仅推理）：统一条目池，每条带 `sessions:[…]` 授权列表；取消全局授权层；未授权条目对会话默认不可见。
- 注意与现行三级作用域模型（§三）的关系：这是用户对权限模型的**再次重构**，方向是收缩而非扩张。

**会话死因**：T26 `/compact` 未真正压缩（只输出一段中途截断的文本，无 compress 调用）；
T27 切模型后首 attempt 即 `400 … "Range of input length should be [1, 983616]"`，code=CONTEXT_WINDOW_EXCEEDED。
**新会话不要试图复活旧会话，直接以本文档接手。**

---

## 一、位置 / 安装 / 配置

| 项 | 值 |
|---|---|
| 源码 | `D:\wjm\Documents\deepseek-harness\default-workspace\dsh-app-launcher` |
| 安装 | `C:\Users\wjm\.dsh\profiles\desktop\node_modules\dsh-app-launcher`（Junction → 工作区，代码即时生效） |
| profile | `C:\Users\wjm\.dsh\profiles\desktop\package.json`：bundles 含 `dsh-app-launcher`；dependencies `link:D:/wjm/Documents/deepseek-harness/default-workspace/dsh-app-launcher` |
| 用户层配置 | `C:\Users\wjm\.dsh\app-launcher\config.json`（patch 只当出厂种子） |
| 作用域存储 | `C:\Users\wjm\.dsh\app-launcher\scopes.json`（`{version, workspaces[<路径>], sessions[<id>], grants}`，MAX_GRANTS=500） |
| 启动日志 | `C:\Users\wjm\.dsh\app-launcher\comfyui.log` 等（插件侧诊断也落盘，不再 0 字节） |

**git 全链（新→旧）**：
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

## 三、授权模型三代演进（理解 T24 重构的前提）

1. **一代**：全局 allowedDirs 总表 → 被用户否定：「授权目录应该是跟着软件走的」。
2. **二代**：per-program allowedDirs（生效＝程序自己的 ∪ 全局兜底）；路径**边界**比较（`C:\Apps2` 不被 `C:\Apps` 放行）；空名单一律拒绝；相对路径抛 ConfigValidationError。
3. **三代（e8b9154，现行）**：global/workspace/session 三级。目录＝三层并集去重；程序同 id 后者覆盖（会话>工作区>全局），`app_list` 标来源层。**工作区 key 用 canonical 目录路径不用 workspaceId**（工作区可删后重建，用 id 会丢授权）。不照搬参考项目 `dsh-sandbox-allowlist` 的沙箱 hook（单层白名单），只借「可视化编辑+实时生效」。

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
client/client.js（手写客户端插件；ErrorBoundary 外层包分区+内层包每表单；Modal 弹框表单）
test/ verify.mjs(121) scopes.mjs(14) workspace-scope.mjs(12) lazy.mjs(19) hot-reload.mjs(17)
      facade.mjs(静态核对面面转发) render.mjs(真渲染+用例4/5 slot 注册与 key 配对)
```

跑测试：`npm run verify`（package.json scripts.verify 串起全部 7 个）。183 项逻辑全绿（121+14+12+19+17）。
render.mjs 必须**反向验证**（故意改坏组件名确认会报 ReferenceError），否则假通过。

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

1. **★ T24 权限重构**（§〇）：取消全局授权层；「软件/脚本/目录」统一面板；每条目按会话授权。前置：宿主会话列表 API（listConfigs 不对路，查 sessions/sessionQuery）。
2. **5 秒 MiniMax H3 视频**（TURN 7 起遗留）：工作流 `F:\program\ComfyUI\user\default\workflows\my_video_minimax_h3_t2v.json`（UI 图含子图「Image to Video (MiniMax H3)」21 节点，**子图不支持提取**；路径①请用户在面板转回普通节点再提取，②手工拼 API）。**模型名待用户拍板**：工作流写 `minimax_h3_fl2va_pruned_int8_convrot` / `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16`，本机实有 `minimax_h3_fl2va_pruned_fp8_scaled`(19.52GB, H:\apps\ComfyUI\models\diffusion_models) / `minimax_h3_turbo_v4_step600_ema_pruned_comfyui`(0.58GB, loras)。5 秒=124 帧@24fps（17k+5 网格对齐）。MiniMaxH3ImageToVideo 签名：clip/vae/prompt/width(1344,step32)/height(768)/length，optional first_frame/last_frame。
3. **TURN 8 INBOX 从未处理**：「清理旧版 comfyui 是否有问题? 没有问题就删除了.同时记得更新相关记忆.」——旧后端 `C:\Users\wjm\AppData\Local\Programs\ComfyUI\resources\ComfyUI` 是 0.17.1 过时路径；未删、未写记忆。
4. **用户侧验证待做**：11/13 的 host 改动需重启 DSH+刷新；验证法＝会话内 `app_list` → 经「🔐 授权」加程序 → 不重开会话再 `app_list` 应见新条目。
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
- 会话时间线：T1–4(11/8) 调研+首版+配置可编辑+Blender；T5–10(11/8夜–11/9) 安装半完成修复/Blender 实测+手机模型交付/ComfyUI 启动苦战/授权目录；T11–16(11/9) 三点整改/白屏/记忆/git 化/ELECTRON 根因/旧 HANDOFF；T17(11/13) 三级作用域；T18–23(11/13) 入口纠偏/懒加载/改名/热加载/插件栏；T24–27(11/14) 权限重构需求→溢出。
