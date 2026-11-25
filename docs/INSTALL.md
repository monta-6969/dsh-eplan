# 在新机器上安装「eplan绘图自动化」

## 前提

| 需要什么 | 说明 |
|---|---|
| Windows 10 / 11 | PDF 渲染依赖系统自带 `Windows.Data.Pdf` |
| EPLAN Electric P8 2.9 | 必须开 **Remoting**（现装版本默认开，监听 49152） |
| .NET Framework 4.x | 用系统自带 `csc.exe` 编译宿主和桥接器，**不需要装 SDK** |
| Node.js 20+ | MCP 服务端 |
| DSH | 承载预设与 `video` / `speechToText` |

## 装

```powershell
# 1. 装进 DSH profile（会自动带上依赖）
dsh plugin --profile desktop add github:monta-6969/dsh-eplan

# 2. 一次性 setup：找 EPLAN、写配置、在本机编译宿主与桥接器、注册引导脚本
node node_modules/dsh-eplan/setup.mjs      # 打印「全部就绪」即成功
```

`setup.mjs` 依次做四件事：找 EPLAN（注册表 + 常见路径）、写
`%LOCALAPPDATA%\eplan-mcp\eplan.config.json`、在本机编译宿主 DLL 和桥接器 EXE、
把引导脚本注册进 EPLAN 并跑一次环境总览自检。

**必须先打开 EPLAN 再跑第 2 步**：注册和自检都在 EPLAN 进程里做。EPLAN 没开时
`setup.mjs` 会提示并正常退出，配置和编译那两步仍然生效，打开 EPLAN 后再跑一次即可。

## 装完怎么验

`setup.mjs` 只证明「编译好了、宿主注册上了」。要证明**每个工具都能用**：

```powershell
node node_modules/dsh-eplan/test/smoke-all.mjs          # 只读，不碰你的图
node node_modules/dsh-eplan/test/smoke-all.mjs --write  # 再加上 dryRun 和建页检查
```

它开一个 MCP 子进程，把 12 个工具挨个调一遍，逐条打印耗时和返回字段，最后给一句
`全部通过：N 项通过`。链路哪一段断了，一眼能看到断在第几个工具。

- `manual` 一项会因为没给文件而跳过，不算失败。
- `video` 不在这一组里（它不走 MCP），用 `test/video-offline.mjs` 单独验证，不需要 EPLAN。
- 纯离线那一批（不需要 EPLAN）见 README「自检」。

## 接进 DSH

装包时 DSH 会自己写 profile，一般不用手动改。若是本地开发目录：

1. profile 的 `package.json` 里加一行
   `"dsh-eplan": "link:C:/Users/<你>/Desktop/工程自动化/插件/dsh-eplan/git"`
2. 同文件 `dsh.profile.bundles` 数组里加上 `"dsh-eplan"`
3. **重启 DSH**（`link:` 包只在启动时读）

重启后新建对话，模式列表里会出现 **「eplan绘图自动化」**：

- 唯一的直接工具是 `run_code`；EPLAN 工具写成程序里的 `await tools.mcp__eplan__*`，
  一段程序画完一页，中间结果不占对话。
- 同一时间只用一个 EPLAN 会话：各起一个服务会抢 EPLAN 的 Remoting 端口。

## 为什么必须在本机编译

宿主 DLL 引用的是**本机 EPLAN 的程序集**（`Eplan.EplApi.DataModelu.dll` 等）。
2.9 和 2.10 的 API 不一样，把别的机器编好的 DLL 拷过来会 `MissingMethodException`。
所以 `setup.mjs` 每次都重新编译，`dist/` 里也**不带**任何编译产物；升级包之后要重跑一次。

## 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| `没找到 EPLAN` | 注册表里没有，且不在常见盘符 | 手动写 `%LOCALAPPDATA%\eplan-mcp\eplan.config.json` 的 `eplanExe` |
| 编译报 `CS0246` | 本机 EPLAN 版本 API 不同 | 看报错里的类型名，对应改 `native/host/src/*.cs` |
| `EPLAN_NOT_RUNNING` | EPLAN 没开 | 先打开 EPLAN，再跑 `node setup.mjs` |
| `EPLAN_BLOCKED_BY_DIALOG` | EPLAN 被模态框挡住（常见是启动时的「系统消息」） | 点掉那个框，重试 |
| `RegisterScript` 返回 false | 脚本目录只读或权限不足 | 检查 `C:\Users\Public\EPLAN\Data\脚本\<公司名>\` 是否可写 |

## 卸载

1. DSH profile 里删掉那两处引用，重启 DSH。
2. 删掉安装目录。

积累下来的经验与符号语义不在安装目录里，要清掉得另外删
`%LOCALAPPDATA%\eplan-mcp\`（`knowledge\notes.jsonl`、`knowledge\symbols.json`、
`knowledge\preferences.json`）。渲染图和手册截图在 `%TEMP%\eplan-mcp\`，可以随系统清理。
3. EPLAN 里注册的脚本动作会随注册表残留，但不影响使用；要清干净可以在 EPLAN 里
   重新注册一次指向空脚本，或者忽略（它只在被调用时才执行）。
