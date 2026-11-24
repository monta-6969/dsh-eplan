---
name: eplan-symbols
description: EPLAN 符号库清单、常用元件的引脚几何（相对坐标与朝向）、变体的含义，以及用 symbol_catalog(action="search") / symbol_catalog(action="pins") / page_inspect(format="structure") 查证符号的方法。要选元件或排查连线时读它。
---

# EPLAN 符号与引脚几何

## 符号库

`workspace(action="status")` 的 `currentProject.symbolLibraries` 给出**当前项目实际可用**的库，以它为准。

本机实测存在的：`SPECIAL`、`GB_symbol`、`GB_single_symbol`、`GRAPHICS`、`OS_SYM_ESS`，以及若干 `IEC_*`。

| 库 | 内容 |
|---|---|
| `GB_symbol` | 823 个国标元件：熔断器 `F1`、三极熔断器组 `FA3`、各类开关继电器 |
| `SPECIAL` | 443 个通用符号：连接点 `CO`、T 节点 `TLRU` / `TOUR` / `TLRO` / `TOUL`、电源引入点 `CDPST`、中断点 `BP` |
| `GRAPHICS` | 纯图形符号，不带电气含义 |

**容易找错**：`CO`、`DCP`、`DC`、`BP` 不在 `GB_symbol`（在 `SPECIAL`）。`GB_symbol` 里**没有** `L24` / `0V` 这种电位符号。

## 引脚几何（实测，单位 mm，相对符号原点）

| 符号 | 变体 | 引脚 | 用途 |
|---|---|---|---|
| `CO` | 0 | Right(0,0), Down(0,0) | 转角：右来下走 |
| `CO` | 1 | Right(0,0), Up(0,0) | 转角 |
| `CO` | 2 | Left(0,0), Up(0,0) | 转角 |
| `CO` | 3 | Left(0,0), Down(0,0) | 转角：左来下走（总线右端） |
| `TLRU` | 0 | Down(0,0), Left(0,0), Right(2,0) | T 节点 |
| `TLRU` | **8** | Right(0,0), Left(0,0), Down(0,0) | **最干净的 T 节点：三引脚都在原点** |
| `TLRO` | 8 | Right, Left, Up | 向上分支的 T 节点 |
| `TOUR` | 0 | Down(0,0), Up(0,0), Right(2,0) | 带上支路的 T 节点 |
| `TOUL` | 0 | Down(0,0), Up(0,0), Left(-2,0) | 对称版本 |
| `CDPST` | — | Up(0,+4), Down(0,-4) | 电源引入点 |
| `F1` | — | Up(0,+4), Down(0,-4) | 单极熔断器，8 mm 高 |
| `FA3` | — | (0,±4), (8,±4), (16,±4) | 三极熔断器组，跨 16 mm |
| `G22` | — | (0,±8), (16,±8) | 16 mm 高元件 |
| `XU` | — | Up(0,4), Up(8,4), Up(16,4) | 三个上连接点 |

**熔断器尺寸改不了**：`GB_symbol` 里所有单极熔断器（`F1` `FA1` `FS` `FT1` `F_AB_1P` `F_SNH_1P`）引脚半高都是 **4 mm**，即 8 mm 高。EPLAN 符号不可缩放，想要更大的图形只能去改符号库定义。

## 查证方法

```
symbol_catalog(action="search")      {"library":"GB_symbol","filter":"F"}        列符号名，防瞎编
symbol_catalog(action="pins")  {"library":"SPECIAL","symbols":["TLRU"]}   查变体数与每个引脚的相对坐标/朝向
page_inspect(format="structure")      {"page":"=MCP/8"}                          查页面上元件实际的绝对引脚坐标
```

- **永远先查再插**。符号名写错报 `SYMBOL_NOT_FOUND`，比你多查一次的成本高得多。
- `symbol_catalog(action="pins")` 给的是**相对**坐标；`page_inspect(format="structure")` 给的是**绝对**坐标。判断两个元件会不会自动连线，看 `page_inspect(format="structure")` 的绝对坐标。
- `page_inspect(format="structure")` 的 `members` 参数可以转储任意 EPLAN 类型的方法表，探索不熟悉的 API 时很有用。

### 中文搜不到怎么办（2026-11-23 实测）

库里全是 GB 老编码，按中文搜（`filter="按钮"`）只会拿到空或者 823 条全量 —— 别在这上面耗时间，走两条路：

1. 常见概念的对应关系已经内置，`search` 会直接回在 `concepts` 字段里（空开→`FA3`、接地→`ERDE`、
   中断点→`BP`、电源引入→`CDPST`、连接点/T 节点→`CO`/`TLRU`…）。有就直接用。
2. 表里没有的，用 `symbol_catalog(action="visual", symbols=["SON","SSA","KM2"])`：
   它把这些符号真画到一张临时页上、每个上面标好名字、裁好区域渲一张图给你，页用完自动删。
   **一次调用**就能看清形状，比「建试画页 → 渲染 → 截图 → 放大裁图」省十几次往返。

## 变体 = 方向（EPLAN 里按 Tab 转 90°，工具里就是换变体）

用户说的「按 Tab 转 90°」在 API 里没有对应的旋转参数：`SymbolReference` 只有 `Location`
和 `SymbolVariant`，没有角度属性。`page_create` / `page_edit(action="insert_symbol")` 的
`variant` 就是唯一能控制方向的东西，默认 0。

- 选之前先 `symbol_catalog(action="pins")`：每个变体都列出引脚相对坐标和 `direction`
  （引脚朝外的方向）。要接从上方来的导线，就挑引脚朝 `Up` 的变体，以此类推。
- 顺序**不保证**是 0/90/180/270，每个符号库各自定义。实测 `GB_symbol` 的 `F1`（单极熔断器）：
  v0 竖放、v1 横放、v2 竖放（镜像）、v3 横放 —— 不能按「每加 1 转 90°」推。
- 库里没有你要的方向（只有竖没有横），换一个符号，不要硬搬坐标或者用文字凑。

## GB_symbol 里能当「供电主回路」用的符号（2026-11 实测渲染确认）

GB_symbol 的命名是 GB 老式编码（`QSF3`、`BOSW`、`BET_01`），不是 IEC 的 `QF`/`T`/`H`，所以按
「断路器」「变压器」这种中文或 IEC 前缀去搜是搜不到的。下面这些是**插进图里渲染确认过**的：

| 符号 | 实际是什么 | 对应图纸里的 | 引脚 |
|---|---|---|---|
| `QSF3` | 三极带熔断器隔离开关（三个极各带熔断器） | `-QF0` 电源切断开关 32A | 上下各 3 个 |
| `QSF4` | 三极 + N 极带熔断器隔离开关 | `-QF1` 3PDA | 上下各 4 个 |
| `HLED` | LED 指示灯 | `-H1` 电源指示灯 | 上 |
| `KM2` / `KM3` / `KM4` | 接触器线圈 | `-KM1` 总急停接触器 | 左右 |
| `CDPST` | 电源引入点（圆点带上下引线） | 进线端子 / 电位引入 | `Up(0,+4)`、`Down(0,-4)` |
| `TLRU` v8 / `TOUR` v0 / `CO` v3 | 三引脚节点，拼母线和分支 | 母线 T 接 | 见上表 |
| `F1` / `FA1` / `FA2` | 单极熔断器，半高 4 mm | 支路熔断器 | `Up/Down` |

**没有**的三样（别浪费时间找）：断路器（`QF`）、隔离变压器（`T`）、插座（`XS`）。
变压器要自己搭（两个线圈符号拼），插座用 `PLC_CBOX_*` 之类的连接器符号凑，或者直接
用 `Graphics.Rectangle` + 文字画一个示意框 —— 用户能接受示意，但不能接受符号张冠李戴。

**搜索陷阱**：`symbol_catalog(action="search")` 工具默认只回 50 个（`limit` 默认 50），搜 `T` 只看到 6 个 `BET_*`
会误以为库里没有变压器。要看全量必须传 `limit: 1000`，实测 `GB_symbol` 共 **823** 个。

### 变压器、端子、整流/逆变（样张页 =MCP/14 渲染确认）

| 符号 | 实际是什么 | 用在哪 |
|---|---|---|
| `T11` | **三相变压器**（三组初级 + 三组次级线圈） | 三相隔离变压器 |
| `TS11` | **单相变压器**（一组初级 + 一组次级） | `-T1` 隔离变压器 380V/220V 1kVA |
| `TS12` / `TS22` | 单相变压器变体（绕组布局不同） | 按引线方向需求挑 |
| `TST_1` / `TST_11` | 带屏蔽层的变压器 | 需要屏蔽时 |
| `TISPQ` | 整流器（方框里 U） | 整流桥 |
| `TISTQ` | 逆变器（方框里 I） | 逆变输出 |
| `X` / `X2` / `X3_1` / `X3_B` | 端子排 / 端子（带连接圆点） | 端子排、跨页连接点 |
| `X2_ST` / `X3_BU1` | 带屏蔽或带插头的端子 | 屏蔽端子 |

**没有**「插座」符号（`XS`）。三孔插座只能用 `X` 系列端子拼，或者用矩形 + 文字画示意。
不要拿别的符号冒充 —— 用户一眼能看出来。

## 怎么快速摸清一个库（别一个个猜）

把候选符号成批摆到一张临时页上、每个旁边标上符号名，然后 `page_inspect(format="image")` 出图，一张图看十几个：

```
page_create { "page": "=TMP/1", "nodes": [ {"symbol":"T11","at":[40,230]}, ... ],
              "texts": [ {"at":[31,246],"text":"T11"} ] }
page_inspect { "format": "image",  "page": "=TMP/1", "width": 2000 }
```

比逐个插入 + 逐个渲染快一个数量级。实测一次能认 16 个符号。
注意间距要大于 40 mm，否则符号会叠在一起看不清。

## 连接点代号：谁显示、谁不显示（2026-11 实测）

- **DCP**：自己渲染连接点代号（`deviceTag` 冒号后的部分）。再手写一条文字就是
  「R R」「PEPE」重影；只能改 `deviceTag`。
- **BOSW**（常开触点）、**FA3**（三极熔断器组）：**不显示** 13/14、1/3/5 这些代号，
  要用文字补；补之前给符号 `showDeviceTag:false`，否则和自动器件标识叠成两条。
- **M3**（三相电机）：引脚 `(0,+8)(8,+8)(16,+8)` 朝上，PE `(16,-8)` 朝下；
  标 U1/V1/W1 用 `y = 符号y + 19`、`x = 引脚x - 6`（`+14` 会撞自动标识 `-M1`）。

## 中断点 BP 的朝向

`SPECIAL` 的 BP：`v1`/`v5` 上箭头，`v3`/`v7` 下箭头，引脚都在 `(0,0)`/`(0,-1)`，
换变体只改图形方向。竖在端头、另一侧不接东西的 BP 会被自动调整删掉（见 eplan-drawing）。
