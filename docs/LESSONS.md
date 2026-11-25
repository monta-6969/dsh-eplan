# 给 EPLAN 造一个 MCP：复盘

这份文档记录的不是"做了什么功能"，而是**在摸不清对手底细时，怎么一步步把能力挖出来**。
目标是下次遇到别的闭源工程软件（AutoCAD、SolidWorks、Altium、CATIA…）能照着走。

---

## 一、最终形态

```
对话（DSH 预设「eplan绘图自动化」）
   ├─ 12 个 MCP 工具  → Node MCP 服务 → EplanBridge.exe → EPLAN 进程内宿主 DLL
   └─ 1 个原生工具  video（录屏 → 原尺寸截图 + 讲解转写 + 步骤）
```

- 宿主 DLL 用 `csc.exe`（C# 5）编译，跑在 EPLAN 进程里，拿到完整 DataModel。
- 一次调用能建整页：`page_create` 带 `layout` 行列 + `nodes` 元件 + `texts` 标注，557 ms 出整页。
- 红线不是画的，是 EPLAN 根据引脚对齐自动生成的——这是整个项目最反直觉的一点。

---

## 二、最值钱的六条方法论

### 1. 日志是唯一事实源，文档不是

EPLAN 把自己的每次失败写进 `C:\Users\Public\EPLAN\Electric P8\EplLog.eldb`——**一个 SQLite 库**，
表 `TSysMsg_v100`。官方给的转换器 `EplanLogFileConverteru.exe` 会挂起，但用 `node:sqlite` 的
`DatabaseSync` 只读打开，一条 SQL 就能拿到：

```
CS0234 (行:40): 命名空间"Eplan.EplApi"中不存在"DataModel"
CS1061 (行:30): "ActionCallingContext"不包含"Get"的定义
S085021: 无法找到操作 'EplanMcpRun'
脚本功能不支持 Eplan.EplApi.ApplicationFramework.ActionCallingContext 类型的参数。
```

**这四行直接决定了架构走向**。没有日志，我大概会花两天去猜"为什么动作没注册"。

> 可迁移：任何有日志的软件，先找到它的日志存储（往往是 SQLite / 压缩文件 / 内存环形缓冲），
> 再动手写代码。日志里的一句话，抵得上十次盲试。

### 2. 反射枚举胜过读文档

没有 .NET SDK，但有 EPLAN 的 DLL。用 PowerShell 的 `ReflectionOnlyLoadFrom` +
`ReflectionOnlyAssemblyResolve` 就能把每个类的构造函数、方法签名、属性、枚举值全列出来：

```powershell
$asm.GetType('Eplan.EplApi.DataModel.Page').GetMethods(...)
```

`DocumentType.Circuit = 1`、`PointD(double x, double y)`、`Export.GraphicPageEx(Page, String, Format, Int32, Int32, Compression, Boolean)`
—— 这些全是这么拿到的，而且**比任何在线文档都准**（版本对得上）。

> 可迁移：有 DLL 就反射，有类型库就 tlbimp，有头文件就 grep。文档会过期，二进制不会。

### 3. 常量藏在二进制里

EPLAN 的脚本编译器**硬编码**了一份引用集。官方文档没写，但它把这份列表当字符串存在
`EplanEplApiScriptLogu.erx` 里。用"提取可打印 ASCII 串"的老办法挖出来：

```
mscorlib.dll, System.dll, System.Core.dll, System.Drawing.dll, System.XML.dll,
System.Xml.Linq.dll, System.Windows.Forms.dll, System.IO.Compression.FileSystem.dll,
Eplan.EplApi.Baseu.dll, Eplan.EplApi.AFu.dll, Eplan.EplApi.Guiu.dll,
Eplan.EplApi.RecorderToolsu.dll, Eplan.EplApi.EServicesu.dll
```

**里面没有 `DataModelu.dll`** —— 这一条直接判定「纯脚本路线死刑」，促成双层架构。

> 可迁移：`strings` 一把梭。产品里那些"为什么这样不行"的答案，常常是某个数组常量。

### 4. 一次只改一个变量

关键判断都是最小可证伪实验：

| 问题 | 实验 | 结论 |
|---|---|---|
| `ExecuteAction` 成功了吗？ | 拿**不存在的动作名**去调 | 默认异步时恒返回 `true` → 必须 `SynchronousMode = true` |
| 脚本动作能收参数吗？ | 传 `Payload` 读回 | `GetContextParameter()` 返回 `null` → 改文件 IPC |
| 设备标识能画出来吗？ | 造一个再渲染 | `GetDisplayString()` 有值、图上是空的 → 改用 `Graphics.Text` |
| 红线怎么来的？ | 两个 `FA3` 竖直对齐再截图 | 自动出现 3 条红线 → 靠摆位，不是画线 |
| ffmpeg 能定位画面区域吗？ | `tblend=difference` + `bbox` | 逐帧输出 `x1/x2/y1/y2`，可用 |

### 5. "看起来成功"是最危险的信号

这个项目里所有真 bug 都伪装成成功：

- `ExecuteAction` 对不存在的动作返回 `true`（异步默认）。
- `PropertyPlacement.Create()` 成功、`GetDisplayString()` 有值、渲染是空白。
- `ExecuteScript` 返回 `True succeed=True`，但脚本编译失败了——`Message` 是空的。
- `Page.Create()` 成功，但页名退化成 `/1`（结构属性没生效）。
- zod schema 少写一个字段，参数**静默丢弃**，功能"实现了但不生效"。
- YAML 块标量缩进错一行，字段被吞，不报错。

> 对策：每个写操作后都回读一次真值，别信返回值。`look` / `inspect` / `validate` 三个工具
> 本质上就是"回读器"。

### 6. 先造观测工具，再造功能

顺序是：`diagnose` → `inspect`（倒出页面全部对象）→ `look`（从软件内部渲染成图）。
有了这三个，后面每加一个功能都是"改一下、看一眼"。没有它们，EPLAN 是个黑盒。

`look` 的调用是 `Export.GraphicPageEx(page, outDir, PNG, 24, 2400, None, false)`，
**第二个参数是输出目录不是文件名**——传 `.png` 会被建成一个目录。这个坑靠返回值才发现的。

---

## 三、EPLAN 侧的硬约束（都是实测出来的）

| 现象 | 根因 | 结论 |
|---|---|---|
| 脚本里 `Eplan.EplApi.DataModel` 不存在 | 脚本编译器引用集硬编码，无 `DataModelu.dll` | 逻辑必须放进自编译 DLL，用反射加载 |
| 动作注册不上 | `ExecuteScript` 只跑 `[Start]`，不注册 `[DeclareAction]` | 用 `RegisterScript` 动作 |
| 动作注册了但拿不到参数 | Remoting 的 `CallingContext` 传不进脚本动作 | 改文件 IPC（`request.json` / `reply-<id>.json`） |
| `NoLockingStepException: S063110` | 所有 DataModel 操作（**包括开项目**）都要在 `LockingStep` 里 | `using (LockingStep step = new LockingStep())` 包住整个入口 |
| 页名变成 `/1` | 只写结构属性不够 | 创建后再赋一次 `page.Name` |
| 设备标识不显示 | `PropertyPlacement` 造得出、画不出 | 用 `Graphics.Text` 画标签 |
| 红线画不出来 | 红线是 `DynamicConnectionLine`，由引脚对齐自动生成 | 摆对符号位置，不要自己画 |
| 覆盖 DLL 报 `CS0016` | EPLAN 加载后锁住文件 | 输出带 `ticks` 的文件名，脚本每次扫目录取最新（热重载） |
| 调 API 全部超时 | EPLAN 上有个模态框（`#32770`），占住主线程 | 调之前先探测；UIAutomation 看不到按钮，要 `EnumChildWindows` + `BM_CLICK` |

---

## 四、工程侧的坑（同样致命）

**PowerShell**
- PS1 必须带 **UTF-8 BOM**，否则按 ANSI 解析中文，报 `UnexpectedToken`。
- `throw "文本 $var"` 遇中文会解析失败——拼字符串，别混插值。

**C# / csc**
- 只有 C# 5：不能字符串内插、`?.`、`nameof`、表达式体成员。
- 引用 EPLAN 类型的代码不能和 `Main` 同一方法——JIT 编译 `Main` 时 `AssemblyResolve` 还没挂上。

**Node / ESM**
- `new URL(..).pathname` 在 Windows 得到 `/D:/...`，拿去 `spawn({cwd})` 直接 `ENOENT`，要 `fileURLToPath`。
- 绝对路径 `import` 必须写成 `file:///D:/...`。

**MCP / zod**
- zod 对未声明字段**静默丢弃**。判别法：直连宿主能生效、走 MCP 不生效 → schema 漏字段。
- `parameters` 必须是已经是 JSON Schema，不会再转换。

**Cordis / DSH 预设**
- 注册原生工具的插件必须 `export const inject = ['tools']`；缺了它，`ctx.tools` 是空的，
  `apply()` 抛错 → **整个预设加载不了**（我踩过一次，用户重启后才暴露）。
- YAML 块标量（`prefix: |-`）里每一行都要保持缩进，错一行字段就被吞。

**诊断手段**
- 写"离线 harness"：假 ctx 跑真数据，不依赖 EPLAN、不依赖 DSH，`node test/xxx.mjs` 几秒出结果。
- 这比"改一版、让你重启一次"快一个数量级。

---

## 五、设计取舍

**工具面从 16 个收敛到 12 个**：同类合并成"一个工具 + action 参数"。模型少记一套名字，
schema 也更省 token。合并只发生在 MCP 层，宿主 op 名一个没改（它们是真机验证过的行为）。

**一页 = 一次调用**：`page_create` 收 `layout`/`nodes`/`texts`，内部逐节点插。实测整页 557 ms，
而逐件调用是 545 ms **加** N 次模型往返——贵的是往返，不是机器。

**不抢焦点**：`reveal` 只出图不切页；`open_page` 的 `focus` 默认 `false`。
用户明确抱怨过"每次动作都抢窗口"。真正的修法是两处：桥接器去掉无条件 `Activate`，
以及 `invokeWrite` 不再顺带开页。顺带发现 `AttachThreadInput` 才是唯一能真正把窗口提到前台的办法
（临时置顶 + `SwitchToThisWindow` 实测无效）。

**说实话**：备份是假的（`.elk` 只有 30 字节，数据在 63 MB 的 `.edb` 且被锁），文档里改成实话；
删除 `backup` 字段，改推"不可撤销，先 dryRun"。

**经验要落地**：`lesson` 工具写 JSONL（只追加），`update_goal` 收尾时自动提醒写一条。
知识分两层——**语义**（这个符号是干什么的，可累积、可覆盖）和**几何**（引脚坐标，必须实时取，不落盘）。

---

## 六、测试分层：每种测试抓到了什么

| 测试 | 数量 | 抓到的真 bug |
|---|---|---|
| `verify-bootstrap.ps1`（用 EPLAN 的引用集预编译脚本） | — | `ContextParameterBlock.Get` 要 `ref` 不是 `out` |
| `test/hostcheck.exe`（离线反射加载宿主） | 12 类型 | 宿主签名错误 |
| `test/raw-smoke.mjs` / `call-tool.mjs`（手写 JSON-RPC） | — | MCP 协议层、schema 丢字段 |
| `test/smoke-all.mjs`（全套只读 + 写入） | 11–17 项 | 焦点被抢、`open_page` 卡死 |
| `test/video-offline.mjs`（假 ctx + 真视频） | 12 项 | `inject` 缺失、帧分配不均 |
| `test/check-docs.mjs`（工具名一致性） | 7 文件 | 文档写 `query`、代码要 `filter` |
| `test/nudge-offline.mjs` | 11 项 | `blocked` 写成 `block` 永不触发 |

**最有价值的一个**是 `verify-bootstrap.ps1`：把 EPLAN 脚本编译器的引用集逐字抄下来，
在本地先编一遍。它把"进 EPLAN 试错"的循环从分钟级压到秒级。

---

## 七、如果重来一次

1. **先写 `sysinfo`/`diagnose` 探针**，把版本、路径、可用动作、日志位置一次性摸清，再动手。
2. **第一天就接日志**（`EplLog.eldb` 查询脚本），而不是第三天才想到。
3. **先验证"能不能改数据"，再验证"能不能看见结果"**——`look` 应该和第一条写操作同时做出来。
4. **别急着加工具**：先让一个工具端到端跑通（建页 → 摆件 → 出图 → 看图），再横向复制。
5. **每加一个插件就先离线跑一次 `apply()`**，别等用户重启才发现加载不了。

---

## 八、给下一个 MCP 项目的检查清单

- [ ] 目标软件是进程内 API 还是 RPC？先确认**代码必须跑在哪个进程里**
- [ ] 它的日志在哪、什么格式、能不能直接查
- [ ] 有没有 DLL/类型库可以反射
- [ ] 有没有"看起来成功其实失败"的返回值（异步、空 Message、静默字段）
- [ ] 有没有必须的"事务/lock"包装（EPLAN 的 `LockingStep`、AutoCAD 的 `Document.LockDocument`）
- [ ] 渲染/截图能力——**没有它就等于闭着眼开发**
- [ ] 写操作能不能回读、能不能回退
- [ ] 工具面：先做 3 个（看状态 / 做一件事 / 看结果），跑通了再长
- [ ] 每个工具都要有 `dryRun`
- [ ] 错误码要能直接指导下一步动作（`PAGE_NOT_FOUND` → "先用 pages 列页名"）
- [ ] 离线 harness：不装宿主软件也能跑
- [ ] 文档里的工具名/参数名与代码一致性检查
- [ ] 宿主插件记得 `inject`

---

## 九、数字

- 版本 0.11.1；包 60 文件 143.5 kB，**0 个 dll/exe**（编译产物不带，换机器现场编）。
- 端到端延迟（本机，不含模型往返）：`status` 121–144 ms、`pages` 37–129 ms、`look` 111–136 ms、`export` 638–968 ms、整页 `page_create` 557 ms。
- 录屏理解：2:20 视频 3.7–7.5 s（含 11 段中文转写）；4K 5:07 视频 21 s；SenseVoice 转写 45 倍实时。
- 构建链：无 .NET SDK，纯 `csc.exe`（C# 5）；无 npm 重依赖，MCP SDK + pdfjs 两项。
