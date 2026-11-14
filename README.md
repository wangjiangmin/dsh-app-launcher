# dsh-app-launcher（显示名：本地授权）

**本地授权**：DSH 先查 CPU / GPU / 内存有没有高负载，空闲才允许 Agent 拉起
ComfyUI、LM Studio、NInfer 或任何你配置的软件/脚本。所有「软件 / 脚本 / 目录」放在**统一条目池**里，
**每条目按会话授权**（没有全局授权层）；授权给某会话后，该会话的 Agent 无需二次审批即可启动。

> 包名仍是 `dsh-app-launcher`（改名会影响 profile 里的安装路径与 patch id），
> 但界面上显示为「本地授权 / Local Authorization」。

## 一、它解决什么

本地跑 ComfyUI / LM Studio 这类重活时，最怕两件事：

1. **抢 GPU**：Blender 正在渲染、或另一个模型正在推理，Agent 又拉起一个把显存吃满 → OOM；
2. **弹权限**：每次启动都要在 DSH 里点一次审批，打断 Agent 的自主流程。

这个插件把两件事一次解决：**资源门控**决定"能不能起"，**配置白名单**决定"起谁"。

## 二、给 Agent 的 5 个 tool

| tool | 作用 |
| --- | --- |
| `app_toggle` | **常驻**：读/切换全局开关。开启后其余 4 个立刻可用，关闭后立刻从工具表消失 |
| `system_status` | CPU 占用、内存空闲、GPU 利用率/显存、**谁在占用 GPU**（pid/名称/显存） |
| `app_list` | **本会话已授权**的条目：启用状态、启动路径、资源需求、是否在跑、**当前能不能启动**；另附本会话已授权的目录 |
| `app_start(id)` | 先门控：不满足就**不发车**，返回具体读数、缺哪项、怎么办；满足则拉起并等就绪 |
| `app_stop(id)` | 只停**本插件启动**的进程，手动/提权启动的会被拒绝并说明原因 |

`app_start` 的拒绝是结构化且可行动的，例如：

```
GPU 利用率 92% ≥ 阈值 10%；空闲显存 2.2 GiB < 需要 6.0 GiB
建议：先停止 ComfyUI 再启动本程序
      或等它跑完（可先调用 system_status 观察 GPU 回落）
      当前占用 GPU 的进程：blender.exe(PID 999, 12345MiB)
```

## 二点五、全局开关与「旧会话也能用」

设置页顶部的开关切换的是**插件是否生效**，实现上直接 `register` / `dispose` 那 4 个 tool。
DSH 的工具表是**进程级全局**的，所以：

- 打开开关 → **新会话、以及此刻正开着的旧会话**，下一次组装工具表时都能看到 `app_*`；
- 关闭开关 → 立刻从工具表消失，不需要重开会话，也不需要重启 DSH；
- 只有 `app_toggle` 本身常驻——否则关掉之后就再也没办法把它打开。

这份动态挂载只在**运行期**生效；进程重启后按 `config.json` 的 `enabled` 恢复。

## 三、免二次授权的边界（重要）

启动**不走**外部 shell 工具（那条链路有审批），而是插件内部 `spawn(detached)`。
因此「免授权」的代价必须用**配置白名单**换回来：

- 只有配置里 `enabled: true` 的条目能被启动；
- 启动路径只能由**人在设置页或配置文件里**填写，Agent 无法传任意命令
  （`app_toggle` 只能开关，改不了路径与阈值）；
- 插件级 `enabled: false` 时，起停一律拒绝（仍可查看状态与列表）。

## 四、配置

配置分**两层**，这是为了「界面能改」而不破坏升级：

| 层 | 位置 | 谁写 |
| --- | --- | --- |
| patch 种子（出厂） | 包内 `cordis.patch.yml` 的 `config:` 下 | 你手写；插件升级时可能更新 |
| 用户层 | `$DSH_HOME/app-launcher/config.json` | **设置页/界面自动写**，优先于种子 |

首次启动会把种子落成 `config.json`。之后界面里的增删改都只写用户层，patch 不再参与。
设置页点「恢复默认配置」= 删除用户层，回到 patch 种子。

> 配置目录不可写时（沙箱、只读卷），保存**不会报错崩掉**：改动只在内存生效，
> 界面会显示 `persisted: false`，重启后丢失。

### 插件级

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时起停被拒绝，只读查询仍可用 |
| `verbose` | `true` | 打印日志 |
| `dryRun` | `false` | 只打印将执行的命令，不真的拉起（验证配置用） |
| `sampleCacheMs` | `3000` | 采样缓存；Agent 连发 tool 不会刷爆 nvidia-smi |
| `unreadableGpuPolicy` | `reject` | 读不到 GPU 时：`reject` 放弃 / `allow` 仍启动 |
| `conflictPolicy` | `reject` | 互斥冲突时：`reject` 只拒绝给建议 / `stop-own` 先停**本插件启动的** |
| `nvidiaSmi` | `nvidia-smi` | 可给绝对路径 |
| `readyTimeoutMs` | `180000` | 默认就绪等待上限（程序自己的 `ready.timeoutMs` 优先） |

### 每个条目（`programs[]`，统一条目池）

| 键 | 说明 |
| --- | --- |
| `id` | 唯一 id，Agent 用它在 tool 里指代（`comfyui` / `lm-studio` / `ninfer`） |
| `name` | 显示名 |
| `kind` | `program`（默认）/ `script` / `directory` |
| `sessions` | **授权给的会话 id 数组**；`[]` = 未授权任何会话（默认，最安全） |
| `path` | 仅 `directory`：授权的绝对路径 |
| `enabled` | 启用/禁用（**白名单**：false 就不给启动） |
| `description` | 一句话说明，会显示在给 Agent 的列表里 |
| `launch.exe` | 启动路径（program/script **必填**；缺了会标记 `invalid` 并在界面上报错） |
| `launch.interpreter` | 仅 script：显式解释器（留空按扩展名推导） |
| `launch.args` | 参数数组 |
| `launch.cwd` | 工作目录，默认 exe 所在目录 |
| `launch.env` | 额外环境变量 |
| `needs.gpuUtilPctMax` | GPU 利用率上限（`>=` 即拒绝） |
| `needs.freeVramMiBMin` | 空闲显存下限 |
| `needs.freeRamMiBMin` | 空闲内存下限 |
| `needs.cpuPctMax` | CPU 占用上限 |
| `exclusive` | 同族互斥组（同名组内只允许一个在跑，如 `gpu-heavy`） |
| `ready.url` | 就绪探针；GET 返回状态码 < `okStatusMax`（默认 399）即视为就绪 |
| `ready.timeoutMs` / `ready.intervalMs` | 等待上限 / 轮询间隔 |
| `stopTimeoutMs` | 发出停止信号后等端口释放的上限 |
| `logFile` | 日志落盘位置；空 = `$DSH_HOME/app-launcher/<id>.log` |

### 无端口的 GUI 程序（如 Blender）

不是所有软件都监听 HTTP 端口。**Blender**（`E:\SteamLibrary\steamapps\common\Blender\blender.exe`）
是纯 GUI 程序，没有任何健康检查端口，所以它的条目 `ready.url` 是空字符串。

对这种程序，插件的在线判定改为**按进程名探测**：

- `ready.url` 留空 → 用 `launch.exe` 的文件名（`blender.exe` → `blender`）去查进程表；
- Windows 先试 `tasklist /FI IMAGENAME eq blender.exe`，不可用时退回 `powershell Get-Process`；
- 探到 pid 即视为「运行中」，于是界面状态、外部启动识别、停止归属校验都正常工作。

安装路径下的版本目录（`4.4` / `5.0` / `5.1` / `5.2`）只是各版本的数据与脚本，
**启动一律用顶层的 `blender.exe`**。

Blender 的 `exclusive` 故意留空：它启动瞬间 GPU 利用率通常很低，
把它塞进 `gpu-heavy` 互斥组会和 LM Studio / ComfyUI 互相卡死。

## 五、门控算法

```
1. 采样（缓存 3s）：GPU 利用率 / 空闲显存 / 空闲内存 / CPU / GPU 进程表
2. 目标已在线（探针 200）→ already-running，不重复拉起
3. 同族互斥组内已有别的在跑 → reject（reject 策略）或先停本插件启动的（stop-own）
4. 逐项比对 needs：任一不满足 → reject，reason 带每一项的实际值与阈值
5. nvidia-smi 读不到 → 按 unreadableGpuPolicy（默认 reject）
6. 通过 → single-flight spawn detached，日志落盘，轮询 ready.url 到超时
```

**默认绝不杀别人的进程**：`conflictPolicy: reject` 时只拒绝并给建议。
`stop-own` 也只停本插件自己拉起的（靠 `netstat -ano` → PID → exe 路径双重核对）。

## 六、设置页面板

设置 → **本地授权**。

### 资源检查是懒加载的（重要）

进入页面**不做资源检查**——首屏只取静态信息，实测 **2 ms**；
完整采样（nvidia-smi + 每程序探针 + 端口查询）实测 **4362 ms**，相差约 2000 倍。
之前每次打开设置页都跑一遍，所以很卡。

采样只在三种时机发生：

1. 点资源卡右上角的 **「测试」** 按钮（手动，一次性）；
2. 点**启动**某个程序时（门控本来就必须采样）；
3. 有程序处于**启动中或运行中**时，按 3 秒轮询（看进度需要）。

未检查时资源卡显示「资源未检查」而不是假的 0%，门控结论也不会下
（避免用 null 读数组出「读不到 GPU」的误拒绝）。

布局是**一行一个条目卡片、字段竖向排列**（不再用横向表格，窄面板里也不会溢出）。
面板标题是 **「软件 / 脚本 / 目录」**，三类条目混排在同一张表里：

| 区块 | 内容 |
| --- | --- |
| 顶部 | **全局开关**（控制插件是否生效）+ 刷新 + 恢复默认配置 + 配置文件路径；未授权条目数 / 待迁移工作区提示 |
| 资源条 | GPU 利用率/显存、CPU、内存、占用 GPU 的进程 |
| 条目卡片 | 名称、kind 徽章（软件/脚本/目录）、用途说明、启动路径或目录路径、状态徽章、门控结论、**会话授权徽章**（未授权 / 已授权 N 个会话）、资源需求、日志折叠 |
| 卡片操作 | **启动 / 停止 / 验证 / 编辑 / 删除 / 授权**（目录条目无启动/停止/验证） |
| 编辑表单 | **类型选择（软件/脚本/目录）**、名称、id、用途说明、启动路径或脚本路径或目录路径、脚本解释器、工作目录、参数、环境变量、四项资源阈值、互斥组、就绪探针、超时、启用开关、**会话授权选择器** |
| 添加 | 顶部三个按钮 **「添加软件 / 添加脚本 / 添加目录」**，各自展开对应表单，id 留空自动从名称生成 |
| 底部 | **授权记录**折叠区（审计） |

- 「用途说明」是写**给 AI 看**的，会进到 `app_list` 的结果里，让 Agent 明白这个软件做什么；
- 资源阈值留空 = 该项不参与门控；
- **会话授权**：表单底部 / 卡片「授权」按钮 / 会话标题旁「本会话授权」入口，都能勾选把条目授权给哪些会话；
- 「启动路径」旁有**内置文件浏览器**：逐层进入目录，`.exe` / `.bat` / `.cmd` / `.ps1` / `.py` / `.sh`
  会高亮并能点选回填（宿主没有原生「选文件」对话框，这里用 `uiWorkspace.listDirectory` 自己实现）；
- 「启动时的当前目录」收在**高级选项**里，默认留空。

### 「启动时的当前目录」到底是什么

它是 `spawn(exe, args, { cwd })` 传的**子进程当前目录**，**不是安装目录**，也不是软件的
数据/工作流目录。只影响一件事：子进程里相对路径的基准。

实测各软件是否需要它：

| 软件 | 是否需要 | 依据 |
| --- | --- | --- |
| LM Studio | ❌ 不需要 | `lms server start` 只有 `-p/--port`、`--bind`、`--cors`，无任何目录参数 |
| ComfyUI Desktop | ❌ 不需要 | Electron 壳进程；真正的后端在 `resources\ComfyUI`，用户数据在 `%APPDATA%\ComfyUI`，不靠 cwd 定位 |
| Blender | ⚠️ 部分 | `blender -b file.blend` 用文件参数；只有 `--python-expr` 里写相对路径时才受 cwd 影响 |
| 普通脚本（.py/.bat/.ps1） | ✅ 需要 | 脚本内的 `open("data.csv")`、`import lib` 全靠 cwd |

所以：**能留空就留空**（默认用 exe 所在目录）。只有脚本依赖相对路径基准、或引擎要从
exe 所在目录加载同目录 DLL 时才填。

## 六点五、统一条目池 + 按会话授权（poolVersion 2）

> 2026-11-14 起（T24 权限收缩）：**不再有全局 / 工作区授权层**。
> 旧的「全局 / 工作区 / 会话」三级并集模型已废除，改为**一个统一条目池，每条目按会话授权**。

### 统一条目池

设置页面板叫 **「软件 / 脚本 / 目录」**，所有东西都是同一张表里的条目（仍存在 `config.json` 的
`programs[]` 键下，向后兼容），用 `kind` 区分三类：

| kind | 是什么 | 关键字段 |
|---|---|---|
| `program` | 可执行软件（ComfyUI / LM Studio / Blender…） | `launch.exe` |
| `script` | 脚本（`.ps1`/`.bat`/`.cmd`/`.py`/`.js`/`.mjs`/`.cjs`/`.sh`/`.vbs`/`.jar`） | `launch.exe`=脚本路径，`launch.interpreter` 可选 |
| `directory` | 授权目录（Agent 可读写、设置页可浏览的范围） | `path`（绝对路径） |

每个条目带一个 **`sessions: [会话id, …]`** 数组——**这就是授权本身**：

- 一个会话只能看到 / 启动 `sessions` 里**包含自己 id** 的条目；
- `sessions: []` = **未授权任何会话**（默认，最安全）——任何 Agent 都看不到、起不了；
- 目录条目同样按 `sessions` 授权：会话可见的目录 = 它被授权的目录条目的 `path`，再并上
  该会话可见程序自己的 `allowedDirs`。

### 可见性 / 管理面

| 视角 | 看到什么 |
|---|---|
| **设置页（管理面）** | 全部条目（不管授权给谁）——人在这里增删改、勾选授权给哪些会话 |
| **某会话的 Agent** | 只看到 `sessions` 含该会话 id 的条目；`app_list` 另附该会话已授权的目录 |
| **拿不到会话 id** | **fail-closed**：什么都看不到（绝不退化成管理面） |

### 会话选择器

编辑条目或点卡片上的「授权」，会弹出会话选择器：列出宿主里的会话（标题 / 时间 / 是否在线 /
是否子代理），勾选即授权。数据源是宿主 `sessionQuery` 服务（`listSessions` + `readTitleSnapshots`）；
没有该服务时降级用 `workspaceRegistry` 的会话列表（无标题），再没有就空列表。上限 300 条。

### 从旧模型迁移（自动，一次性）

老配置（`poolVersion` 缺省 = 1）首次加载时自动迁移成 poolVersion 2：

- 旧的**全局授权目录** → 转成 `directory` 条目，`sessions: []`（**收缩**：不再默认对所有会话开放，需重新勾选）；
- 旧的**会话切片**里的程序授权 → 折进对应条目的 `sessions[]`；会话切片的目录 → 带该会话 id 的目录条目；
- 旧的**工作区切片** → 暂存，等 `workspaceRegistry` 就绪后按工作区路径展开成它名下所有会话的授权
  （工作区已不存在则作废并记审计）；
- 迁移完写 `poolVersion: 2`、清空 `allowedDirs`、消费掉 `scopes.json` 里的旧切片。重启不会重复迁移。

`scopes.json` 现在**只留授权审计记录**（`grants[]`），不再有 workspaces/sessions 切片。
设置页与「本会话授权」面板的「授权记录」折叠区可查。

### 安全边界

- 保存条目时验证**启动路径必须存在**（脚本的显式解释器若是绝对路径也要存在）；目录只验绝对路径；
- 浏览白名单为空时**一律拒绝**，绝不退化成整盘可读；
- 目录判断用**路径边界**而不是 `startsWith`（`C:\Apps2` 不会被 `C:\Apps` 放行）；
- 全局 `allowedDirs` 字段已废除：`setGlobal` 收到它会直接报错，提示改用目录条目按会话授权。

## 七、验证

```sh
npm run verify        # 串起全部 7 个测试文件
```

不需要重启 DSH，全部用假依赖覆盖 **218 项**数值断言 + 门面完整性 + 渲染冒烟：

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `verify.mjs` | 136 | 采样解析、门控纯函数、互斥、配置归一化、运行时端到端、只停自己的进程、tool 契约、HTTP 同源；**poolVersion 2**：kind/sessions 归一化、目录校验、脚本解释器推导、buildCommand 脚本、表单互转、工具层 fail-closed |
| `scopes.mjs` | 19 | 审计存储、可见性（管理面/会话/空 sid fail-closed）、setEntrySessions、currentConfig、CRUD 落盘读回、旧模型迁移 |
| `workspace-scope.mjs` | 31 | expandWorkspaceGrants（展开/作废/审计）、listSessions（sessionQuery/降级/none/cap 300） |
| `hot-reload.mjs` | 13 | 授权/增删条目热可见、别的会话不受影响、快照缓存不挡授权变更、enabled 挂/卸 tool |
| `lazy.mjs` | 19 | 懒加载快照不采样/不探针/不污染缓存 |
| `facade.mjs` | — | http 用到的 runtime 成员都已由 index.js 门面转发 |
| `render.mjs` | 12 用例 | 真渲染到表单/卡片/会话组件的**加载完成分支**（按组件实例分派 hook），含**反向验证**（改坏组件名确认测试会报错，防假通过） |

## 八、已知边界

- **只停本插件启动的进程**：手动或提权启动的软件，插件既不代停、界面上也标「不可代停」；
- 提权启动的进程在非提权宿主里**查不到**，界面只能显示端口占用；
- ComfyUI Desktop 是 Electron 壳，冷启动到端口就绪可能要 1–3 分钟，期间显示「启动中」；
- `nvidia-smi` 只在 NVIDIA 上可用；AMD/Intel 或读不到时按 `unreadableGpuPolicy` 处理；
- LM Studio 的 GUI 进程本身会吃显存（本机实测约 3.3 GiB），建议用 headless
  `lms server start`，或给它单独设更大的 `freeVramMiBMin`；
- 就绪探针与 GPU 查询用 `fetch` / `execFile`，需要宿主 Node ≥ 18（DSH 自带 24，没问题）。

### 脚本条目的运行状态探测（重要限制）

脚本没有自己的进程名，运行状态按**解释器进程名**探测（`detectProcessName`）：

- `.py` → 查 `python`、`.ps1` → 查 `powershell`、`.js` → 查 `node`…（按推导出的解释器）；
- **`.bat` / `.cmd` 走 shell 启动，无法按名识别**——这类脚本的「运行中/已停止」判定不可靠；
- **多个同解释器脚本会互相串名**：两个 `.py` 脚本都在跑时，探到 `python` 进程无法区分是哪个，
  两个条目可能都显示「运行中」。需要精确状态时，给脚本配 `ready.url` 探针，或拆成不同解释器。

## 九、安装

```sh
dsh plugin --profile desktop add <本目录>
```

插件由**两半**组成，**都需要重启 DeepSeek Harness 才会加载**：

- 宿主半边：包 `main`（`lib/index.js`）—— 4 个 tool + 设置页接口；
- 浏览器半边：包内 `dsh.client` 声明 + `exports["./client"]`（`client/client.js`）——
  DSH 的客户端插件不是普通 ESM，而是 `window.__ModuleLoader__.load({ id, factory })`
  包一层、在 factory 里 `require('react')`，所以这个文件是手写的，**没有构建步骤**。

重启后在会话里看日志前缀 `[app-launcher]`；设置页应出现「本地应用」一节。
