// 通过真正的 MCP stdio 协议调用一个工具，验证 DSH 预设走这条路也是通的。
//
// 用法：node test/call-tool.mjs look '{"page":"=MCP/8","project":"test","width":1600}'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const [, , tool, rawArgs] = process.argv
if (!tool) {
  console.error('用法: node test/call-tool.mjs <工具名> [JSON 参数]')
  process.exit(2)
}
const args = rawArgs ? JSON.parse(rawArgs) : {}

// 注意：必须用 fileURLToPath 转换。new URL(...).pathname 在 Windows 上会得到
// /D:/... 这种带前导斜杠的路径，spawn 的 cwd 直接 ENOENT。
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

const child = spawn(process.execPath, ['server/server.mjs'], {
  cwd: projectRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
const pending = new Map()
let nextId = 1

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const resolve = pending.get(message.id)
    if (resolve) {
      pending.delete(message.id)
      resolve(message)
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`))

function request(method, params) {
  const id = nextId++
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 180000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
    child.stdin.write(payload + '\n')
  })
}

try {
  await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'call-tool', version: '0' },
  })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  const reply = await request('tools/call', { name: tool, arguments: args })
  if (reply.error) {
    console.log('RPC_ERROR', JSON.stringify(reply.error))
    process.exitCode = 1
  } else {
    const result = reply.result ?? {}
    const blocks = result.content ?? []
    // 块类型很关键：look 应该同时给出 text 和 image 两种块。
    const summary = blocks
      .map((b) => (b.type === 'image' ? `image(${Math.round(((b.data?.length ?? 0) * 3) / 4 / 1024)}KB)` : 'text'))
      .join(', ')
    console.log(`blocks: ${summary}`)
    const text = blocks.find((b) => b.type === 'text')?.text ?? ''
    console.log(result.isError ? `TOOL_ERROR ${text}` : text.slice(0, 1500))
    if (result.isError) process.exitCode = 1
  }
} finally {
  child.stdin.end()
  child.kill()
}
