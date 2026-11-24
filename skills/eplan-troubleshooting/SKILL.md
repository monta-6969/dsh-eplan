---
name: eplan-troubleshooting
description: EPLAN 工具报错、调用卡住、画出来不对时的排查步骤——错误码对照、EPLAN 没开、模态框卡死、红线没生成、字没显示。遇到异常先读它，别盲目重试。
---

# 故障排查

## 先看错误码，别重试

工具失败时返回 `{ok:false, code, message}`。**同一个调用重试第二次通常还是一样失败**，先按表处理：

| 错误码 | 含义 | 怎么办 |
|---|---|---|
| `EPLAN_NOT_RUNNING` | EPLAN 没跑 | 请用户启动 EPLAN（桌面快捷方式），或调 `workspace(action="open_project")` 让系统自己拉起来 |
| `HOST_NOT_INSTALLED` | 引导脚本没装 | 需要重跑安装流程，找维护者，不要自己乱试 |
| `NO_PROJECT` | EPLAN 里没开项目 | `workspace(action="open_project")` 指定项目名 |
| `PROJECT_NOT_OPEN` | 指定的项目没打开 | 先 `workspace(action="open_project")`，`project` 参数只认已打开的项目 |
| `PROJECT_READONLY` | 项目只读 | 换项目，或请用户取消只读 |
| `PAGE_NOT_FOUND` | 页名不对 | `workspace(action="list_pages")` 列出现有页名再填 |
| `PAGE_EXISTS` | 页已存在 | 换页号，`page_create` 不会覆盖 |
| `BAD_PAGE_NAME` | 页名格式错 | 改写成 `=高层功能+安装位置/页号` |
| `SYMBOL_NOT_FOUND` | 符号名写错 | `symbol_catalog(action="search")` 查真实名字 |
| `LIBRARY_NOT_FOUND` | 库名不对 | 看 `workspace(action="status")` 返回的 `symbolLibraries` |
| `ACTION_MISSING` | EPLAN 版本里没这个动作 | 功能不可用，如实告诉用户 |
| `EPLAN_BLOCKED_BY_DIALOG` | EPLAN 被模态框挡住，主线程被占死 | 请用户关掉那个弹窗再重试；错误信息里会写出对话框标题 |
| `PAGE_OPEN_UNCONFIRMED` | 跳页动作执行了但界面没切过去 | 见下面「界面没切过去」 |

## 调用超时 / 一直不返回

**最可能的原因：EPLAN 被一个模态对话框挡住了。** 它会把 EPLAN 主线程占住，所有 API 调用一起挂死。

工具在超时后会自己检查这一点，直接报 `EPLAN_BLOCKED_BY_DIALOG`，并在 message 里写出对话框标题
（通常是「系统信息」）。看到这个码就不用再猜了：请用户点掉那个框，然后重试。
启动 EPLAN 后如果主窗口点了没反应，也是同一个原因。

**千万别在超时后连续重试**：模态框还在，重试只会再等一个超时。

**另一个原因**：EPLAN 进程已经不在了（用户关掉了）。`workspace(action="status")` 能正常返回就说明进程还在；`workspace(action="status")` 也超时多半是模态框。

## 红线没生成

按顺序查：

1. `page_inspect(format="structure")` 看两个元件的引脚**绝对坐标**。同一条支路上的 X 必须完全相同，Y 方向要留出空间。
2. 朝向要对：上面的元件是 `Down`，下面的元件是 `Up`，才是「面对面」。
3. 坐标必须是 4 的倍数。落不到栅格上，EPLAN 不认为是同一条线。
4. 用 `page_inspect(format="image")` 看渲染图。红线**不会**出现在 `page_inspect(format="structure")` 的对象列表里（它是渲染时算出来的），别因为看不到对象就以为没连上。

## 界面没切过去（PAGE_OPEN_UNCONFIRMED）

`workspace(action="open_page")` 返回的 `visibleInTitle` 为 false，说明窗口标题里没出现目标页名。可能是切过去了但标题没刷新，也可能是动作没生效。先用 `workspace(action="status")` 看 `visiblePage` 现在是什么，再决定要不要重试一次；连续两次不行就如实告诉用户，不要反复调。

## 图上没字

- 设备标识：`page_edit(action="insert_symbol")` 的 `showDeviceTag` 默认 true，会画成文字。设成 false 就什么都不画。
- 自定义标注：用 `page_edit(action="draw_graphics")` 的 `kind:"text"`。
- **不要用属性摆放（PropertyPlacement）显字**，EPLAN 2.9 里渲染不出来，四种用法都试过。

## 画出来是绿色线

说明用了 `page_edit(action="draw_graphics")` 画线。删掉这些线，改成摆符号让 EPLAN 自动生成。绿色是普通图形图元，红色才是真正的连接线。

## 清理

试画留下的过程页用 `page_delete` 删掉（支持 `dryRun` 先看会删掉什么）。别在用户的页树里留一堆 `/2` `/3` `/4`。

## 参数明明传了，宿主却像没收到

MCP 层的参数校验是 **zod 严格模式**：schema 里没声明的字段会被**直接丢掉**，
不报错、不提示，现场表现是「功能实现了但不生效」。

已经踩过两次：

- `project` 一度没在 schema 里 → 传了 `project:"test"` 仍然操作当前项目
- `grid` 一度没在 schema 里 → 传了吸附不生效

判断方法：同样的参数用 `tools/ipc_call.py` 直连宿主试一次。直连生效、走 MCP 不生效，
就是 schema 漏字段，去 `server/server.mjs` 补。

## `BAD_LAYOUT`：布局引用写错了

```
行 "buss"：没有这个名称。可用的是：in / bus。也可以把 rows 写成数组来用下标。
```

这个错误是**好错误**，照着改就行。几种常见原因：

| 现象 | 原因 |
|---|---|
| 「没有这个名称。可用的是：…」 | 行名拼错，或 `rows` 是对象却写了数字下标 |
| 「要按下标取（数组），给的是名字」 | `rows` 是数组，只能写 `"0"`、`"2"` |
| 「列只能用下标」 | `columns` 永远是数组，不能给列起名字 |
| 「用了 "0/bus" 这种布局引用，但没给 layout」 | `layout` 忘了传 |
| 「布局引用要写成 "列/行"」 | 只写了一半，比如 `"bus"` |

**别在对象形式和数组形式之间混用** —— 同一页里选一种。

## `export` 导出来的 PNG 是个目录

`GraphicPageEx` 的第二个参数是**输出目录**，不是文件路径。传 `xxx.png` 时 EPLAN 会把
`xxx.png` 建成目录，再把 `<页名>.png` 塞进去。0.4.0 已修（传目录 + 用返回值拿真实路径），
如果又出现，检查是不是有别的代码路径还在拼文件名。

## 红线不出来

不是缺线，是引脚没对齐。按这个顺序查：

1. `page_inspect(format="structure")` 看这一页的引脚绝对坐标，两个该连的引脚是不是同 x（竖线）或同 y（横线）；
2. 朝向是不是**相对**（一个 `Down`、一个 `Up`）—— 同向的两个引脚不会连；
3. 坐标是不是 4 的倍数 —— 用 `layout` + `grid` 最省事；
4. 还不行就 `page_inspect(format="image")` 出图确认，**不要**改用 `page_edit(action="draw_graphics")` 补线，那样得到的是绿色普通线条。

## 打开页面弹出「硬件错误:存储器访问受阻」

`workspace(action="open_page")` 有可能弹出 EPLAN 自己的「错误」框，正文是
**硬件错误:存储器访问受阻**（按钮：确定 / 2..6 / 不再显示此对话框(&D)）。

这个框是 EPLAN 侧弹的，不是预设在报错。它的后果很重：**模态框占住 EPLAN 主线程，
之后所有 API 调用一起卡死**，表现是每个工具都超时。

现在的桥接器在发请求之前会先枚举 EPLAN 进程的 `#32770` 窗口，发现挡住了就直接返回
`EPLAN_BLOCKED_BY_DIALOG` 并说清是哪个框 —— **看到这个码就请用户点掉那个框**，
不要反复重试，也不要自己去关 EPLAN。

已经发出去的那次请求（触发弹框的那次）仍然会等满超时，因为框是在调用过程中弹出来的，
发之前查不到。所以 `open_page` 卡住一次之后，先让用户点掉框，再继续。

## 改错了怎么退

EPLAN API 的改动**不进 GUI 撤销栈**，Ctrl+Z 对它们无效。唯一的退路是本预设自己记的操作日志。

- 查：`operation_history` —— 返回这个项目上真实发生过的写操作（建页、插元件、改属性、画图、删页），
  最新在前，每条带 `id` / `op` / `page` / `undoable`。日志在 `%TEMP%\eplan-mcp\ops\<项目名>.jsonl`。
- 撤：`operation_rollback { "operation_id": "op..." }`

| 操作 | 能撤吗 | 撤了等于 |
|---|---|---|
| `page_create`（新建页） | **能** | 删掉这次建的那页（页里的内容一起没） |
| `page_create`（`append=true` 往已有页追加） | 不能 | 撤了会把用户原有的页一起删掉，所以不记回退 |
| `page_edit(action="insert_symbol")`（插元件） | **能** | 删掉这次插入的那个对象 |
| `page_delete`（删页） | 不能 | 删之前没留快照 |
| `page_edit(draw_graphics)`（画图元） | 不能 | 没有可靠的反向操作 |
| `page_edit(set_properties)`（改属性） | 不能 | 现在没记旧值 |

撤不了的那几种，工具会返回 `undone:false` 和 `reason`，**不会假装成功**。已经撤过的再撤返回
`alreadyUndone:true` 但什么都不做 —— 这是为了不让一次误操作连环删东西。

所以顺序很重要：**拿不准就先 `dryRun`，再动手；动手之前先想清楚这一步能不能退。**
