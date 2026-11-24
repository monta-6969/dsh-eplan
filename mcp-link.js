/**
 * EPLAN MCP 的挂载层：把 server/server.mjs 接到 DSH 的 MCP 客户端上。
 *
 * 为什么不是一个 static 的 @deepseek-ai/dsh-mcp-client 行：
 * MCP 客户端要的是「可执行文件 + 参数」的绝对路径，而包装到哪台机器、哪个目录
 * 是装的时候才知道的。写死在 cordis.patch.yml 里就只有作者那台机器能跑。
 * 这里在装配时按 __dirname 算出自己的路径，再用 ctx.plugin 把 MCP 客户端挂上，
 * 于是 link: 装、github: 装、npm 装都是同一份配置。
 *
 * 顺带解决另一个问题：node 解释器。桌面版 DSH 的 process.execPath 是
 * DeepSeek Harness.exe（Electron），当 node 用需要 ELECTRON_RUN_AS_NODE=1；
 * 而装了 Node.js 的机器直接用 node.exe 更省事。两种都能处理，见 resolveNode()。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'eplan-mcp-link'

// 不在这里静态 import @deepseek-ai/dsh-mcp-client：那样解析失败会让**整个模块**
// 加载失败，预设里挂在这一行上的一切跟着消失，用户看到的是「这个模式不见了」。
// 改成 apply 里动态 import 并且吞掉失败：最坏情况是 EPLAN 工具没挂上，
// 预设本身照常出现，日志里有一行能看懂的原因。
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

const here = dirname(fileURLToPath(import.meta.url))

/** PATH 里第一个能用的 node，找不到就返回 null。 */
function nodeOnPath() {
  const paths = (process.env.PATH ?? '').split(';').filter(Boolean)
  const names = process.platform === 'win32' ? ['node.exe'] : ['node']
  for (const dir of paths) {
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        // PATH 里可能有读不了的目录，跳过。
      }
    }
  }
  return null
}

/**
 * 选一个能跑 server.mjs 的解释器。
 * 返回 { command, env }：env 只放「必须多给的环境变量」，不整份复制 process.env，
 * 交给 MCP 客户端自己决定怎么合并（它默认继承父进程环境）。
 */
function resolveNode() {
  const explicit = process.env.EPLAN_MCP_NODE
  if (explicit && existsSync(explicit)) return { command: explicit, env: {} }

  // 常规 node 进程（dsh 从命令行起的）：execPath 本身就是 node。
  const exe = process.execPath
  if (exe && /[\\/]node(\.exe)?$/i.test(exe)) return { command: exe, env: {} }

  const fromPath = nodeOnPath()
  if (fromPath) return { command: fromPath, env: {} }

  // 最后一条路：Electron 自带的 node。--remote 之外只需要这个开关。
  return { command: exe, env: { ELECTRON_RUN_AS_NODE: '1' } }
}

export async function apply(ctx) {
  const server = join(here, 'server', 'server.mjs')
  if (!existsSync(server)) {
    process.stderr.write(`[eplan] 缺少 MCP 服务端 ${server}（包装坏了？重装一次 dsh-eplan）\n`)
    return
  }

  let McpClient
  try {
    McpClient = await import(MCP_CLIENT)
  } catch (error) {
    // 预设本身必须还能用：这里只少一组工具，不是少一个模式。
    process.stderr.write(
      `[eplan] 挂不上 MCP 客户端（${MCP_CLIENT}）: ${error instanceof Error ? error.message : String(error)}\n` +
        `[eplan] EPLAN 工具这次不可用；预设其它部分照常。检查 DSH 版本是否与 peerDependencies 匹配。\n`,
    )
    return
  }

  const { command, env } = resolveNode()

  ctx.plugin(McpClient, {
    serverName: 'eplan',
    transport: 'stdio',
    command,
    args: [server],
    ...(Object.keys(env).length > 0 ? { env } : {}),
    // 一张复杂页的 validate / 出图能跑几分钟，默认 60 秒会误杀。
    toolCallTimeoutMs: 300000,
    // EPLAN 没开会连不上：这里不抛，让预设照常起来，由 workspace(status)
    // 给「EPLAN 没在运行，先跑 node setup.mjs」这类可执行的提示。
    failOnStartupError: false,
  })

  process.stderr.write(`[eplan] MCP 服务端: ${server}\n[eplan] 解释器: ${command}\n`)
}
