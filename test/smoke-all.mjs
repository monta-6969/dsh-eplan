// 预设自检：把 12 个工具挨个走一遍，只做安全操作。
//
// 目的不是测 EPLAN，而是测「这条链路还通不通」：
// 换了机器、升级了 DSH、改了 server.mjs，跑一遍就知道有没有断。
//
//   node test/smoke-all.mjs           只读，不碰用户的图
//   node test/smoke-all.mjs --write   额外跑 dryRun 和建页（会建一张 =SMOKE 临时页）
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverPath = path.join(here, '..', 'server', 'server.mjs')
const bundleRoot = path.join(here, '..')
const withWrite = process.argv.includes('--write')

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] })

let nextId = 1
const pending = new Map()
let buffer = ''

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
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
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    child.stdin.write(payload)
    setTimeout(() => reject(new Error(`超时：${method} #${id}`)), 120000)
  })
}

async function call(name, args = {}) {
  const reply = await rpc('tools/call', { name, arguments: args })
  if (reply.error) throw new Error(reply.error.message || JSON.stringify(reply.error))
  const text = reply.result?.content?.[0]?.text ?? ''
  if (reply.result?.isError) {
    let detail = text
    try {
      detail = JSON.parse(text).message || text
    } catch {}
    throw new Error(detail)
  }
  return text
}

const results = []

// 读当前前台窗口的 pid。抢焦点是「用户能感觉到」的那一类 bug，
// 但这个测试跑在后台进程里，光看 API 返回看不出来，只能问系统。
function foregroundPid() {
  if (process.platform !== 'win32') return null
  try {
    const raw = execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(bundleRoot, 'test', 'foreground.ps1')],
      { encoding: 'utf8', timeout: 20000 },
    )
    const parsed = JSON.parse(raw.trim())
    return typeof parsed.pid === 'number' ? parsed.pid : null
  } catch {
    return null
  }
}

async function probe(label, name, args, { optional = false } = {}) {
  const started = Date.now()
  try {
    const text = await call(name, args)
    const ms = Date.now() - started
    let brief = text.replace(/\s+/g, ' ').slice(0, 90)
    try {
      const parsed = JSON.parse(text)
      const keys = Object.keys(parsed).slice(0, 6).join(',')
      brief = keys || brief
    } catch {}
    results.push({ label, ok: true, optional, ms, brief })
    console.log(`  ✓ ${label.padEnd(20)} ${String(ms).padStart(5)} ms  ${brief}`)
    return text
  } catch (error) {
    results.push({ label, ok: false, optional, error: error.message })
    const mark = optional ? '·' : '✗'
    console.log(`  ${mark} ${label.padEnd(20)} 失败：${error.message}`)
    return undefined
  }
}

await rpc('initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'eplan-smoke', version: '1' },
})

const listed = await rpc('tools/list', {})
const toolNames = (listed.result?.tools ?? []).map((tool) => tool.name)
console.log(`工具数：${toolNames.length}`)
console.log(`工具：${toolNames.join(', ')}\n`)

console.log('只读检查：')
const statusText = await probe('workspace.status', 'workspace', { action: 'status' })
// status 现在即使 EPLAN 不可达也会成功返回（ready:false + 经验），
// 所以不能再用「第一次探测失败」来判断环境。要看 ready 字段。
let eplanReady = results[0].ok
try {
  if (statusText) eplanReady = JSON.parse(statusText)?.ready !== false
} catch {
  // 解析不出来就按失败处理，别假装环境是好的。
  eplanReady = false
}
// EPLAN 没开的话，后面的探针会全部退化成「参数校验失败」这种误导性错误，
// 看起来像是代码坏了。直接说清楚，别让人去查不存在的 bug。
if (!eplanReady) {
  console.log('\nEPLAN 没在运行，后面的检查全部跳过。')
  console.log('先打开 EPLAN Electric P8 并载入项目，再跑这个脚本。')
  console.log('（经验库不依赖 EPLAN，lesson 仍然可用 —— 上面那一项已经验过。）')
  child.kill()
  process.exit(1)
}
await probe('workspace.list_pages', 'workspace', { action: 'list_pages' })
await probe('symbol_catalog.search', 'symbol_catalog', { action: 'search', filter: 'F', limit: 5 })
await probe('symbol_catalog.pins', 'symbol_catalog', {
  action: 'pins',
  library: 'GB_symbol',
  symbols: ['F1'],
})
await probe('symbol_catalog.lookup', 'symbol_catalog', { action: 'lookup', query: '断路器' }, { optional: true })
await probe('operation_history', 'operation_history', {})
// 只读地读经验库：不写记录，避免自检本身往用户的经验文件里塞垃圾。
await probe('lesson.list', 'lesson', { action: 'list', limit: 3 }, { optional: true })

// 有页才能检查；拿第一页来试。
let firstPage = null
try {
  const text = await call('workspace', { action: 'list_pages' })
  firstPage = JSON.parse(text)?.pages?.[0]?.name ?? null
} catch {}

if (firstPage) {
  await probe('validate', 'validate', { page: firstPage })
  await probe('page_inspect.structure', 'page_inspect', { format: 'structure', page: firstPage })
  await probe('page_inspect.image', 'page_inspect', { format: 'image', page: firstPage, width: 900 })
  await probe('export', 'export', { pages: [firstPage], kind: 'png' })
} else {
  console.log('  · 没有可用的页，跳过 validate/page_inspect/export')
}

if (withWrite) {
  console.log('\n写入检查（dryRun 与临时页）：')
  await probe('page_create', 'page_create', { name: '=SMOKE/1', dryRun: true })
  await probe('page_edit.draw_graphics', 'page_edit', {
    action: 'draw_graphics',
    page: firstPage,
    dryRun: true,
    items: [{ kind: 'text', at: [10, 10], text: 'smoke' }],
  })
  await probe('page_edit.insert_symbol', 'page_edit', {
    action: 'insert_symbol',
    page: firstPage,
    symbol: 'F1',
    at: [20, 20],
    dryRun: true,
  })
  await probe('page_edit.set_properties', 'page_edit', {
    action: 'set_properties',
    page: firstPage,
    get: ['PAGE_COUNTER'],
  }, { optional: true })
  await probe('manual.outline', 'manual', { action: 'outline' }, { optional: true })
  // open_page 放最后：它一旦卡住（EPLAN 会弹「硬件错误:存储器访问受阻」模态框把主线程锁死），
  // 后面的探针会跟着报「桥接器已退出」，看不出是谁真的坏了。
  // open_page 不该抢焦点。取样只能包在一次调用外面，所以前后各读一次前台 pid。
  const focusBefore = foregroundPid()
  await probe(
    'workspace.open_page',
    'workspace',
    { action: 'open_page', page: firstPage ?? '=SMOKE/1' },
    { optional: true },
  )
  const focusAfter = foregroundPid()
  if (focusBefore != null && focusAfter != null) {
    const same = focusBefore === focusAfter
    results.push({
      label: 'focus.unchanged',
      ok: same,
      optional: false,
      ms: 0,
      brief: `前台 pid ${focusBefore} → ${focusAfter}`,
    })
    console.log(
      same
        ? `  ✓ ${'focus.unchanged'.padEnd(20)}         前台 pid 仍是 ${focusBefore}`
        : `  ✗ ${'focus.unchanged'.padEnd(20)} 失败：前台 pid ${focusBefore} → ${focusAfter}` +
            '（若你当时正在切换窗口，这一项可能是误报，请无人值守地重跑一次）',
    )
  }
} else {
  console.log('\n（写入类工具已跳过；加 --write 一并检查）')
}

// optional 的失败不算失败：那是环境不具备（比如没给 PDF 文件），不是链路断了。
const failed = results.filter((item) => !item.ok && !item.optional)
const skipped = results.filter((item) => !item.ok && item.optional).length
const passed = results.length - skipped
const verdict = failed.length === 0 ? '全部通过' : `${failed.length} 项失败`
console.log(`\n${verdict}：${passed} 项通过` + (skipped > 0 ? `，${skipped} 项跳过` : ''))

child.kill()
process.exit(failed.length === 0 ? 0 : 1)
