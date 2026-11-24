// 离线验证 E5（present job 化）与 E13（改页占用门）。
//
// 用 test/stub-bridge.exe 顶替真 EPLAN：present 的 120 秒风险在「等」，
// 不在 EPLAN 本身，所以让替身把 look 拖 1.5 秒，就能把
// 「立刻返回 → 轮询 → 出图」和「同页复用同一个 job」都走一遍。
//
//   node test/present-offline.mjs
//
// 不需要 EPLAN 在跑，不需要桥接器，不碰用户项目。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const serverPath = join(projectRoot, 'server', 'server.mjs')
const stubPath = join(here, 'stub-bridge.exe')

if (!existsSync(stubPath)) {
  console.error('缺少 test/stub-bridge.exe。先编译：')
  console.error('  csc /nologo /target:exe /out:test\\stub-bridge.exe test\\stub-bridge.cs')
  process.exit(2)
}

// 隔离 LOCALAPPDATA：台账 / 经验库 / 锁全写进临时目录，不污染真实用户数据。
const sandbox = mkdtempSync(join(tmpdir(), 'eplan-present-'))
const localAppData = join(sandbox, 'localappdata')
mkdirSync(localAppData, { recursive: true })
const configPath = join(sandbox, 'eplan.config.json')
writeFileSync(
  configPath,
  JSON.stringify({ bridgeExe: stubPath, requestTimeoutMs: 60000, renderTheme: 'dark' }, null, 2),
  'utf8',
)

const child = spawn(process.execPath, [serverPath], {
  cwd: projectRoot,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    LOCALAPPDATA: localAppData,
    EPLAN_MCP_CONFIG: configPath,
    // 让 present 明确慢下来：不设这个，job 在第一次轮询前就完成了。
    STUB_LOOK_DELAY_MS: '1500',
  },
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
  const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
  return new Promise((resolveCall, rejectCall) => {
    const timer = setTimeout(() => rejectCall(new Error(`${method} 超时`)), 120000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolveCall(message)
    })
    child.stdin.write(payload)
  })
}

async function callRaw(name, args) {
  const reply = await rpc('tools/call', { name, arguments: args })
  if (reply.error) throw new Error(reply.error.message ?? JSON.stringify(reply.error))
  return reply.result ?? {}
}

function textOf(result) {
  return result.content?.find?.((block) => block.type === 'text')?.text ?? ''
}

function jsonOf(result) {
  try {
    return JSON.parse(textOf(result))
  } catch {
    return null
  }
}

async function callJson(name, args) {
  const result = await callRaw(name, args)
  if (result.isError) {
    const parsed = jsonOf(result) ?? {}
    const error = new Error(parsed.message ?? textOf(result))
    error.code = parsed.code
    throw error
  }
  return jsonOf(result)
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

// 工具面：focus 之后 tools/list 里还剩下多少字符。
async function face(mode) {
  await callRaw('workspace', { action: 'focus', mode })
  const listed = await rpc('tools/list', {})
  const tools = listed.result?.tools ?? []
  const chars = tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0)
  return { chars, names: tools.map((tool) => tool.name) }
}

await rpc('initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'present-offline', version: '1' },
})
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

console.log('工具面（focus 后 tools/list 字符数）：')
const faces = {}
for (const mode of ['page', 'edit', 'check', 'lib', 'all']) {
  faces[mode] = await face(mode)
  console.log(`  ${mode.padEnd(5)} ${String(faces[mode].chars).padStart(6)}  ${faces[mode].names.join(',')}`)
}
// focus 现在只补「本模式必填参数」，不再按模式裁工具面：PTC 下 12 个工具都是
// 程序里的绑定，遮掉哪个都会让照着提示词写出来的程序当场报错。
check('page 模式工具面 ≤ 14800', faces.page.chars <= 14800, `${faces.page.chars} 字符`)
check('page 模式含 workspace', faces.page.names.includes('workspace'))
check('page 模式含 page_edit', faces.page.names.includes('page_edit'))

// 行为测试要用全部工具。
await callRaw('workspace', { action: 'focus', mode: 'all' })

console.log('\npresent job：')
const started = Date.now()
const first = await callJson('workspace', {
  action: 'present',
  project: 'stub',
  page: '=STUB/1',
  present: { wait: false, width: 800 },
})
const firstMs = Date.now() - started
check('wait:false 立刻返回', first.state === 'running', `${firstMs} ms`)
check('返回 jobId', typeof first.jobId === 'string' && first.jobId.startsWith('present-'), first.jobId)
check('不等图（无 image 块）', !first.imagePath)
check('wait:false 提示怎么取', typeof first.hint === 'string' && first.hint.includes('action:"wait"'))
check('wait:false 返回体 ≤ 500 字符', JSON.stringify(first).length <= 500, `${JSON.stringify(first).length}`)

const second = await callJson('workspace', {
  action: 'present',
  project: 'stub',
  page: '=STUB/1',
  present: { wait: false },
})
check('同页重复提交复用同一个 job', second.jobId === first.jobId && second.reused === true, `${second.jobId}`)

const early = await callJson('workspace', { action: 'wait', jobId: first.jobId, timeoutMs: 500 })
check('wait 超时回 running 而不是报错', early.state === 'running', `${JSON.stringify(early).slice(0, 80)}`)

const doneRaw = await callRaw('workspace', { action: 'wait', jobId: first.jobId, timeoutMs: 20000 })
const done = jsonOf(doneRaw)
const imageBlocks = doneRaw.content?.filter?.((block) => block.type === 'image') ?? []
check('wait 等到 done', done?.state === 'done')
check('done 带渲染图块', imageBlocks.length === 1, `${imageBlocks.length} 张`)
check('done 带 imagePath 与 counts', typeof done.imagePath === 'string' && done.counts?.symbols === 2)
check('done 报告 actual visible', done.visible === true)
check('done 文本与图都不大', textOf(doneRaw).length <= 500, `${textOf(doneRaw).length} 字符`)

const again = await callJson('workspace', { action: 'wait', jobId: first.jobId, timeoutMs: 1000 })
check('已完成的 job 再 wait 直接回 done', again.state === 'done')

// 默认等待：waitMs 到点必须返回，而不是把整段程序拖过 120 秒。
const third = Date.now()
const bounded = await callJson('workspace', {
  action: 'present',
  project: 'stub',
  page: '=STUB/2',
  present: { wait: true, waitMs: 1000 },
})
const boundedMs = Date.now() - third
check('wait:true 受 waitMs 约束', bounded.state === 'running' && boundedMs < 1800, `${boundedMs} ms`)
// 把它等完，避免退出时留下未完成的 job。
await callRaw('workspace', { action: 'wait', jobId: bounded.jobId, timeoutMs: 20000 })

console.log('\n改页占用门：')
const lockFile = join(localAppData, 'eplan-mcp', 'projects', 'stub', 'lock.json')

/** 直接写锁文件来模拟「另一个会话占着」——比让对方会话真的去 claim 简单得多。 */
function putLock(page, owner, at = new Date().toISOString()) {
  mkdirSync(dirname(lockFile), { recursive: true })
  let pages = {}
  if (existsSync(lockFile)) {
    try {
      pages = JSON.parse(readFileSync(lockFile, 'utf8')).pages ?? {}
    } catch {
      pages = {}
    }
  }
  pages[page] = { owner, at }
  writeFileSync(lockFile, JSON.stringify({ updatedAt: at, pages }), 'utf8')
}

const mine = await callJson('workspace', { action: 'claim', project: 'stub', page: '=STUB/1' })
check('自己的会话可以占位', mine.claimed === true)

putLock('=STUB/1', 'other-session')
let blocked = null
try {
  await callJson('page_edit', {
    action: 'set_properties',
    project: 'stub',
    page: '=STUB/1',
    get: ['PAGE_COUNTER'],
  })
} catch (error) {
  blocked = error
}
check('别人占着时 page_edit 被 CLAIMED 挡住', blocked?.code === 'CLAIMED', blocked?.message?.slice(0, 60))

const forced = await callJson('page_edit', {
  action: 'set_properties',
  project: 'stub',
  page: '=STUB/1',
  get: ['PAGE_COUNTER'],
  force: true,
})
check('force:true 可以接手', forced?.values?.PAGE_COUNTER === '1')
check('接手时说明从谁手里接的', forced?.claim?.tookOverFrom === 'other-session', JSON.stringify(forced?.claim ?? {}))

// dryRun 只探路：不该被占位挡住。
putLock('=STUB/1', 'other-session')
const dry = await callJson('page_edit', {
  action: 'draw_graphics',
  project: 'stub',
  page: '=STUB/1',
  dryRun: true,
  draw: [{ kind: 'text', at: [10, 10], text: 'smoke' }],
})
check('dryRun 不受占位影响', dry?.op === 'draw' || dry?.ok === true)

// 删页：别人占着要挡；force 删掉后占位自动释放。
putLock('=STUB/1', 'other-session')
let deleteBlocked = null
try {
  await callJson('page_delete', { project: 'stub', page: '=STUB/1' })
} catch (error) {
  deleteBlocked = error
}
check('别人占着时 page_delete 被挡', deleteBlocked?.code === 'CLAIMED')
const removed = await callJson('page_delete', { project: 'stub', page: '=STUB/1', force: true })
check('force 删除成功', removed?.deleted === true)
const plan = await callJson('workspace', { action: 'plan_get', project: 'stub' })
check('删页后占位自动释放', Object.keys(plan?.locks ?? {}).length === 0, JSON.stringify(plan?.locks ?? {}))

// 旧占位（超过 20 分钟守护窗口）不该再挡人。
putLock('=STUB/9', 'gone', new Date(Date.now() - 2 * 3600 * 1000).toISOString())
const stale = await callJson('page_edit', {
  action: 'set_properties',
  project: 'stub',
  page: '=STUB/9',
  get: ['PAGE_COUNTER'],
})
check('两小时前的旧占位不挡路', stale?.values?.PAGE_COUNTER === '1')
check('接手旧占位有记录', stale?.claim?.tookOverFrom === 'gone')

console.log('\nexport job：')
const exportStart = await callJson('export', { project: 'stub', kind: 'png', pages: ['=STUB/1'], wait: false })
check('export wait:false 回 jobId', exportStart.state === 'running' && exportStart.jobId.startsWith('export-'), exportStart.jobId)
const exportDone = await callJson('workspace', { action: 'wait', jobId: exportStart.jobId, timeoutMs: 15000 })
check('export job 等到 done', exportDone.state === 'done' && exportDone.kind === 'export', `${exportDone.state}/${exportDone.kind}`)
check('export 不带图片块', !exportDone.imagePath)
// operation_history 的 wait 走同一个 job 表，不能修好一个坏一个。
const viaHistoryRaw = await callRaw('operation_history', { action: 'wait', jobId: exportStart.jobId, timeoutMs: 5000 })
const viaHistory = jsonOf(viaHistoryRaw)
check('operation_history wait 也能取到同一个 job', viaHistory?.state === 'done' && viaHistory.jobId === exportStart.jobId)

console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}：${passed} 项通过`)
child.stdin.end()
child.kill()
process.exit(failures.length === 0 ? 0 : 1)
