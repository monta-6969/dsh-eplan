#!/usr/bin/env node
// 验证「经验库不依赖 EPLAN」。
//
// 这条用例针对的是一个真实踩过的设计错误：lesson 一开始走桥接器进宿主，
// 于是 EPLAN 没开、崩了、被模态框卡住的时候，既读不到经验也写不进去 ——
// 而那恰恰是最需要把教训记下来的时刻。
//
// 做法：用 EPLAN_MCP_CONFIG 指一份假配置（桥接器路径不存在），
// 这样 EPLAN 一定不可达，然后断言三件事：
//   1. lesson add  仍然成功；
//   2. lesson list 仍然读得到刚写的那条；
//   3. workspace status 不报错，而是返回 ready:false + 经验。
//
//   node test/notes-offline.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, '..', 'server', 'server.mjs')

// 假配置：桥接器指向一个绝不会存在的路径，EPLAN 必然不可达。
const scratch = mkdtempSync(join(tmpdir(), 'eplan-mcp-offline-'))
const fakeConfig = join(scratch, 'eplan.config.json')
writeFileSync(
  fakeConfig,
  JSON.stringify({ bridgeExe: join(scratch, 'no-such-bridge.exe') }, null, 2),
  'utf8',
)

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
  // LOCALAPPDATA 也指到临时目录：这个用例要往经验库写东西，
  // 不能把测试数据混进用户真正的 notes.jsonl。
  env: { ...process.env, EPLAN_MCP_CONFIG: fakeConfig, LOCALAPPDATA: scratch },
})

let nextId = 1
const pending = new Map()
let buffer = ''

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let reply
    try {
      reply = JSON.parse(line)
    } catch {
      continue
    }
    const waiter = pending.get(reply.id)
    if (!waiter) continue
    pending.delete(reply.id)
    if (reply.error) waiter.reject(new Error(reply.error.message))
    else waiter.resolve(reply.result)
  }
})

function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

async function callTool(name, args) {
  const reply = await rpc('tools/call', { name, arguments: args })
  const text = reply?.content?.[0]?.text ?? ''
  if (reply?.isError) throw new Error(text)
  return text
}

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

await rpc('initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'eplan-notes-offline', version: '1' },
})

const marker = `离线用例 ${new Date().toISOString()}`

// 1) 写
let added = null
try {
  added = JSON.parse(await callTool('lesson', { action: 'add', text: marker, kind: 'recipe' }))
  check('lesson.add 在 EPLAN 不可达时仍可写', added.saved === true, added.file ?? '')
} catch (error) {
  check('lesson.add 在 EPLAN 不可达时仍可写', false, error.message)
}

// 2) 读回
try {
  const listed = JSON.parse(await callTool('lesson', { action: 'list', query: marker, limit: 5 }))
  const found = (listed.notes ?? []).some((note) => note?.text === marker)
  check('lesson.list 能读回刚写的那条', found, `total=${listed.total}`)
} catch (error) {
  check('lesson.list 能读回刚写的那条', false, error.message)
}

// 3) status 不报错，且带经验
try {
  const status = JSON.parse(await callTool('workspace', { action: 'status' }))
  check('status 在 EPLAN 不可达时不报错', status.ready === false, status.eplan?.code ?? '')
  check(
    'status 仍带回经验',
    Array.isArray(status.lessons?.recent) && status.lessons.recent.length > 0,
    `total=${status.lessons?.total ?? 0}`,
  )
} catch (error) {
  check('status 在 EPLAN 不可达时不报错', false, error.message)
}

child.stdin.end()
child.kill()

const failed = results.filter((item) => !item.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`}：${results.length - failed.length} 项通过`)
process.exit(failed.length === 0 ? 0 : 1)
