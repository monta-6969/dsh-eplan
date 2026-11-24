# EPLAN 绘图 MCP


> **English** — A DeepSeek Harness bundle that draws in EPLAN Electric P8 2.9. It adds an agent preset in which `run_code` is the only directly callable tool: every EPLAN operation is a `tools.mcp__eplan__*` call inside one program, so a page is built, validated and finished without spilling intermediate JSON into the conversation. The 12 MCP tools are `workspace`, `symbol_catalog`, `page_create`, `page_edit`, `page_delete`, `page_inspect`, `validate`, `export`, `manual`, `operation_history`, `operation_rollback` and `lesson`; they speak a line protocol to `EplanBridge.exe`, which reaches the running EPLAN process over .NET Remoting. A pasted screen recording is digested into staged full-page frames before the model sees it.
>
> **Requirements:** Windows, EPLAN Electric P8 2.9 with Remoting enabled (port 49152), .NET Framework 4.x for `csc.exe` (no SDK), Node.js 20+. Install with `dsh plugin --profile <name> add github:monta-6969/dsh-eplan`, add `dsh-eplan` to that profile's `dsh.profile.bundles`, then **run the one-time setup before any tool works**: `node node_modules/dsh-eplan/setup.mjs` — it locates EPLAN, writes `%LOCALAPPDATA%\eplan-mcp\eplan.config.json`, compiles the host DLL and the bridge against your own EPLAN assemblies, registers the bootstrap script and prints `全部就绪`. Re-run it after upgrading the package, because the compiled binaries live inside the package directory.
通过对话操作 EPLAN Electric P8 2.9 —— 建页、画线、插元件、读属性、导出预览图。

---

## 它是怎么工作的

```
对话（DSH 预设「EPLAN 绘图自动化」）
        │
        ▼
server/server.mjs             ← MCP 服务，stdio，12 个工具
        │  行协议 JSON：{id, op, args} → {id, ok, result}
        ▼
bridge/bin/EplanBridge.exe    ← .NET Remoting 客户端
        │  ExecuteAction("EplanMcpRun", payload)
        ▼
   【 EPLAN 进程 】
        │
        ├─ script/EplanMcpBootstrap.install.cs   ← 装一次，极薄，只做反射转发
        │
        └─ host/bin/EplanMcpHost.dll             ← 真正干活的：DataModel + HEServices
```

### 为什么必须是这种双层结构

EPLAN 的**脚本编译器**把引用集写死在 `D:\EPLAN\Platform\2.9.4\Bin\EplanEplApiScriptLogu.erx` 里，只有这十几个：

```
mscorlib, System, System.Core, System.Drawing, System.XML, System.Xml.Linq,
System.Windows.Forms, System.IO.Compression.FileSystem,
Eplan.EplApi.Baseu, Eplan.EplApi.AFu, Eplan.EplApi.Guiu,
Eplan.EplApi.RecorderToolsu, Eplan.EplApi.EServicesu
```

**没有 `Eplan.EplApi.DataModelu.dll`，也没有 `Eplan.EplApi.HEServicesu.dll`。**

而建页、画线、插符号、导出全都在这两个程序集里。所以直接写 `.cs` 脚本会在编译期就失败：

```
CS0234: 命名空间"Eplan.EplApi"中不存在类型或命名空间名称"DataModel"
```

这不是写法问题，是 EPLAN 的硬限制。绕过办法只有一个：**自己用 `csc.exe` 编译 DLL**（不受那个引用集约束），再让脚本事先反射加载它。脚本里一个 DataModel 类型都不出现，只用 `System.Reflection`（mscorlib，编译器有）。

宿主 DLL 进入 EPLAN 的 AppDomain 后，EPLAN 自己早就加载过 `DataModelu`，所以类型能对上，不需要任何额外加载。

### 两个必须知道的坑（已踩过，代码里已处理）

1. **`SynchronousMode` 必须显式设为 `true`。**
   默认异步时 `ExecuteAction` 对**任何**动作名都返回 `true`，包括不存在的动作，也拿不到返回结果。

2. **`ActionCallingContext` 没有 `Get` / `Set`。**
   要用 `context.GetContextParameter()` 拿到 `ContextParameterBlock`，后者才有 `Get(string, ref object)` / `Set(string, object)`（注意是 `ref` 不是 `out`）。

---

## 安装

### 1. 编译

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File host\build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File bridge\build.ps1
```

产出：
- `host\bin\EplanMcpHost.dll`
- `bridge\bin\EplanBridge.exe`

两个脚本都调用 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（C# 5 语言版本，源码里不能用字符串内插、`?.`、`nameof`、表达式体成员）。

### 2. 生成引导脚本

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File script\prepare-install.ps1
```

产出 `script\EplanMcpBootstrap.install.cs`，里面的 `HostPath` 已替换成本机绝对路径。

### 3. 装进 EPLAN（**手动，一次性**）

在 EPLAN 里：

1. **文件 → 脚本 → 运行脚本…**
2. 选 `script\EplanMcpBootstrap.install.cs`
3. 执行

成功后注册动作 `EplanMcpRun`。日志写在：

```
C:\Users\Public\EPLAN\Data\eplan-mcp\bootstrap.log
```

> **不需要重启 EPLAN。** 脚本是运行时装进去的。

### 4. 自己验证一下

```powershell
# 应该看到 EPLAN 实例的 pid / 端口
echo '{"id":1,"op":"ping","args":{}}' | bridge\bin\EplanBridge.exe

# 应该返回宿主版本和当前项目
echo '{"id":1,"op":"diagnose","args":{}}' | bridge\bin\EplanBridge.exe
```

---

## 12 个工具

同类功能合并成「一个工具 + action/format 参数」，模型少记一套名字。合并只发生在 MCP 这一层，
底下调用的宿主 op 一个都没改名。

| 工具 | 作用 | 是否改图 |
|---|---|---|
| `workspace` | `action="brief"` 一次拿全环境 / `focus` 选当前模式**推荐**哪几个工具（工具面固定 12 个，不按模式裁剪）/ `list_pages` 列页 / `launch` 拉起 EPLAN（工作目录与等 Remoting 都处理好了）/ `open_project` / `create_project` / `open_page` / `present` 切页出图 / `wait` 等 present job / `plan_get`/`plan_put` 台账 / `claim`/`release` 占位 | 否 |
| `symbol_catalog` | `action=search` 查符号库（中文概念也行）/ `pins` 查每个变体的引脚坐标与朝向 / `visual` 把几个符号真画到临时页上渲一张图认形状 / `lookup` 查工程语义 / `annotate` 写回语义 | 否（`annotate` 只改知识库；`visual` 会建一张临时页再删掉） |
| `page_create` | **新建页并一次摆完整页**：`layout` 给行列、`nodes` 给元件、`texts` 给标注，`reveal=true` 自动出图 | **是** |
| `page_edit` | `action=insert_symbol` 补元件 / `set_properties` 读写属性 / `relocate` 挪一个对象 / `relabel` 改设备标识 / `delete_placement` 删一个对象 / `draw_graphics` 画纯图形（可上色）/ `box` 画黑箱（黄框 + 连接点）；`ops:[{...}]` 一次提交多步（中途失败即停） | **是** |
| `page_delete` | 删整页（清理过程页），支持 `dryRun` | **是** |
| `page_inspect` | `format=structure` 倒出对象/坐标/引脚，`image` 让 EPLAN 渲染成图**直接返回图片**，`both` 两样都要 | 否 |
| `validate` | 查手绘假导线、设备标识重复、元件不在栅格、孤立引脚；`appearance` 一节给版面数字（分组、组间空隙、同列间距、四边余量） | 否 |
| `export` | 导出 PNG / PDF / DXF；大项目用 `wait:false` 先拿 jobId，`workspace(action="wait")` 收文件清单 | 否 |
| `manual` | 把 PDF 手册页面渲染成图给你看（`outline` / `search` / `render`） | 否 |
| `operation_history` | 查真实发生过的写操作，含前后状态与能否回退 | 否 |
| `operation_rollback` | 按 `operation_id` 撤回一次写操作 | **是** |
| `lesson` | `action="add"` 记一条经验 / `list` 读回来。跨会话留存踩过的坑和验证过的做法 | 否（只写经验文件） |

`reveal=true` 只把页渲染成图返回，**不会**切换 EPLAN 里当前显示的页。
要让用户看到某一页，才显式调 `workspace(action="open_page", focus=true)`；
`focus` 默认 `false`，因为把窗口拿到前台会打断用户正在做的事。

### 多实例护栏：为什么 `open_project` 有时拒绝开项目

同一台机器上开两个 EPLAN 时，一个项目被其中某个实例打开后，另一个实例再开它，
EPLAN 会弹「多用户冲突 / 数据库被另一用户单独锁定」的**模态框**。这个框挡住 EPLAN 的
消息循环，MCP 调用只能干等到超时，用户看到的是「卡死」。所以 `open_project` 先做两件事：

- 问当前连着的实例：项目是不是已经开着 → 开着就直接返回 `alreadyOpen:true`，不再开一次；
- 探测项目 `.edb` 目录里的 `*.lck` 是否还被进程握着 → 被占且本机不止一个 EPLAN 时，
  返回 `PROJECT_LOCKED_BY_OTHER_INSTANCE` 并说清是哪几个进程，不去硬开。

`workspace(action="status")` 会带上 `eplanProcesses`（本机 EPLAN 进程号）和 `instancesHint`
（多于一个实例时的提醒），第一个调用就能看见机器上有几个窗口。

判定锁必须用 .NET 的 `FileShare.None` 独占打开：Node 的 `fs.open` 一律以共享读写打开，
EPLAN 也允许共享，用 `fs.open` 永远会得到「没锁」的错误结论。

### 第 13 个工具：`video`（录屏）

上面的 12 个走 MCP；`video` 是预设里挂的一个原生工具，因为转写要用 DSH 的
`speechToText` 服务（本机 SenseVoice），而 MCP 是独立进程，够不到那个服务。

**模型不需要主动调用它**：`video-digest.js` 在 `agent/pre-step` 里就把录屏换成摘要。
两种送法都认——上传的**文件附件**，和在输入框里打的 `@C:\...\xxx.mp4`（DSH 把它变成纯文本，
2026-11-23 实测用户就是后者，只认附件的那版根本没触发，模型只好自己调 `video()` 抽帧）。

管线（`server/video.mjs`）：

1. `ffprobe` 读时长/分辨率；
2. 一次 ffmpeg 出两份每秒序列：整屏缩放图（看画面变化）+ 顶部标题条（看翻页/换章节）；
3. 按「标题栏重画 / 整屏重画」切阶段，**最小间隔 15 秒**，再把最长的段对半拆到上限；
4. 每段取「最稳」的一帧（窗口靠后，越往后越接近成品）；
5. 响度门限切语音片段（门限随峰值自适应），逐段交给 SenseVoice —— **必须我们自己切**，
   因为那套服务只返回整段文字、不带时间戳；不切就永远对不上画面。

图是 **JPEG q3、长边 1600、逐张发、绝不拼图**。为什么不是 PNG：2880×1800 的录屏截一帧
缩到 1920 宽的 PNG 有 700 KB，6 段就是 3.9 MB 一次进上下文（实测）。同一帧 JPEG 只要 1/4。
自动摘要那次最多 4 张——一步最多 8 张新图的硬限制里，符号图鉴还要占 4 张。

没有声音、或本机没装转写服务时只给画面，`讲解：` 那行写明原因（空 / 失败 / 没有音轨）。

#### 采样走显卡解码

第 2 步「每秒采样一遍」要把整段录屏的每一帧都解码，这是整条管线最贵的一步。
现在默认交给显卡解码（`-hwaccel cuda` / `d3d11va`），实测 1080p、632 秒的录屏：

| 解码方式 | 耗时 |
|---|---|
| 纯 CPU | 19.2 s |
| cuda + 只在 `fps=1` 之后下载那 1 帧 | **9.6 s** |
| cuda 不带 `-hwaccel_output_format`（逐帧隐式下载） | 27–52 s（比 CPU 还慢） |

关键不在「开硬件解码」，而在**哪些帧被拷回内存**：解码、`fps` 都留在显存里做，
只把每秒那一帧 `hwdownload` 回来，再 `split` 成整屏/标题条两路。逐帧下载会把
省下的解码时间全赔在显存→内存拷贝上，这是最容易被抄错的一处。

- 短素材不走硬件：12 秒测试片实测硬件 350 ms、纯软件 101 ms，初始化摊不平。
  门槛默认 120 秒，`EPLAN_MCP_HWACCEL_MIN_SECONDS` 可调。
- 显卡解不了（老 VP9、AV1、虚拟显卡、驱动异常）会自动**降级回软件解码**并记住这次失败；
  结果与纯软件逐点相同（`test/video-decode.mjs` 用同一段视频跑两条路径比对）。
- 开关：`EPLAN_MCP_HWACCEL=auto|off|cuda|d3d11va`（写死具体型号表示强制用，短片也照用）。
- 单帧取图（`grabFrame`）**不**走硬件：每次调用要建一次解码上下文，单帧反而更慢。

`ffmpeg` 不是硬依赖：找不到会报 `VIDEO_NO_FFMPEG`，可用环境变量 `EPLAN_MCP_FFMPEG` 指定。

### 第 14 个工具：`measure`（量图，同样不进 MCP 工具面）

把截图/视频帧里的像素换算成毫米，替代「数格子再心算」：

- `calibrate`：两个已知像素点 + 真实毫米 → `pxPerMm`；低于 8 px/mm 直接给 `warning`（误差超过半个像素对应的毫米数）。
- `edges`：沿行/列找明暗跳变（图框线、器件边框、栅格线），带 `pxPerMm` 与原点时直接给 mm。
- `grid`：从线的间距推主导间距（栅格或器件极距），带 `confidence`。

解码走 `ffmpeg` 的 rawvideo 灰度输出，不引第三方图像库；阈值默认 Otsu，找不全线时降到 16。

### 经验文件

`workspace(action="status")` 的返回里带 `lessons`：最近 5 条经验、总数和文件位置。
模型不必为了「先看前人教训」多花一次往返。

文件在 `%LOCALAPPDATA%\eplan-mcp\knowledge\notes.jsonl`，一行一条、**只追加不覆盖**。
旧版本把它放在 `%TEMP%` 下，启动时会一次性复制过来（旧文件保留不删）——临时目录会被磁盘清理扫掉，
而这份数据的全部价值就是跨会话留下来。

**经验库不经过 EPLAN**：`lesson` 由 MCP 服务直接读写文件。EPLAN 没开、崩了、被模态框卡住时，
经验和 `workspace(action="status")` 照样能看能记 —— 那恰恰是最需要把教训写下来的时刻。

目标收尾时会自动提醒一次：`update_goal` 成功返回后，结果里会多一段提示让你把经验记下来
（`experience-nudge.js`）。它只是提醒，不拦着不让完成目标。

和 `symbol_catalog(action="annotate")` 的分工：annotate 记「这个符号是什么」（按符号索引、会覆盖），
lesson 记「这套流程哪里会踩坑」（按时间追加、不覆盖）。


### 红线是 EPLAN 自动生成的，不要自己画

这是这个项目最重要的一条经验：EPLAN 里那根**红色连接线**不是图元，
是软件根据「符号的连接点是否同轴、是否朝向相对」自动补的。
自己用 `page_edit(action="draw_graphics")` 画出来的线是青绿色的 `Graphics.Line`，和真实图纸不是一回事。

所以正确的画法是：**一个线条图元都不画，只摆符号**。
两个符号的引脚落在同一条线上、朝向相对时，EPLAN 自己就连上了，分支点还会自动画接头。

查引脚几何用 `page_inspect(format="structure")` 的 `members` 参数，或看返回里每个符号的 `pins`：

| 符号 | 引脚（相对符号原点的偏移，mm） | 用途 |
|---|---|---|
| `CO` v0 / v3 | Right(0,0)+Down(0,0) / Left(0,0)+Down(0,0) | 总线转角 |
| `TLRU` v8 | Right(0,0) + Left(0,0) + Down(0,0) | T 节点 |
| `TOUR` v0 | Down(0,0) + Up(0,0) + Right(2,0) | 带上支路的 T 节点 |
| `F1` | Up(0,+4) + Down(0,-4) | 单极熔断器 |
| `CDPST` | Up(0,+4) + Down(0,-4) | 电源引入点 |

`CO` / `TLRU` / `TOUR` / `CDPST` 在 `SPECIAL` 库，`F1` 在 `GB_symbol` 库。

### 打开页面：动作名要试

改完图必须 `workspace(action="open_page")`，否则用户屏幕上还停在别的页。EPLAN 里跳页的动作名没文档，试出来的结果：

| 动作 | 结果 |
|---|---|
| `XSeGotoGraphicOpenPageAction` | 调用不报错，**什么也不做**。`ModuleName` 是 `SearchAndReplaceGui`，是搜索结果跳转专用，别被名字骗了 |
| `XGedOpenPageName` | 确实存在，但参数不对时会把页切到 `/1`，行为诡异 |
| **`OpenPageAction` + 参数 `PageName`** | 唯一正确的一对，实测标题能从 `=MCP/2` 切到 `=MCP/8` |

动作名是从 `D:\EPLAN\Platform.9.4\Bin` 下的 DLL 里 grep 字符串找到的：
```
grep -a -o -h -E "[A-Za-z_]{2,40}OpenPage[A-Za-z_]{0,20}" *.dll *.erx *.exe | sort -u
```

**窗口切换有个坑**：桥接器是后台进程，直接调 `SetForegroundWindow` 会被 Windows 拒绝（只闪一下任务栏）。要叠三段：`ShowWindow(SW_RESTORE)` + `SetWindowPos(TOPMOST→NOTOPMOST)` + `SwitchToThisWindow`。

**等待标题刷新必须放在桥接器里做**，不能放在宿主：宿主跑在 EPLAN 主线程上，它 `Thread.Sleep` 会把界面锁死，标题永远更新不了。

### 设备标识为什么用文字画

`PropertyPlacement` 在 EPLAN 2.9 里**造得出对象、画不出字**：
符号自带的那些摆放 `Height` 全是 `-16002`（隐藏哨兵），
自己 `Create` 出来的即使 `Height=2.5`、`GetDisplayString()` 也拿到了值，
`Export.GraphicPageEx` 渲染出来仍然是空白 ——
开不开 `UseLocalPropertyPlacements`、`bFromDevice` 传 true/false 都试过，全都不显示。

所以 `page_edit(action="insert_symbol")` 的设备标识标签改用 `Graphics.Text` 直接画：
一定能看到、位置完全可控。代价是改设备标识时标签文字不会自动跟随。

### 坐标约定

- 单位 **mm**
- 原点在**页面左下角**
- **X 向右，Y 向上**

所有坐标都是 `[x, y]` 数组。

### 渲染配色：默认深色

EPLAN 的导出 API 没有配色方案参数，`GraphicPageEx` 永远输出打印配色（白底、蓝色符号、
红色导线、黑色图框），而用户的 EPLAN 屏幕是深色方案（黑底、黄色符号、红色导线、浅色图框）。
颜色在原理图里有含义，所以渲染完由宿主按像素重新上色（`host/src/DarkScheme.cs`）：

| 导出里的墨色 | 深色方案 |
|---|---|
| 白底 | 黑底 |
| 灰色（图框、标题栏） | 白色 |
| 蓝色（符号、文字） | 黄色 |
| 红色（连接线） | 红色（不变） |

`page_inspect(format="image")`、`page_create(reveal=true)`、`export(kind="png")` 默认都是深色；
要给别人的白底交付图时传 `theme: "light"`。PDF/DXF 不受影响，仍是 EPLAN 原样导出。

### 元件方向：换变体，不是转角度

用户口中的「按 Tab 可以转 90°」在 API 里没有对应的旋转参数 —— `SymbolReference` 只有
`Location` 和 `SymbolVariant`，没有角度属性。能控制方向的只有变体号：`page_create` /
`page_edit(action="insert_symbol")` 的 `variant`。

变体的顺序**不保证**是 0/90/180/270，每个符号库各自定义。实测 `GB_symbol` 的 `F1`：
v0 竖放、v1 横放、v2 竖放（镜像）、v3 横放。所以选变体要按 `symbol_catalog(action="pins")`
返回的引脚相对坐标和 `direction`（引脚朝外方向）来挑，不能按「每加 1 就是转 90°」推。

### 写操作的三个安全措施

1. **`dryRun: true`**：只返回"将要做什么"，不落图
2. **失败回滚**：`page_edit(action="draw_graphics")` 中途失败会把本次已画的图元全部删掉，不留半成品
3. **操作历史**：每次写操作都进 `operation_history`，能撤的（建页、插元件）可以 `operation_rollback` 撤销

**没有自动备份。** 早期版本会在写操作前复制一份 `.elk`，但那只是 30 字节的链接文件，
不是项目数据库 —— 见下面「关于备份」。那个机制连同结果里的 `backup` 字段都已经删掉。

---

## 常见错误

| 错误码 | 含义 | 怎么办 |
|---|---|---|
| `EPLAN_NOT_RUNNING` | 没检测到运行中的 EPLAN | 先打开 EPLAN |
| `HOST_NOT_INSTALLED` | 没装引导脚本 | 走上面第 3 步 |
| `NO_PROJECT` | EPLAN 里没开项目 | 先打开一个项目 |
| `PROJECT_READONLY` | 项目只读 | 换项目或取消只读 |
| `PAGE_NOT_FOUND` | 页名不对 | 先用 `workspace(action="list_pages")` 列出现有页名 |
| `PAGE_EXISTS` | 页已存在 | 换页号 |
| `SYMBOL_NOT_FOUND` | 符号名不对 | 先用 `symbol_catalog(action="search")` 查 |
| `LIBRARY_NOT_FOUND` | 符号库名不对 | 看 `workspace(action="status")` 返回的 `symbolLibraries` |
| `PROJECT_LOCKED_BY_OTHER_INSTANCE` | 项目正被另一个 EPLAN 实例占着 | 在那个窗口里干活、关掉多余实例，或按「默认」编辑模式重开项目 |
| `EPLAN_BLOCKED_BY_DIALOG` | EPLAN 弹了模态框（常见的是「系统消息」），主线程被占住 | 把那个框关掉再重试。框里如果是 `S046001 未找到指定的脚本文件`，说明 EPLAN 里注册过、但文件已经被删的脚本：到 EPLAN 的脚本注册列表里取消注册，或把文件放回去。**注册过的脚本文件不要手动删**，否则每次启动都会弹这个框 |

重启电脑后如果第一次调用就报 `EPLAN_BLOCKED_BY_DIALOG`，先看 EPLAN 是不是停在「系统消息」上：
那个窗口是 EPLAN 自己弹的，和 MCP 无关，但会挡住所有 API 调用。关掉即可，不需要重启 EPLAN 或 DSH。

页名不是自由字符串，是**结构标识 + 页号**：

```
=EB3+ET1/1
 │    │    └ 页号
 │    └ 安装位置
 └ 高层功能
```

`=EB3/5`、`+ET1/3` 也都是合法的。

---

## 自检

```powershell
# 引导脚本能否通过 EPLAN 脚本编译器的引用集（改完脚本必跑）
powershell -NoProfile -ExecutionPolicy Bypass -File script\verify-bootstrap.ps1

# MCP 服务能否正常握手、列出工具
node test\raw-smoke.mjs
```

`verify-bootstrap.ps1` 用的是从 `EplanEplApiScriptLogu.erx` 里逐字抄出来的引用集，**和 EPLAN 实际编译脚本时一模一样**。它报错，EPLAN 里一定也报错；改脚本后先跑它，能省掉反复进 EPLAN 试的时间。

不碰 EPLAN 就能跑的那一批（改完任意一侧都该全绿）：

| 脚本 | 测什么 |
|---|---|
| `test\present-offline.mjs` | present/export 的 job 化、占用门、**五个模式工具面完全一致** |
| `test\tool-face.mjs` | 工具面预算（单一预算 22.5k；模式之间一字不差，前缀才不会被打破） |
| `test\video-cache.mjs` | 录屏摘要缓存：第二次调用不重新解码，`at` 只取一张图 |
| `test\video-decode.mjs` | 硬件解码与软件解码采样逐点相同 |
| `test\video-offline.mjs` | 摘要正文结构 + 缓存命中时只回一张图 |
| `test\appearance-offline.mjs` | 版面看相：分组、组间空隙、同列间距、四类问题 |
| `test\fuzzy-offline.mjs` | 符号名写错时的候选（DCP → DCPL） |
| `test\page-edit-args.mjs` | `page_edit` 同一个 `to` 的两种含义（标识字符串 / 坐标） |
| `test\compact-offline.mjs` | `page_inspect` 载荷三档体积与几何问题 |
| `test\image-budget.mjs` | 一步最多 8 张图的配额 |
| `test\measure-offline.mjs` | 像素→毫米标定与找线 |
| `test\offline-guidance.mjs` / `nudge-offline.mjs` / `notes-offline.mjs` / `preferences-offline.mjs` | 提示词与经验库的行为契约 |
| `test\arg-shape.mjs` / `prompt-budget.mjs` / `restrict-tools.test.mjs` / `idempotent-offline.mjs` | 参数形状、人设预算、工具遮罩、幂等性 |
| `test\check-docs.mjs` | 文档与代码一致（工具数、示例命令） |

`test\_smoke-live.mjs` 和 `test\smoke-all.mjs` 要 EPLAN 在运行且**没有模态框挡着**——被挡住时它们会超时，那不是回归。

---

## 预设（自定义模式）

这个仓库同时是一个 DSH 对话预设（`@local/dsh-eplan-preset`）。装好之后在会话模式里选
**「EPLAN 绘图自动化」**，就得到一个只会画 EPLAN 的助手：没有 bash、没有联网。

### 一种模式：`run_code` 包办

v0.12 起只保留 PTC 模式（旧的逐工具模式已删除）：模型唯一的直接工具是 `run_code`，
EPLAN 的 12 个工具变成程序里的 `await tools.mcp__eplan__*`。这样一整页的建页、校验、
改画可以在一段程序里跑完，整页 JSON 不进对话历史。

- 适合：整页绘制、循环校验、批量读页、对照参考图反复修。
- 代价：模型要自己写程序；出错只能从 `print` 里查。
- 计划模式：`/plan` 仍然可用，`exit_plan_mode` 在程序里单独调用。
- 插件表最后一行必须是 `tool-executor-ptc`：它把上面所有工具从「直接可调用」改成
  「程序内 SDK 绑定」。这个执行器在 host 层默认关着，只在预设里挂才生效。

### 预设的组成

| 组成 | 作用 |
|---|---|
| `persona` | 唯一的一段提示词：身份、工作循环、硬约束、何时读知识文件 |
| `mcp-eplan` | 12 个 `mcp__eplan__*` 工具，作用域仅限本预设 |
| `tool-fs` | 只开 `read` / `readImage`：读参考图和 `skills/` 下的知识文件 |
| `tool-ask-user` | 需求不清时提问 |
| `restrict-tools` | 遮掉宿主与上下文插件多余的工具（工作目录、pwsh 安装器、MCP 资源、goal 创建、`acp_*`/`decompress`/`search_context`），只留 `compress`；bili 的工具是异步注册的，所以在 apply / agent-created / turn-start 三处各扫一遍 |
| `command-goal` + `tool-goal` | `/goal`，以及模型自己判断「可以交付」并收尾 |
| `experience-nudge` | 目标收尾时提醒写经验 |
| `video-tool` | `video(path)`：录屏 → 原尺寸截图 + 讲解转写 + 步骤 |
| `tool-subagent` | `subagent`：交付前起一个空上下文审查子代理，对照参考图挑差异（`skills/eplan-review`） |
| `planning` | `/plan` 与 `exit_plan_mode`：先出方案，批准了再动手 |
| `compaction` | 单条工具结果太长时裁剪（不是上下文压缩） |

### `/plan`：先出方案再动手

会话里打 `/plan` 进入计划模式。这时模型只能勘察——`workspace`（`action="status"` 或
`"list_pages"`）、`page_inspect`、`symbol_catalog`、`validate`、`manual`、读知识文件——
不能建页、不能改图、不能写经验。它要交出的计划必须能直接照着画：页名与类型、`layout` 的列与行（毫米）、
每个元件的库/符号/变体/设备标识、文字标注、怎么验证（`validate` 期望的 verdict、
红线会不会出来），以及已知风险（这个库没有的符号、引脚间距太紧连不上）。

批准之后才退出计划模式开始画。**预设必须自己挂一份 `plan-mode` 并在 `isolate` 里开
独立域**——host 层那份属于别的会话作用域，预设里 `/plan` 切的是这一份。
（踩过的坑：漏了 `isolate: { planMode: true }` 或漏挂，`/plan` 不报错但什么也不发生。）

### 为什么知识放技能而不是塞进提示词

一页图纸的排版参数、几十个符号的引脚坐标、一整张错误码表，全塞进 `persona` 会挤掉
真正要画的图。技能只在模型判断需要时才进上下文：

| 技能 | 什么时候读 |
|---|---|
| `eplan-drawing` | 排版、间距、元件放哪、已验证的电源分配页布局 |
| `eplan-symbols` | 选元件、查引脚几何、变体含义 |
| `eplan-annotations` | 标注图鉴：器件标识/连接点代号/手写文字谁渲染、在哪、什么颜色、怎么改 |
| `eplan-review` | 交付前用审查子代理对照参考图挑差异，怎么给图、怎么读结果 |
| `eplan-project` | 新建大项目：页清单、认领页、逐页闭环、汇总呈现 |
| `eplan-troubleshooting` | 报错码、调用卡住、红线没生成、字没显示 |

### 一页 = 一次调用

实测每次 EPLAN 操作只要 **130 ms**，真正贵的是**模型往返**（一次几秒）。所以画一页不该拆成
十几个 `page_edit(action="insert_symbol")`：

```jsonc
// 一次调用：建页 + 摆 10 个元件 + 写 10 条标注 + 打开 + 出图
page_create {
  "name": "=MCP/10", "project": "test", "type": "Schematic",
  "nodes": [
    {"symbol":"CDPST","library":"SPECIAL","at":[72,252],"deviceTag":"L24"},
    {"symbol":"TLRU","library":"SPECIAL","variant":8,"at":[116,236],"showDeviceTag":false},
    {"symbol":"F1","library":"GB_symbol","at":[72,200],"deviceTag":"-F4"}
  ],
  "texts": [{"at":[67,178],"text":"L24-1","height":2.5}],
  "reveal": true
}
```

返回 `blocks: text, image(24KB)` —— 图和结构化数据一起回来。整页实测 **557 ms**，
对照之前逐件调用要 15 次往返。

### 超时不再靠猜

EPLAN 最常见的「假死」是模态对话框占住主线程，所有 API 一起挂死。桥接器现在超时会
枚举 EPLAN 进程的 `#32770` 窗口，直接报 `EPLAN_BLOCKED_BY_DIALOG` 并写出对话框标题，
而不是干等一个 `EPLAN_TIMEOUT`。

### 关于备份（说实话）

早期版本在每次写操作前复制一份 `.elk` 到 `%TEMP%\eplan-mcpackups\`，还在结果里给了个 `backup` 字段。
**那是个假保障**：`.elk` 只是 30 字节的链接文件，真正的数据在 `test.edb` 目录里（实测 63 MB），
而且项目打开时被 EPLAN 锁着，复制出来也不保证一致。这个机制已经删掉 —— 与其给一个让人误以为有退路的
字段，不如说清楚没有退路。

所以：**EPLAN API 的改动不进 GUI 撤销栈，不可撤销。** 想留退路要在动手前用 EPLAN 自己的
「项目 → 复制」做一个完整副本，或者先 `dryRun` 把方案看清楚。

### 两个刻意的设计

- **`page_inspect(format="image")` 直接返回图片内容**，不是返回路径。返回路径的话模型每次都得再叫一次
  `read_image`，多一轮往返，而且很容易不看图就说"画好了"。一次调用同时给图和
  结构化数据，才不会出现没验收就交活。
- **`workspace(action="status")` 返回 `visiblePage`**：用户当前屏幕上显示的是哪一页。数据改对了但界面
  停在别处，对用户来说等于没做，这一点必须可查询。

## 目录

```
eplan-mcp/
├── cordis.patch.yml              DSH 预设定义（preset-eplan）
├── package.json
├── locale/{zh,en}.json
├── icon.svg
├── server/server.mjs             MCP 服务
├── bridge/
│   ├── build.ps1
│   └── src/{Program.cs,Json.cs}  Remoting 客户端
├── host/
│   ├── build.ps1
│   └── src/                      进程内宿主（Entry / Context / 各工具）
├── script/
│   ├── EplanMcpBootstrap.cs      引导脚本模板
│   ├── prepare-install.ps1       生成带真实路径的安装版
│   └── verify-bootstrap.ps1      用 EPLAN 引用集预校验
└── test/
    └── raw-smoke.mjs             MCP 协议冒烟测试
```

## 新增（0.3.0）

### manual —— 读手册

DSH 内置解析器不支持 xref-stream / object-stream 的 PDF，而电气手册基本都是这种。
`manual` 工具绕开它：`outline` 看结构，`render` 把页面渲染成图给模型看。

关键取舍：这本 FR-D700 手册的字体没有 ToUnicode 映射，抽出来的文字是乱码
（`琤慵ᢈ≥挶`）。所以走**渲染**而不是抽文字 —— 交给 Windows 自带的
`Windows.Data.Pdf`（`server/pdf2png.ps1`），零依赖、中文清晰，一次最多 4 页
（模型一步只收 8 张图，页数上限要留余量；超额的图还会被 `image-budget.js` 换成路径文字）。

### 建项目 —— `workspace(action="create_project")`

```js
workspace { action: "create_project", name: "三菱变频器", creator: "modada", dryRun: true }
// → elkPath / template / wouldCreate，先看一眼再真建
```

用 `ProjectManager.CreateProject(elk, template)`，模板默认 `GB_tpl001.ept`。

项目属性（作者）用 `PropWriter` 写。这里踩了两个坑，都写进代码注释了：

- `project.Properties["PROJ_XXX"]` 这种字符串索引器对**所有** `PROJ_` 标识名都抛
  `S063109属性无效`，别用。
- 对同名成员直接 `GetProperty` 会抛 `AmbiguousMatchException`，因为每个属性名都有
  重载（一个单值、一个带 `Int32 index` 的多值版本）。

唯一可行：遍历 `GetProperties()` 挑 `GetIndexParameters().Length == 0` 的那个。
**作者 = `PROJ_CREATORLONGNAME`**（另有 `PROJ_RESPONSIBLEFORPROJECT` 项目负责人）。

### validate —— 规范检查

EPLAN 不会因为你画错而报错。`validate` 把「画得规不规范」变成可验收项：
手绘假导线、设备标识重复、元件不在栅格、孤立引脚。

实测 `=MCP/10` 判定「这页没问题，可以交付」：10 个符号、23 个引脚、3 处引脚共点、
0 条手绘线。

### setup.mjs —— 换机器只跑一条命令

发现 EPLAN（注册表 + 常见安装路径）、校验 csc/node、写 `server/eplan.config.json`、
**在本机重新编译**宿主和桥接器、注册引导脚本、跑 `workspace(action="status")` 自检。

必须在本机编译：宿主 DLL 引用的是本机 EPLAN 的程序集，2.9 和 2.10 的 API 不一样，
把别的机器编好的 DLL 拷过来会 MissingMethodException。

## 0.3.0 续：栅格吸附与真符号落图

### 栅格吸附（`grid`）

`page_create` 的 `grid` 参数（默认 4 mm）把元件和文字的坐标自动吸到栅格上，
并把改动逐条报回来：

```json
"snapped": [ { "index": 0, "symbol": "F1", "from": [61,151], "to": [60,152] } ]
```

为什么要报回来：EPLAN 靠栅格对齐引脚，坐标差 0.5 mm 红线就连不出来；但调用方
如果不被告知坐标变了，就会以为自己给的位置生效了。

### 摸清符号库的办法

`symbol_catalog(action="search")` 只返回名字/类型/变体号，**没有描述**，所以只能看形状。别一个个插入——
把十几个候选符号成批摆到一张临时页上、旁边标上名字，一次 `page_inspect(format="image")` 全认出来：

```
page_create { "page": "=TMP/1",
              "nodes": [ {"symbol":"T11","at":[40,230]}, ... ],
              "texts": [ {"at":[31,246],"text":"T11"} ] }
page_inspect { "format": "image", "page": "=TMP/1", "width": 2000 }
```

靠这个认出来的关键符号：`T11` 三相变压器、`TS11` 单相变压器、`QSF3` 三极带熔断器
隔离开关、`QSF4` 三极+N、`HLED` 指示灯、`X`/`X2`/`X3_*` 端子、`TISPQ` 整流、`TISTQ` 逆变。

### 第一页成品

`三菱变频器` 项目的 `=MI/1`：进线 → `-QF0` → 母线 → 四路熔断器 → `-T1` 隔离变压器。
11 个元件、31 个引脚、**0 条手绘线**，红线全部由 EPLAN 按引脚位置自动生成。
`validate` 判定「这页没问题，可以交付」。

关键手法：竖列上的元件之间**不画线**，只要引脚同轴相对，EPLAN 自己补线；横向母线用
`TLRO` v8 / `TLRU` v8 / `CO` v3 这几个「三引脚都在原点」的节点拼出来。

