// 最小的 stdio JSON-RPC 冒烟测试：不依赖任何 MCP 客户端库。
// 用法: node test/raw-smoke.mjs [tools/call 名称] [参数 JSON]
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = resolve(here, '..', 'server', 'server.mjs')

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] })

let buffer = ''
const awaiting = new Map()

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
      console.log('NON-JSON:', line)
      continue
    }
    const entry = awaiting.get(message.id)
    if (entry) {
      awaiting.delete(message.id)
      entry(message)
    } else {
      console.log('PUSH:', JSON.stringify(message).slice(0, 300))
    }
  }
})

let nextId = 1
function rpc(method, params) {
  const id = nextId++
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${method} 超时`)), 30000)
    awaiting.set(id, (message) => {
      clearTimeout(timer)
      resolvePromise(message)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

const init = await rpc('initialize', {
  protocolVersion: '2026-07-28',
  capabilities: {},
  clientInfo: { name: 'raw-smoke', version: '0.0.0' },
})
console.log('INITIALIZE:', JSON.stringify(init.result ?? init.error).slice(0, 400))

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

const tools = await rpc('tools/list', {})
const list = tools.result?.tools ?? []
console.log(`TOOLS (${list.length}):`, list.map((t) => t.name).join(', '))

const callName = process.argv[2]
if (callName) {
  const args = process.argv[3] ? JSON.parse(process.argv[3]) : {}
  const call = await rpc('tools/call', { name: callName, arguments: args })
  console.log('CALL:', JSON.stringify(call.result ?? call.error, null, 2).slice(0, 2000))
}

child.stdin.end()
child.kill()
