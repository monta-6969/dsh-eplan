// EPLAN 不可达时的两个检查：
//   1) status / brief 必须给 nextSteps + doNotRetry（不能只说 ready:false，
//      模型会对着它反复重试 —— session-a18a4a7f 里连调了 5 次、8 次）；
//   2) focus 仍然可用（切模式不依赖 EPLAN），而且符号图鉴是 4 张。
// 用 EPLAN_MCP_CONFIG 指一个不存在的桥接器，模拟 EPLAN 没开。
import { mkdtempSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(resolve(here, '..'), 'server', 'server.mjs')
const dir = mkdtempSync(join(tmpdir(), 'eplan-offline-'))
const configPath = join(dir, 'eplan.config.json')
writeFileSync(configPath, JSON.stringify({ bridgeExe: join(dir, 'no-such-bridge.exe') }), 'utf8')

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, EPLAN_MCP_CONFIG: configPath },
})
let buffer = ''
let nextId = 1
const pending = new Map()
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
})
const rpc = (method, params) => new Promise((done, reject) => {
  const id = nextId++
  pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : done(message.result)))
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  setTimeout(() => reject(new Error(`${method} 超时`)), 60000)
})
const call = async (name, args) => {
  const result = await rpc('tools/call', { name, arguments: args })
  const text = (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const images = (result.content ?? []).filter((b) => b.type === 'image')
  return { text, images, isError: result.isError === true }
}

let pass = 0
let fail = 0
const check = (label, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`✓ ${label}`) } else { fail += 1; console.log(`✗ ${label}${extra ? '\n  ' + extra : ''}`) }
}

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline', version: '0' } })

const status = JSON.parse((await call('workspace', { action: 'status' })).text)
check('status: ready=false', status.ready === false)
check('status: blocked=true', status.blocked === true)
check('status: 有 nextSteps', Array.isArray(status.nextSteps) && status.nextSteps.length >= 3, JSON.stringify(status.nextSteps))
check('status: 第一条指向 launch', String(status.nextSteps?.[0] ?? '').includes('launch'))
check('status: 明确说不要重复调', typeof status.doNotRetry === 'string' && status.doNotRetry.includes('不要重复调用'))

const brief = JSON.parse((await call('workspace', { action: 'brief' })).text)
check('brief: ready=false 也带指引', brief.ready === false && brief.blocked === true && Array.isArray(brief.nextSteps))
check('brief: 不再给「开工顺序」那句误导', brief.hint === undefined)

const focus = await call('workspace', { action: 'focus', mode: 'page' })
const focused = JSON.parse(focus.text)
check('focus: EPLAN 不通也能切模式', focus.isError === false && focused.mode === 'page')
check('focus: 图鉴 4 张', focused.gallery?.length === 4, JSON.stringify(focused.gallery))
check('focus: 图片块 4 张', focus.images.length === 4, `实际 ${focus.images.length}`)

child.kill()
console.log(`\n全部通过：${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
