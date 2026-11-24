# 0.5.0 接口契约（M0 冻结）

改这个文件等于改契约。四个执行块都按这里写，不许各自发明名字。

## 一、MCP 表面：12 个工具

模型看到的是 `mcp__eplan__<name>`。带 `*` 为必填。

另有第 13 个工具 `video`，**不在 MCP 里**：它注册在预设作用域，参数只有
`path*` / `maxFrames` / `maxSteps` / `language`，内部走 `server/video.mjs`（ffmpeg）+ DSH 的
`speechToText` 服务，返回 `{ steps[], frames[] }` 与若干图片 block。见 README「另外两个原生工具」。

| 工具 | 参数 | 宿主 op |
|---|---|---|
| `workspace` | `action*`: brief\|focus\|status\|list_pages\|open_project\|create_project\|open_page\|present\|wait\|plan_get\|plan_put\|claim\|release；`mode`(focus)、`jobId`(wait)；`list{filter,limit,includePlacements}`、`open{name,path,dir,focus}`、`create{name,template,creator,dir,dryRun}`、`present{width,theme,wait,waitMs}`、`plan[]` | 转调 `status` / `pages` / `project_open` / `project_create` / `page_open` / `look` |
| `symbol_catalog` | `action*`: search\|pins\|lookup\|annotate；`library`、`filter`、`limit(≤200)`、`offset`、`refresh`、`symbols[]`、`symbol`、`concept`、`usage`、`query`、`project` | `symbols` / `symbol_info` / `knowledge_get` / `knowledge_annotate` |
| `page_create` | 同 0.4.0：`name`\|`page`、`type`、`append`、`nodes`、`texts`、`grid`、`layout`、`reveal`、`width`、`template`、`dryRun`、`project` | `page_create` |
| `page_edit` | `action*`: insert_symbol\|set_properties\|relocate\|relabel\|delete_placement\|draw_graphics\|box；`insert{symbol,library,variant,at,deviceTag,props}`、`select{objectId,deviceTag,index}`、`get[]`/`set{}`、`at`/`offset`(relocate)、`to`(relabel)、`draw[{kind,from,to,at,points,text,height,width,color}]`、`box{from,to,color,width,deviceTag,pins[]}`；老的平铺写法仍接受（passthrough） | `symbol_insert` / `props` / `placement_move` / `placement_relabel` / `placement_delete` / `draw` / `box` |
| `page_delete` | `page*`、`project`、`dryRun` | `page_delete` |
| `page_inspect` | `format*`: structure\|image\|both；`page*`、`project`、`view: summary\|list\|full`、`only[]`、`limit`、`refresh`、`members`、`render{width,theme,image}` | `inspect` / `look`；JS 侧压实（summary≈1.4 KB，full 才带引脚坐标） |
| `validate` | `page*`、`project`、`grid`、`pageSize[]`、`expectDevices[]` | `check` + `inspect`；几何门禁在 JS 侧算，返回 `verdict: pass\|warn\|fail` |
| `export` | `kind*`、`pages`、`outDir`、`fileName`、`project`、`wait`(false 回 jobId)、`waitMs`；作业由 `workspace` / `operation_history` 的 `action="wait"` 收 | `export` |
| `manual` | `action*: outline\|search\|render`、`path*`、`from`、`to`、`scale`、`queries` | `pdf` |
| `operation_history` | `project`、`page`、`operation_id`、`limit` | `op_history` |
| `operation_rollback` | `operation_id*` | `op_rollback` |
| `lesson` | `action*`: add\|list\|prefer；`text`、`kind`、`scope`、`brief`、`tags`、`query`、`limit`、`project`、`page`、`prefer{source,weight}` | **无宿主 op**，直接写本地文件 |

`lesson` 是新增能力，没有旧工具对应：之前的 16 个工具里没有任何一条能跨会话留存经验。
它和 `symbol_catalog(action="annotate")` 分家 —— annotate 记「这个符号是什么」（按符号索引，会覆盖），
lesson 记「这个预设该怎么用」（只追加，按时间倒序读）。

**旧→新映射**（16 项，逐条对应，不许丢能力）

```
status                    → workspace{action:"status"}
pages                     → workspace{action:"list_pages"}
project_open              → workspace{action:"open_project"}
page_open                 → workspace{action:"open_page"}
symbols                   → symbol_catalog{action:"search"}
symbol_info               → symbol_catalog{action:"pins"}
page_create               → page_create
symbol_insert             → page_edit{action:"insert_symbol"}
props                     → page_edit{action:"set_properties"}
draw                      → page_edit{action:"draw_graphics"}
page_delete               → page_delete
inspect                   → page_inspect{format:"structure"}
look                      → page_inspect{format:"image"}
check                     → validate
export                    → export
pdf                       → manual{action:"outline|search|render"}
```

**为什么只合并表面**：宿主 21 个 op 已真机验证，改名即风险。合并层在 `server/server.mjs`，一个 action 翻译成一个既有 op。

`relocate` / `relabel` / `delete_placement` 走 0.6.0 新增的 `placement_move` / `placement_relabel` / `placement_delete`。
引导脚本每次连接都会挑 `host\bin` 里最新的宿主 DLL（`EplanMcpBootstrap.cs` 的热重载逻辑），
所以**build.ps1 跑完即可用，不用重启 EPLAN**；只有 EPLAN 里还没加载过任何宿主时才会退回 `HOST_OUTDATED`。
`present` 的 job 化（`wait:false` → `wait`）完全在 server 进程内。

## 二、宿主 op：25 个

既有 21 个一个不改名、不删：

```
status pages page_create draw symbols symbol_insert props export
diagnose actions tagloc inspect look symbol_info project_open project_close
project_create probe_props check page_open page_delete
```

0.5.0 新增 4 个：

| op | 参数 | 阶段 |
|---|---|---|
| `op_history` | `project` `page` `operation_id` `limit` | M2 |
| `op_rollback` | `operation_id` | M2 |
| `knowledge_get` | `symbol` `library` `query` | M3 |
| `knowledge_annotate` | `symbol` `library` `concept` `usage` | M3 |

0.6.0 新增 3 个（增量改页；引导脚本热重载，build 完即可用）：

| op | 参数 | 作用 |
|---|---|---|
| `placement_move` | `selector{page,project,objectId,deviceTag,index}` `at` 或 `offset` `dryRun` | 挪一个对象（Location 不是属性，props 改不了） |
| `placement_relabel` | `selector{...}` `to` `dryRun` | 改一个 Function 的设备标识（Name） |
| `placement_delete` | `selector{...}` `dryRun` | 删一个对象；命中多个会报 `OBJECT_AMBIGUOUS`，不会批量删 |

## 三、操作记录格式

位置 `C:\Users\Public\EPLAN\Data\eplan-mcp\ops\<project>.jsonl`，一行一条，追加写，重启不丢，**不注入上下文**。

```json
{
  "operation_id": "op_20261102_221530_0007",
  "timestamp": "2026-11-02T22:15:30+08:00",
  "project": "test",
  "page": "=MCP/3",
  "operation": "page_create",
  "kind": "write",
  "target": { "kind": "SymbolReference", "locator": "GB_symbol/Q2#0@60,220" },
  "before": null,
  "after": { "deviceTag": "-QF2" },
  "result": "ok",
  "reversible": true,
  "undo": { "op": "remove_object", "args": { "page": "=MCP/3", "locator": "GB_symbol/Q2#0@60,220" } },
  "rolled_back_at": null
}
```

字段纪律：

- `operation` 是自由字符串，加新操作类型不用改格式；`kind` 只有 `write` / `delete` 两值
- `target.locator` 由该 `kind` 的解析器解释；新增对象类型只需加一个解析器
- `before` / `after` 是**不透明 payload**，日志层不解析、不假设结构
- 只有写操作产生记录，读操作一律不记

## 四、回退语义

`undo.op` 目前三种：`remove_object`、`restore_properties`、`restore_page`。

返回值两类：

- `ok:true` + `warnings[]`：`page_gone`、`overwritten[]`、`already_rolled_back`
- `ok:false` + `code`：`NOT_FOUND`、`AMBIGUOUS`（附候选）、`CROSS_PROJECT`

**页删除的快照三级退化**：页宏导出到 `ops/pages/<op_id>.emp` → 同项目临时页快照 → 都不行则记录 `reversible:false`，回退时直接拒绝并说明原因。`.elk` 链接副本（30 字节）永远不算备份。

## 五、语义知识格式

位置 `%LOCALAPPDATA%\eplan-mcp\knowledge\symbols.json`（旧版本在 `%TEMP%\eplan-mcp\knowledge\`，
启动时一次性复制过来，旧文件保留不删）。**几何不在这里**——几何永远实时取（`symbol_info`，实测 115 ms）。

```json
{
  "symbol": "Q2",
  "library": "GB_symbol",
  "concept": "两极断路器",
  "usage": "相线分断，常用于单相回路进线",
  "source": "derived"
}
```

- `source` 只能是 `derived`（模型推断）或 `verified`（真机验证）
- 不设 `category` 枚举、不设 `poles` 等结构化分类——换个工程领域就套不上
- 检索是名字 + concept + usage 的子串匹配，不上向量库

## 六、经验文件格式

位置 `%LOCALAPPDATA%\eplan-mcp\knowledge\notes.jsonl`，**一行一条、只追加、不覆盖**。

由 MCP 服务（`server/server.mjs`）直接用 `node:fs` 读写，**不经过 EPLAN** ——
EPLAN 没开、崩了、被模态框卡住时，经验和 `status` 照样可用。
读取只解析尾部 500 行（超限时返回 `truncated`），避免经验库变长后拖慢一次 status。

```json
{"id":"n638374...","at":"2026-11-03T02:37:01.9958046Z","text":"page_open 默认不抢焦点；reveal 只出图不切页","kind":"decision","tags":["focus"]}
```

- `kind`：`pitfall`（默认）/ `recipe` / `decision`
- 可选 `project`、`page`，只用于回查，不参与检索
- 为什么不覆盖：一条经验的价值往往就在「当时是这么错的」，覆盖掉错误记录，下一个人还会再错一次
- 坏行跳过，不能让一行写坏把整个经验库读不出来
- `workspace(action="status")` 会带回最近 5 条（`lessons.total` / `lessons.recent`），
  模型不必为了看经验多花一次往返；要翻更早的记录才调 `lesson(action="list")`
- 写入失败抛 `NOTES_WRITE_FAILED` 并给出路径——静默失败会让模型以为记下来了
- 目标收尾时 `experience-nudge.js` 会在 `update_goal` 的结果里追加一次提醒；只是提醒，不阻止完成

## 七、错误码

沿用 0.4.0 的 `HostException(code, message, hint)`，`hint` 必须教下一步（例如行名写错时列出可用名字）。0.5.0 不改错误码清单，只新增上面第四节列出的三个回退码。
