# EPLAN 绘图 MCP

在对话里直接画 EPLAN2.9 图纸

> **English** — A DeepSeek Harness bundle that draws in EPLAN Electric P8 2.9. In its preset `run_code` is the model's only directly callable tool: every EPLAN operation is a `tools.mcp__eplan__*` call inside one program, so a whole page is created, validated and rendered without spilling intermediate JSON into the conversation. Twelve MCP tools speak a line protocol to `EplanBridge.exe`, which reaches the running EPLAN over .NET Remoting. A pasted screen recording is digested into staged full-page frames plus its narration before the model sees it.

目录：[一、功能和实现目标](#一功能和实现目标) · [二、它会做什么、提供什么](#二它会做什么提供什么) · [三、架构与创新点](#三架构与创新点) · [四、环境和依赖](#四环境和依赖)

---

## 一、功能和实现目标

**四个目标，按重要性排**
1.画图。
2.看视频、图片、pdf
3.呈现结果（eplan对应标签置顶）
4.保留你的绘图偏好
**明确的边界**：不做 PLC 编程、不做 3D 布局、不改 EPLAN 自身配置、不做自动备份。EPLAN API 的改动**不进 GUI 撤销栈**，动手前要退路就用 EPLAN 自己的「项目 → 复制」做完整副本。

---

## 二、它会做什么、提供什么

### 12 个 MCP 工具

同类功能收成一个工具加 `action` / `format` 参数，模型少记一套名字。宿主侧 25 个操作一个都没改名，合并只发生在 MCP 这一层。**完整参数见 [docs/interfaces.md](docs/interfaces.md)。**

| 工具 | 干什么 | 改图 |
|---|---|---|
| `workspace` | `brief` 一次拿全环境 / `list_pages` 列页 / `launch` 拉起 EPLAN / `open_project` / `create_project` / `open_page` 切页 / `present` 出图 / `plan_get`、`plan_put` 台账 / `claim`、`release` 占位 | 否 |
| `symbol_catalog` | `search` 查符号库（中文概念也行）/ `pins` 查引脚几何与朝向 / `visual` 把候选真画出来认形状 / `lookup`、`annotate` 读写工程语义 | 否 |
| `page_create` | 建页并**一次摆完整页**：`layout` 行列、`nodes` 元件、`texts` 标注，`reveal=true` 顺带出图 | **是** |
| `page_edit` | `insert_symbol` / `set_properties` / `relocate` / `relabel` / `delete_placement` / `draw_graphics` / `box`；`ops:[…]` 一次提交多步，中途失败即停 | **是** |
| `page_delete` | 删整页（清理过程页），支持 `dryRun` | **是** |
| `page_inspect` | `structure` 倒对象、坐标、引脚 / `image` 渲染成图**直接返回图片** / `both` | 否 |
| `validate` | 手绘假导线、设备标识重复、元件不在栅格、孤立引脚，外加 `appearance` 版面数字 | 否 |
| `export` | PNG / PDF / DXF；大项目 `wait:false` 先拿 jobId | 否 |
| `manual` | 把 PDF 手册页面渲染成图给你看（`outline` / `search` / `render`） | 否 |
| `operation_history` | 查真实发生过的写操作，含前后状态与能否回退 | 否 |
| `operation_rollback` | 按 `operation_id` 撤回一次写操作 | **是** |
| `lesson` | `add` 记一条经验 / `list` 读回来 | 否 |

坐标统一 **mm**，原点在页面**左下角**，**X 向右、Y 向上**，一律 `[x, y]` 数组。`reveal=true` 只把图返回给模型，**不会**切换用户屏幕上的页；要真的翻页得显式调 `open_page(focus=true)`，默认不抢前台。

### 另外两个原生工具（不进 MCP）

| 工具 | 干什么 | 为什么不走 MCP |
|---|---|---|
| `video` | 录屏 → 阶段化整页截图 + 讲解转写 + 步骤 | 转写要用 DSH 的 `speechToText`（本机 SenseVoice），MCP 是独立进程够不到 |
| `measure` | 截图/视频帧里的像素换算成毫米，找线、推栅格 | 纯本地图像计算，不碰 EPLAN |

录屏**不需要模型主动调用**：`video-digest.js` 在 `agent/pre-step` 就把上传的附件或输入框里 `@C:\…\xxx.mp4` 换成摘要，图和讲解一起进上下文。

### 6 份技能 + 1 个预设

知识不塞进提示词，只在模型判断需要时进上下文：

| 技能 | 什么时候读 |
|---|---|
| `eplan-drawing` | 排版、间距、元件放哪、已验证的电源分配页布局 |
| `eplan-symbols` | 选元件、查引脚几何、变体含义 |
| `eplan-annotations` | 标注图鉴：谁渲染、在哪、什么颜色、怎么改 |
| `eplan-review` | 交付前起审查子代理对照参考图挑差异 |
| `eplan-project` | 新建大项目：页清单、认领页、逐页闭环 |
| `eplan-troubleshooting` | 报错码、调用卡住、红线没生成、字没显示 |

预设「EPLAN 绘图自动化」只保留一种模式：模型唯一的直接工具是 `run_code`，EPLAN 工具写成程序里的 `await tools.mcp__eplan__*`，一整页的建、校、改在一段程序里跑完。`/plan` 先出方案、批准了再动手；交付前可起一个空上下文子代理专门挑差异。

### 经验库

`%LOCALAPPDATA%\eplan-mcp\knowledge\notes.jsonl`，一行一条、只追加不覆盖。**它不经过 EPLAN**：EPLAN 没开、崩了、被模态框卡住时，经验和环境总览照样能读能写 —— 那恰恰是最该把教训记下来的时刻。

---

## 三、架构与创新点

### 三层结构

```
对话（DSH 预设「EPLAN 绘图自动化」）
      │  run_code 里 await tools.mcp__eplan__*
      ▼
server/server.mjs             MCP 服务，stdio，12 个工具
      │  行协议 JSON：{id, op, args} → {id, ok, result}
      ▼
bridge/bin/EplanBridge.exe    .NET Remoting 客户端
      │  ExecuteAction("EplanMcpRun", payload)
      ▼
【 EPLAN 进程 】
      ├─ script/EplanMcpBootstrap.install.cs   装一次，极薄，只做反射转发
      └─ host/bin/EplanMcpHost.dll             真正干活：DataModel + HEServices
```

**为什么必须双层。** EPLAN 的脚本编译器把引用集写死在 `EplanEplApiScriptLogu.erx` 里，只有 `Base`/`AF`/`Gui`/`RecorderTools`/`EServices` 这几支，**没有 `DataModel`，也没有 `HEServices`** —— 而建页、布线、导出全在这两个程序集里。直接写 `.cs` 脚本会在编译期就死（`CS0234: 命名空间"Eplan.EplApi"中不存在"DataModel"`）。唯一的绕法是：自己用 `csc.exe` 编译 DLL（不受那个引用集约束），脚本里只出现 `System.Reflection`，运行时把 DLL 反射加载进 EPLAN 的 AppDomain —— 那时 EPLAN 早就加载过 `DataModelu`，类型自然对得上。

另外两个坑代码里已处理：`SynchronousMode` 必须显式设 `true`（否则 `ExecuteAction` 对**任何**动作名——包括不存在的——都返回成功且拿不到结果）；`ActionCallingContext` 没有 `Get`/`Set`，要拿 `ContextParameterBlock` 才有。

### 九个创新点

1. **红线不画，只摆符号。** EPLAN 的红色连接线不是图元，是软件根据「引脚是否共点、是否朝向相对」自动补的，分支点还会自动长接头。所以正确画法是**一个线条图元都不画**：自己画的线是青绿色 `Graphics.Line`，和真图纸不是一回事。成品页实测 0 条手绘线。
2. **一页一次调用。** `page_create` 收 `layout`（行列毫米）+ `nodes` + `texts`，557 ms 出整页并返回图 + 结构化数据，对照逐件调用 15 次往返。
3. **版面看相。** `validate` 的 `appearance` 把「摆得好不好看」变成数字：分组数、组间空隙、同列间距、四边余量。`=JQR2623/7` 实测组间中位空隙 84 mm，工具独立得出了用户原话「一些组可以聚拢一点」的同一结论 —— 这种话以后不用用户说。
4. **深色渲染。** EPLAN 导出只有打印配色（白底蓝符号），没有参数可选。宿主在渲染后按像素重新上色成用户屏幕上的深色方案（黑底、黄符号、红导线、白图框），要白底交付图时传 `theme:"light"`。颜色在原理图里有含义，不能糊弄。
5. **录屏真能看懂。** 一次 ffmpeg 出每秒整屏序列 + 顶部标题条，按「刷新重画」切阶段（最小 15 秒），每段取最稳的一帧，语音按响度切段逐段转写（服务只回整段文字、不带时间戳，不自己切就永远对不上画面）。图是 JPEG q3、长边 1600、**逐张发、绝不拼图** —— 同一帧 PNG 要 700 KB。
6. **缓存与显卡解码。** 摘要按 `sha1(路径:字节:时间戳)` 落盘，第二次调用不解码；要某一秒的整页图只回那一张，几分之一秒。采样解码默认走显卡，关键在**哪些帧被拷回内存**：解码和 `fps` 都留在显存里，只把每秒那一帧 `hwdownload` 回来 —— 带 `-hwaccel_output_format` 逐帧隐式下载反而比纯 CPU 慢 2 倍。解不了会自动降级回软件解码。
7. **失败就说事实，不让模型猜。** 超时不再是一个笼统的 `EPLAN_TIMEOUT`：桥接器枚举 EPLAN 的 `#32770` 窗口，报 `EPLAN_BLOCKED_BY_DIALOG` 并写出对话框标题；探测 2 秒无响应就标记不健康；**同一错误同一参数再来一次直接劝停**并给替代动作；符号名写错（`DCP`）直接给候选（`RCP`）和下一步。
8. **工具面固定。** 五种模式工具面一字不差（21,019 字符，预算 22.5k）。少裁几个工具省不下多少 token，却会让提示词前缀变化、把缓存打断 —— 稳定前缀比小工具面更值钱。
9. **多实例护栏。** 同一台机器开两个 EPLAN，项目被抢会产生模态框，MCP 干等到超时、用户看到的是「卡死」。所以开项目前先问当前实例、再用 .NET `FileShare.None` 独占探测 `.lck`（Node 的 `fs.open` 一律共享，永远得出「没锁」的错误结论），被占就返回 `PROJECT_LOCKED_BY_OTHER_INSTANCE` 而不是硬开；`launch` 也遵守「探测不到 ≠ 没在跑」，不许起第二个实例。

更多踩坑史和可迁移的方法论在 [docs/LESSONS.md](docs/LESSONS.md)。

---

## 四、环境和依赖

| 需要什么 | 说明 |
|---|---|
| Windows 10 / 11 | 渲染配色、PDF 走系统自带 `Windows.Data.Pdf` |
| EPLAN Electric P8 2.9 | 必须开 **Remoting**（现装版本默认开，监听 49152） |
| .NET Framework 4.x | 用系统自带 `csc.exe`（C# 5）编译宿主和桥接器，**不需要装 SDK** |
| Node.js 20+ | MCP 服务端 |
| DSH | 承载预设与 `video` / `speechToText` |
| ffmpeg（可选） | 只有录屏摘要和量图需要；找不到报 `VIDEO_NO_FFMPEG`，可用 `EPLAN_MCP_FFMPEG` 指定 |

### 安装

```powershell
# 1. 装进 DSH profile 并加进 dsh.profile.bundles
dsh plugin --profile <name> add github:monta-6969/dsh-eplan

# 2. 一次性 setup：找 EPLAN、写配置、在本机编译宿主与桥接器、注册引导脚本
node node_modules/dsh-eplan/setup.mjs        # 打印「全部就绪」即成功
```

**必须在本机编译**：宿主 DLL 引用的是本机 EPLAN 的程序集，2.9 与 2.10 的 API 不同，拷别人编好的 DLL 会 `MissingMethodException`。换机器、升级包之后都要重跑 `setup.mjs`。手动编译、单独注册脚本、卸载的细节见 [INSTALL.md](INSTALL.md)。

### 自检

不碰 EPLAN 就能跑，改完任意一侧都该全绿（22 个用例）：

```powershell
node test\check-docs.mjs        # 文档与工具面一致
node test\tool-face.mjs         # 工具面预算，且各模式一字不差
node test\present-offline.mjs   # 出图 job 化、占用门
node test\video-cache.mjs       # 录屏摘要缓存，at 只取一张图
node test\video-decode.mjs      # 硬件解码与软件解码采样逐点相同
node test\appearance-offline.mjs  # 版面看相：分组、空隙、间距、四类问题
node test\launch-offline.mjs      # launch 决策：不许起第二个实例
node test\fuzzy-offline.mjs       # 符号名写错给候选
```

其余见 `test\` 目录。需要 EPLAN 在跑的是 `test\smoke-all.mjs`、`test\raw-smoke.mjs`、`test\mcp-e2e.mjs` 等 5 个 —— 被模态框挡住时它们会超时，那不是回归。

### 已知限制

- **多实例**：同一时间只用一个 EPLAN 会话，多个会话各起一个服务会抢 Remoting 端口。
- **模态框会挡住一切 API**：启动时的「系统消息」「检查相容性」属于 EPLAN 自己弹的，关掉即可，不需要重启。注册过的脚本文件不要手删，否则每次启动都弹 `S046001`。
- **写操作不可撤销**：EPLAN API 的改动不进 GUI 撤销栈。用 `dryRun` 先看清楚，或用项目复制留退路。
- **`manual` 走渲染不走抽文字**：电气手册的字体常常没有 `ToUnicode` 映射，抽出来是乱码（`琤慵ᢈ≥挶`）。

### 目录与文档

```
eplan-mcp/
├── cordis.patch.yml      DSH 预设定义
├── server/               MCP 服务（12 工具）+ 录屏管线 + 压缩与纠错
├── bridge/               Remoting 客户端
├── host/                 进程内宿主（EPLAN 一侧的真正实现）
├── script/               引导脚本模板与引用集预校验
├── skills/               6 份知识文件
├── test/                 离线用例 + 需要 EPLAN 的冒烟测试
└── docs/                 interfaces.md（接口契约）、LESSONS.md（复盘）
```

| 想看什么 | 去哪 |
|---|---|
| 每个工具的确切参数 | [docs/interfaces.md](docs/interfaces.md) |
| 为什么这样设计、踩过哪些坑 | [docs/LESSONS.md](docs/LESSONS.md) |
| 安装、验证、卸载 | [INSTALL.md](INSTALL.md) |
| 模型侧的知识 | [skills/](skills/) |

MIT License.
