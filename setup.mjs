#!/usr/bin/env node
// EPLAN MCP 安装器：在一台全新机器上把整条链路搭起来。
//
// 目标：换了机器只跑 `node setup.mjs`，不用读文档。
//
// 它做四件事：
//   1. 发现环境（EPLAN 装在哪、版本多少、node/csc 有没有、数据目录在哪）
//   2. 写 %LOCALAPPDATA%\eplan-mcp\eplan.config.json —— 所有写死的路径都收进这个文件
//   3. 编译宿主 DLL 和桥接器 EXE（必须在本机编译：引用的是本机 EPLAN 的程序集）
//   4. 把引导脚本注册进 EPLAN，然后跑一次 status 自检
//
// 为什么必须在目标机编译：宿主 DLL 引用 Eplan.EplApi.DataModelu.dll 等本机程序集，
// 2.9 和 2.10 的 API 不一样，把别的机器编好的 DLL 拷过来会 MissingMethodException。
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = here
const log = (message) => console.log(message)
const step = (n, text) => console.log(`\n[${n}/5] ${text}`)

/** 从注册表和常见安装位置找 EPLAN。 */
function findEplan() {
  const candidates = []

  // 1. 注册表：EPLAN 安装时写的路径（不同版本键名不一样，全试一遍）
  const regKeys = [
    'HKLM\\SOFTWARE\\EPLAN\\Platform\\2.9',
    'HKLM\\SOFTWARE\\EPLAN\\Platform\\2.8',
    'HKLM\\SOFTWARE\\EPLAN\\Platform\\2.7',
    'HKLM\\SOFTWARE\\WOW6432Node\\EPLAN\\Platform\\2.9',
  ]
  for (const key of regKeys) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const match = out.match(/Path\s+REG_\w+\s+(.+)/)
      if (match) candidates.push(join(match[1].trim(), 'Bin', 'Eplan.exe'))
    } catch {
      /* 这个键不存在，继续试下一个 */
    }
  }

  // 2. 常见安装盘符
  for (const drive of ['C:', 'D:', 'E:']) {
    for (const version of ['2.9.4', '2.9', '2.10']) {
      candidates.push(`${drive}\\EPLAN\\Platform\\${version}\\Bin\\Eplan.exe`)
    }
  }

  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

function findCsc() {
  const candidates = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}

function findDataRoot() {
  const path = 'C:\\Users\\Public\\EPLAN\\Data'
  return existsSync(path) ? path : null
}

function newestFile(dir, pattern) {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => ({ name, time: statSyncSafe(join(dir, name)) }))
    .sort((a, b) => b.time - a.time)
  return files.length > 0 ? join(dir, files[0].name) : null
}

function statSyncSafe(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------

step(1, '查找 EPLAN')
const eplanExe = findEplan()
if (!eplanExe) {
  console.error(`
没找到 EPLAN。

请先安装 EPLAN Electric P8，或者手动在 %LOCALAPPDATA%\\eplan-mcp\\eplan.config.json 里写 eplanExe：

  { "eplanExe": "D:\\\\EPLAN\\\\Platform\\\\2.9.4\\\\Bin\\\\Eplan.exe" }
`)
  process.exit(2)
}
log(`    EPLAN: ${eplanExe}`)

const eplanVersion = (eplanExe.match(/Platform\\(\d+\.\d+(\.\d+)?)/) ?? [])[1] ?? null
log(`    版本: ${eplanVersion ?? '(未知)'}`)

step(2, '检查编译环境')
const csc = findCsc()
if (!csc) {
  console.error('   没有找到 csc.exe。需要 .NET Framework 4.x（Windows 自带；若缺失请装 .NET Framework 4.8）。')
  process.exit(3)
}
log(`    csc: ${csc}`)
log(`    node: ${process.version}`)

const dataRoot = findDataRoot()
log(`    数据目录: ${dataRoot ?? '(未找到，将使用默认值)'}`)

step(3, '写配置')
const config = {
  eplanExe,
  eplanVariant: 'Electric P8',
  symbolLibrary: 'GB_symbol',
  requestTimeoutMs: 290000,
}
if (dataRoot) config.dataRoot = dataRoot

// 配置写在用户目录，不写在包目录：包在升级时会被整体替换，写在包里升一次级就得重跑。
const configDir = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'eplan-mcp')
mkdirSync(configDir, { recursive: true })
const configPath = join(configDir, 'eplan.config.json')
writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
log(`    已写: ${configPath}`)

step(4, '编译宿主和桥接器、生成引导脚本')
// 这三步必须在目标机做：DLL 引用的是本机 EPLAN 的程序集，
// 引导脚本又要写死刚编译出来的宿主目录，所以顺序不能换。
for (const build of ['native\\host\\build.ps1', 'native\\bridge\\build.ps1', 'native\\script\\prepare-install.ps1']) {
  const full = join(root, build)
  if (!existsSync(full)) {
    console.error(`   缺少构建脚本: ${full}`)
    process.exit(4)
  }
  log(`    ${build} ...`)
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', full], {
    encoding: 'utf8',
    timeout: 300000,
  })
  if (result.status !== 0) {
    console.error((result.stdout ?? '') + (result.stderr ?? ''))
    console.error(`   构建失败: ${build}`)
    process.exit(4)
  }
  log('   成功')
}

step(5, '注册引导脚本并自检')
log('    注意：这一步需要 EPLAN 正在运行。')

const bridge = newestFile(join(root, 'native', 'bridge', 'bin'), /^EplanBridge.*\.exe$/i)
if (!bridge) {
  console.error('   没找到编译出来的桥接器。')
  process.exit(5)
}

// 桥接器读的是标准输入上的 JSON 行（一次调用一条），不是命令行参数。
function callBridge(op, args = {}, timeout = 300000) {
  const payload = JSON.stringify({ id: 'setup', op, args }) + String.fromCharCode(10)
  const result = spawnSync(bridge, [], { input: payload, encoding: 'utf8', timeout })
  return (result.stdout ?? '').trim()
}

// install 要拿到引导脚本的路径（注册的是脚本文件，不是宿主的 DLL）。
const bootstrap = newestFile(join(root, 'native', 'script'), /^EplanMcpBootstrap.*\.cs$/i)
if (!bootstrap) {
  console.error('   没找到引导脚本（native/script/EplanMcpBootstrap-*.cs）。先跑 native/script/prepare-install.ps1。')
  process.exit(5)
}
log('    引导脚本: ' + bootstrap)
const installText = callBridge('install', { script: bootstrap })
// EPLAN 没开时桥接器有两种说法：早期的 EPLAN_NOT_RUNNING，和 Remoting 直接拒绝连接
// （EndpointNotFoundException / 10061）。都算「没在运行」，否则会掉进最后那个
// 「装好了，但还没打开项目」的分支，把人指错方向。
const eplanDown = /EPLAN_NOT_RUNNING|EndpointNotFoundException|10061/.test(installText)
if (eplanDown) {
  // 注册和自检都得在 EPLAN 进程里做，EPLAN 没开就一定失败。
  // 早退能少打两行一模一样的报错，也免得让人以为「注册这一步出错了」。
  log(`
EPLAN 没在运行，注册和自检都跳过了 —— 这两步必须在 EPLAN 里做。
打开 EPLAN Electric P8（双击桌面快捷方式）并载入项目，再跑一次：
  node setup.mjs
`)
  process.exit(0)
}
log(installText.slice(0, 600))

const statusText = callBridge('status', {}, 120000)
log(statusText.slice(0, 800))

if (/EPLAN_NOT_RUNNING|EndpointNotFoundException|10061/.test(statusText)) {
  log(`
EPLAN 没在运行。装好后打开 EPLAN（双击桌面快捷方式即可），再跑一次：
  node setup.mjs
`)
} else if (statusText.indexOf('"ready":true') >= 0) {
  log('\n全部就绪。在 DSH 里选「eplan绘图自动化」模式即可开始。\n想逐项确认每个工具都能用，再跑一次：node test/smoke-all.mjs')
} else {
  log('\n装好了，但 EPLAN 还没打开项目。在 EPLAN 里打开一个项目后重试 status。')
}

// 最后顺手清一下临时目录：渲染图和手册截图会一直攒着，没人清就是几个 MB 起步。
// 失败不影响安装结果，所以只打印、不改变退出码。
try {
  const pruned = execFileSync(process.execPath, [join(root, 'native', 'script', 'prune.mjs')], {
    encoding: 'utf8',
    timeout: 60000,
  })
  const freed = Number(JSON.parse(pruned)?.freedBytes ?? 0)
  if (freed > 0) log(`顺带清掉了 ${(freed / 1048576).toFixed(1)} MB 临时文件。`)
} catch {
  // 清理是附加动作，出错就算了。
}
