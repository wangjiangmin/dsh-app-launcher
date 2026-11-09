# 交接文档：dsh-app-launcher 插件

> 交接时间 2026-11-09 · 上一个会话末尾 · 给新会话接手用

---

## 一、一句话现状

插件**主体已完成并安装可用**（104 项测试全绿、设置页可用、4 个工具已注册），
**唯一未完成的是用户最初想要的"生成一条 5 秒视频"**——卡在模型名不匹配，需要用户拍板。

---

## 二、项目位置与仓库

| 项 | 值 |
|---|---|
| 源码（工作区） | `D:\wjm\Documents\deepseek-harness\default-workspace\dsh-app-launcher` |
| 安装位置 | `C:\Users\wjm\.dsh\profiles\desktop\node_modules\dsh-app-launcher`（**Junction 链接**指向工作区） |
| 用户层配置 | `C:\Users\wjm\.dsh\app-launcher\config.json` |
| git 仓库 | 已初始化在源码目录，6 次提交 |

**git 历史（新会话接手前先看这个）**：

```
d562e6b fix: 剔除 ELECTRON_RUN_AS_NODE，让 Electron 类 GUI 程序能真正被启动
c943afb chore: 按 .gitattributes 重新规范化行尾
ccbba85 chore: 统一行尾为 LF（避免整文件假 diff）
1f6930d fix: 启动失败无日志、秒退误判成功、manual 程序白等超时
4c9f3e1 chore: 忽略 __pycache__ 与临时文件
815804a chore: 建立插件项目基线
```

工作区干净，无未提交改动。

---

## 三、插件做什么

让 DSH 的 Agent 能**自主启动本地 AI 软件**：先查 CPU/GPU/内存是否有高负载，
空闲才允许拉起；配置一次后无需二次授权。

**5 个工具**：

| 工具 | 作用 |
|---|---|
| `app_toggle` | 常驻：读/切全局开关（开关本身不能被开关关掉） |
| `system_status` | CPU / 内存 / GPU 利用率与显存 / 谁在占用 GPU |
| `app_list` | 已配置程序：路径、资源需求、是否在跑、**当前能不能起** |
| `app_start(id)` | 先门控，不满足则**不发车**并给读数与建议 |
| `app_stop(id)` | **只停本插件启动的进程**，外部的拒绝并说明原因 |

**已配置 4 个程序**（见 `cordis.patch.yml`）：ComfyUI、LM Studio、NInfer、Blender。

---

## 四、代码结构

```
lib/
  index.js     插件入口：注册 tool、挂设置页 HTTP、按 enabled 动态挂载/卸载
  config.mjs   配置归一化 + 路径白名单（isPathAllowed / effectiveAllowedDirs）
  store.mjs    两层配置：patch 种子 → $DSH_HOME/app-launcher/config.json 用户层
  edit.mjs     增删改校验 + validateProgramPaths（保存时验证路径存在性）
  browse.mjs   受限目录列举（只允许程序自己的 allowedDirs）
  gate.mjs     门控纯函数：资源阈值 / 同族互斥 / decideStart
  sysinfo.mjs  CPU·内存·GPU 采样（带缓存）
  programs.mjs 生命周期：spawn / 就绪轮询 / 归属判定 / 停止；★buildChildEnv
  status.mjs   状态快照（tool 与设置页共用）
  http.mjs     同源 HTTP：status / config / browse / start / stop / log
  tools.mjs    5 个 tool 的 schema 与实现
client/client.js   设置页组件（手写客户端插件，非普通 ESM）
test/verify.mjs    104 项逻辑测试
test/render.mjs    渲染冒烟测试（抓 ReferenceError，语法检查抓不到）
```

**跑测试**：

```powershell
cd D:\wjm\Documents\deepseek-harness\default-workspace\dsh-app-launcher
node test/verify.mjs   # 104 项
node test/render.mjs   # 表单渲染
```

---

## 五、★ 接手必读：三个已修但极易复发的坑

### 坑 1：`ELECTRON_RUN_AS_NODE` 让所有 GUI 程序秒退（最容易误判）

DSH 宿主自己是 Electron 打包的，会把 `ELECTRON_RUN_AS_NODE=1` 注入子进程环境。
**任何 Electron GUI 程序被它一带就变纯 Node 模式：不建窗口、秒退、零输出。**

同一个 `Comfy Desktop.exe` 实测：带该变量 → 57ms 退出；剔除 → 正常启动。

已在 `lib/programs.mjs` 的 `buildChildEnv()` 修复。**不要把它删掉或简化成 `{...process.env}`。**

识别捷径：子进程报 `bad option: --xxx` 就说明它被当 node 跑了（真 Electron 不会这样报）。

### 坑 2：新增配置字段要同步改三处

`normalizeX`（读入）→ `toPersistable`（落盘）→ 表单 `toForm/fromForm`（界面）。

**我在这上面犯了两次**：`allowedDirs` 漏了落盘，`launchable` 又漏一次。
症状是"界面配好了，重启后全没了"。
**加字段后必须补一条"落盘再读回"的测试**（现在已有 3 条守着）。

### 坑 3：client 白屏是 `ReferenceError`，`node --check` 抓不到

DSH 会把崩溃的 slot entry 整块移除，用户看到的是"点一下，界面全没了"。

已加两道防线：
1. `ErrorBoundary` 包分区 + 包每个表单（崩溃只显示错误与重试）
2. `test/render.mjs` 真渲染组件树

**纪律：绝不用脚本批量改/删 `client/client.js`。** 我这么干过一次，把 1081 行写坏成 39 行。

---

## 六、★ 唯一未完成项：生成 5 秒视频

### 状态

- ComfyUI **已能由插件启动**（修复后实测：进程存活 20s+，8188 端口 10 秒内就绪，
  `comfyui_version=0.44.0`，PyTorch 2.10+cu130）
- 工作流已定位：`F:\program\ComfyUI\user\default\workflows\my_video_minimax_h3_t2v.json`
- **但跑不起来：模型名对不上**

### 阻塞点：模型名不一致（需要用户拍板）

| 工作流里写的 | 本机实际有的 |
|---|---|
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `minimax_h3_fl2va_pruned_fp8_scaled.safetensors`（19.52 GB, `H:\apps\ComfyUI\models\diffusion_models`） |
| `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | `minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors`（0.58 GB, `H:\apps\ComfyUI\models\loras`） |

其余 3 个模型都在：两个 VAE + `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`(14.61 GB, clip)。

**待用户确认**：是否直接用实际的 `fp8_scaled` 与 `turbo_v4_step600` 替代工作流里的名字。

### 技术要点（已查清，可直接用）

**工作流结构**：1 个子图 `Image to Video (MiniMax H3)`（21 节点）+ 5 个外层节点。
外层 `#140` 的类型就是子图 ID，`widgets_values[0]` 是提示词。

**关键节点签名**（已从 `/object_info` 实测）：

```
MiniMaxH3ImageToVideo:
  required: clip, vae, prompt(多行), width(默认1344,step32), height(默认768,step32),
            length(帧数@24fps，提示 124≈5秒)
  optional: first_frame, last_frame
  outputs: CONDITIONING, LATENT
```

**5 秒 = 124 帧 @ 24 fps**（模型按 17k+5 帧网格对齐：`max(5,round(sec*24)) + (5-(x%17))%17`）。

**子图内部关键参数**（从连线反推）：
- UNETLoader #127 / LoraLoaderModelOnly #134（turbo LoRA，strength 由 `-10` 槽控制）
- CLIPLoader #128 (type=`minimax`)、VAELoader #119(视频VAE) / #120(音频VAE)
- KSamplerSelect #123 = `res_multistep`，BasicScheduler #124 = `simple`
- CreateVideo #130 = 24fps + 音频；SaveVideo #92 前缀 `video/MiniMax_H3`

### ⚠️ 子图不支持提取

技能文档明确"子图实例不支持"，所以不能走 `comfyui_workflow` 的提取流程。
**两条可行路径**：

1. **请用户在 ComfyUI 面板里把子图转换回普通节点，再提取**（最稳）
2. 手工按子图定义拼 API 工作流（可行但要小心连线与 widget 顺序）

---

## 七、环境事实（接手前必知）

| 项 | 值 |
|---|---|
| Shell | PowerShell **5.1**（`pwsh.exe` 不存在）；改文件一律用 `write`/`edit` 工具 |
| Python | `C:\Users\wjm\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`（3.12，自带 Pillow/numpy 等） |
| GPU | RTX 5080 / 16303 MiB |
| 沙箱 | workspace-write；写 `~/.dsh`、`F:\`、`H:\` 需 `danger-full-access` |
| 提权用户已授权 | 是（多次用于改 `~/.dsh` 下的配置与启动服务） |

**关键**：host 侧代码改动**必须重启 DSH 才生效**；client 侧改动**刷新浏览器**即可。

---

## 八、立即要做的事（按优先级）

1. **确认模型名替代** → 用户拍板后，走第六章的两条路径之一生成 5 秒视频
2. 若用户仍看到"启动失败"，先查 `C:\Users\wjm\.dsh\app-launcher\comfyui.log`
   —— 现在日志会记录**命令、环境、pid、退出码、存活时长、被剔除的变量**，不再是 0 字节
3. 需要重启 DSH 才能让 `buildChildEnv` 生效

---

## 九、给用户交代的边界（别过度承诺）

- **只停自己启动的进程**：手动/提权启动的程序，插件拒绝代停（防误杀）
- **互斥默认只拒绝不杀**（`conflictPolicy: reject`）；`stop-own` 也只停本插件启动的
- **ComfyUI 冷启动 1–2 分钟**，期间界面显示"启动中"
- **`launchable: false` 的机制仍保留**：用于将来确实只能手动启动的程序，
  会在 0ms 明确拒绝而不是白等超时
