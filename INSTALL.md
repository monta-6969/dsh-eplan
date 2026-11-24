# 在新机器上安装「EPLAN 绘图」模式

这份文档对应 `dist/local-dsh-eplan-preset-0.3.0.tgz`。

## 前提

| 需要什么 | 说明 |
|---|---|
| EPLAN Electric P8 2.9（或兼容版本） | 必须有 **Remoting**（现装版本默认开）；启动后监听 49152 |
| Windows 10 / 11 | PDF 渲染依赖系统自带 `Windows.Data.Pdf` |
| Node.js 18+ | MCP 服务端 |
| .NET Framework 4.x | 用系统自带的 `csc.exe` 编译宿主和桥接器，**不需要装 SDK** |

## 三步装完

```powershell
# 1. 解包
tar -xzf local-dsh-eplan-preset-0.3.0.tgz
# 得到 package/ 目录，放进一个固定的地方，例如 D:\tools\eplan-mcp
Move-Item .\package D:\tools\eplan-mcp

# 2. 装依赖
cd D:\tools\eplan-mcp
npm install --omit=dev

# 3. 自检 + 编译 + 注册（EPLAN 要开着）
node setup.mjs
```

`setup.mjs` 会依次做：找 EPLAN（注册表 + 常见路径）、校验 `csc`/node、写
`server/eplan.config.json`、在本机编译宿主 DLL 和桥接器 EXE、注册引导脚本、跑一次
`workspace(action="status")` 自检。全部通过会打印 `全部就绪`。

## 装完怎么验

`setup.mjs` 只证明「编译好了、宿主注册上了」。要证明**每个工具都能用**，跑自检：

```powershell
node test/smoke-all.mjs          # 只读，不碰你的图
node test/smoke-all.mjs --write  # 再加上 dryRun 和建页检查
```

它会开一个 MCP 子进程，把 12 个工具挨个调一遍，逐条打印耗时和返回的字段，
最后给一句 `全部通过：N 项通过`。链路哪一段断了，一眼就能看到断在第几个工具。
EPLAN 没开的话脚本会直接说「EPLAN 没在运行」，不会甩一堆看不懂的参数错误。

`manual` 一项会因为没给文件而跳过，那不算失败。

看视频的 `video` 工具**不在**这一组里（它不走 MCP，是预设里的原生工具），
单独用 `node test/video-offline.mjs [视频路径]` 验证，不需要 EPLAN，但需要 `ffmpeg`。

还有两条离线用例，**不需要 EPLAN 在运行**：

```powershell
node test/video-offline.mjs   # 拿真实视频跑一遍：区域裁剪、步骤归并、图片装配
node test/notes-offline.mjs   # 把桥接器指向不存在的路径，验证经验库照常可读写
node test/nudge-offline.mjs   # 验证 goal 收尾提醒在该触发时触发、不该触发时不打扰
```

## 接进 DSH

在 DSH 的 profile（默认 `C:\Users\<你>\.dsh\profiles\desktop\`）里做两件事：

1. `package.json` 的 `dependencies` 加一行：
   ```json
   "@local/dsh-eplan-preset": "link:D:/tools/eplan-mcp"
   ```
2. 同文件的 `dsh.profile.bundles` 数组里加上 `"@local/dsh-eplan-preset"`。

然后**重启 DSH**（`link:` 包只在启动时读，热改不生效）。重启后新建对话，
模式列表里会出现 **「EPLAN 绘图自动化」**：

- 唯一的直接工具是 `run_code`；EPLAN 工具写成程序里的 `await tools.mcp__eplan__*`，
  一段程序画完一页，中间结果不占对话。
- 旧的逐工具模式在 v0.12 删除；如果你之前建过 `preset-eplan` 的会话，重启后按新组合运行。
- 同一时间只用一个 EPLAN 会话：各起一个 server 会抢 EPLAN 的 Remoting 端口。

## 为什么必须在本机编译

宿主 DLL 引用的是**本机 EPLAN 的程序集**（`Eplan.EplApi.DataModelu.dll` 等）。
2.9 和 2.10 的 API 不一样，把别的机器编好的 DLL 拷过来会 `MissingMethodException`。
所以 `setup.mjs` 每次都重新编译，`dist/` 里也**不带**任何编译产物。

## 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| `没找到 EPLAN` | 注册表里没有，且不在常见盘符 | 手动写 `server/eplan.config.json` 的 `eplanExe` |
| 编译报 `CS0246` | 本机 EPLAN 版本 API 不同 | 看报错里的类型名，对应改 `host/src/*.cs` |
| `EPLAN_NOT_RUNNING` | EPLAN 没开 | 双击桌面快捷方式打开，再跑 `node setup.mjs` |
| `EPLAN_BLOCKED_BY_DIALOG` | EPLAN 被模态框挡住（常见是启动时的「系统信息」） | 点掉那个框，重试 |
| `RegisterScript` 返回 false | 脚本目录只读或权限不足 | 检查 `C:\Users\Public\EPLAN\Data\脚本\<公司名>\` 是否可写 |

## 卸载

1. DSH profile 里删掉那两处引用，重启 DSH。
2. 删掉安装目录。

积累下来的经验与符号语义不在安装目录里，想清掉要另外删
`%LOCALAPPDATA%\eplan-mcp\knowledge\`（`notes.jsonl` 与 `symbols.json`）。
操作日志和临时图在 `%TEMP%\eplan-mcp\`，可以随系统清理。
3. EPLAN 里注册的脚本动作会随注册表残留，但不影响使用；要清干净可以在 EPLAN
   里重新注册一次 `RegisterScript` 指向空脚本，或者忽略（它只在被调用时才执行）。
