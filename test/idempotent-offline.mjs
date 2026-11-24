// 离线验证 E7（同页单飞 + 内容幂等）与 E13 的建页自动占位。
//
//   node test/idempotent-offline.mjs
//
// 用 test/stub-bridge.exe 把 page_create 拖慢 1.2 秒，才能看见「并发」这一路；
// 真 EPLAN 建一页通常几十毫秒，两个调用根本撞不上。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const serverPath = join(projectRoot, 'server', 'server.mjs')
const stubPath = join(here, 'stub-bridge.exe')

if (!existsSync(stubPath)) {
  console.error('缺少 test/stub-bridge.exe。先编译：csc /nologo /target:exe /out:test\\stub-bridge.exe test\\stub-bridge.cs')
  process.exit(2)
}

const sandbox = mkdtempSync(join(tmpdir(), 'eplan-idem-'))
const localAppData = join(sandbox, 'localappdata')
mkdirSync(localAppData, { recursive: true })
const configPath = join(sandbox, 'eplan.config.json')
writeFileSync(configPath, JSON.stringify({ bridgeExe: stubPath, requestTimeoutMs: 60000 }), 'utf8')

const child = spawn(process.execPath, [serverPath], {
  cwd: projectRoot,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, LOCALAPPDATA: localAppData, EPLAN_MCP_CONFIG: configPath, STUB_CREATE_DELAY_MS: '1200' },
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
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const resolver = pending.get(message.id)
    if (resolver) {
      pending.delete(message.id)
      resolver(message)
    }
  }
})

function rpc(method, params) {
  const id = nextId++
  return new Promise((resolveCall, rejectCall) => {
    const timer = setTimeout(() => rejectCall(new Error(`${method} 超时`)), 120000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolveCall(message)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

async function callRaw(name, args) {
  const reply = await rpc('tools/call', { name, arguments: args })
  if (reply.error) throw new Error(reply.error.message ?? JSON.stringify(reply.error))
  return reply.result ?? {}
}

async function callJson(name, args) {
  const result = await callRaw(name, args)
  const text = result.content?.find?.((block) => block.type === 'text')?.text ?? ''
  const parsed = JSON.parse(text)
  if (result.isError) {
    const error = new Error(parsed.message)
    error.code = parsed.code
    throw error
  }
  return parsed
}

let passed = 0
const failures = []
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`)
  } else {
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`)
  }
}

await rpc('initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'idempotent-offline', version: '1' },
})
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

const definition = {
  name: '=STUB/P1',
  project: 'stub',
  type: 'Schematic',
  grid: 4,
  nodes: [{ symbol: 'F1', at: [100, 200], deviceTag: '-F1' }],
  texts: [{ at: [100, 220], text: 'title' }],
}

console.log('同页单飞：')
const firstPromise = callRaw('page_create', definition)
await new Promise((resolveWait) => setTimeout(resolveWait, 150))
const busy = await callJson('page_create', definition)
check('并发提交被 PAGE_IN_PROGRESS 挡回', busy.code === 'PAGE_IN_PROGRESS' && busy.busy === true, busy.code)
check('挡回时给出开始时间与做法', typeof busy.startedAt === 'string' && typeof busy.hint === 'string')
const first = JSON.parse((await firstPromise).content[0].text)
check('第一个请求正常完成', first.created === true, JSON.stringify(first).slice(0, 60))

console.log('\n内容幂等：')
const again = await callJson('page_create', definition)
check('同定义 3 分钟内重复提交回 unchanged', again.unchanged === true && typeof again.digest === 'string')
check('unchanged 自带解释与 force 提示', typeof again.hint === 'string' && again.hint.includes('force=true'))
const forced = await callJson('page_create', { ...definition, force: true })
check('force:true 真的重建', forced.created === true && forced.unchanged === undefined)

const changed = await callJson('page_create', { ...definition, texts: [{ at: [100, 220], text: 'title v2' }] })
check('定义变了就重建', changed.created === true && changed.unchanged === undefined)

console.log('\n建页自动占位：')
const plan = await callJson('workspace', { action: 'plan_get', project: 'stub' })
check('建页后这一页被占位', Boolean(plan.locks?.['=STUB/P1']), JSON.stringify(plan.locks ?? {}))
check('占位记在当前进程名下', String(plan.locks?.['=STUB/P1']?.owner ?? '').startsWith('mcp:'))

console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}：${passed} 项通过`)
child.stdin.end()
child.kill()
process.exit(failures.length === 0 ? 0 : 1)
