# 换机器 / 装不上 / 报错说找不到 EPLAN

这个模式不是「装个插件就完事」——它是一条四段链路，任何一段断了都表现为「工具不能用」：

```
DSH 预设  →  MCP 服务(Node)  →  桥接器(EplanBridge.exe)  →  宿主 DLL(注入 EPLAN)
                                                        ↘  引导脚本(注册进 EPLAN)
```

## 第一步永远是看工作区状态

```
workspace {"action":"status"}
```

它一次就把四段的状态报全了：`bridgeReady`、`eplanRunning`、`hostReady`、`ready`。
对着错误码看下面。

| 错误码 | 断在哪 | 处理 |
|---|---|---|
| `EPLAN_NOT_RUNNING` | 最外层 | EPLAN 没开。打开 EPLAN 并载入项目 |
| `EPLAN_BLOCKED_BY_DIALOG` | 最外层 | 被模态框挡住（启动时的「系统信息」最常见）。点掉再试 |
| `BRIDGE_MISSING` | 第二段 | 桥接器没编译。跑 `node setup.mjs` |
| `BRIDGE_EXITED` | 第二段 | 桥接器崩了。看 stderr；多半是本机 EPLAN 版本 API 不匹配 |
| `HOST_NOT_READY` | 第三段 | 引导脚本没注册。跑 `node setup.mjs` 或桥接器 `install` |
| `EPLAN_TIMEOUT` | 第三段 | 脚本没被调用或宿主抛异常。看 `C:\Users\Public\EPLAN\Data\eplan-mcp\bootstrap.log` |

## 全新机器

```powershell
npm install --omit=dev
node setup.mjs
```

`setup.mjs` 做四件事：找 EPLAN → 查 csc/node 并写 `%LOCALAPPDATA%\eplan-mcp\eplan.config.json`
→ **在本机编译**宿主和桥接器 → 注册引导脚本并自检。

**必须在目标机编译**：宿主 DLL 引用本机 EPLAN 的程序集，2.9 和 2.10 API 不同，
拷贝别人的 DLL 会 `MissingMethodException`。所以包里不带任何 `.dll`/`.exe`。

## 手动排障：绕开 MCP 直连桥接器

怀疑是 MCP 层的问题时，直接喂桥接器一行 JSON（几百毫秒一轮，比走 MCP 快得多）：

```powershell
'{"id":1,"op":"status","args":{}}' | native\bridge\bin\EplanBridge.exe
```

这一步通了，说明「桥接器 → 宿主 → EPLAN」都是好的，问题在 MCP/预设层。

## 改完宿主要重新编译

```powershell
powershell -File native\host\build.ps1          # 生成 EplanMcpHost-<ticks>.dll
powershell -File native\script\prepare-install.ps1   # 生成 EplanMcpBootstrap-<ticks>.cs
```

宿主是**热重载**的：引导脚本每次调用都扫目录取最新的 DLL，不用重启 EPLAN。
但引导脚本本身改了，就要重新 `prepare-install` + `RegisterScript`（换文件名才强制重编译，
同路径会复用旧结果）。

`native/script/verify-bootstrap.ps1` 会用与 EPLAN 完全相同的引用集预编译一遍引导脚本，
在塞进 EPLAN 之前就把编译错误抓出来。改脚本后**一定要跑**。
