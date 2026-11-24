// 工具面预算表：focus 各模式后 tools/list 的实际字符数。
//
// 为什么单独量：常驻 schema 是每一轮都要付的固定成本，和调用次数无关。
// 改动任何一个工具的 description / schema 之后跑一遍，别让它悄悄长回去。
//
//   node test/tool-face.mjs            # 汇总 + page 模式逐工具明细
//   node test/tool-face.mjs edit       # 看某个模式的逐工具明细
//
// 不需要 EPLAN：只用 workspace 的 focus，其余工具不调用。
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(resolve(here, '..'), 'server', 'server.mjs')
const detailMode = process.argv[2] ?? 'page'
// page 模式在 2026-11-23 起包含 page_edit：工作单元从「整页一次 page_create」改成
// 「按单元提交」，必须能在已建好的页上增量插入，所以预算从 9500 上调到 14000。
// 换来的收益：每页少 3~5 轮整页重建，一次重建的载荷就超过这 4.5k。
// 2026-11-23 又上调一次（edit 11000→11400、all 19500→19700）：workspace 多了 follow
// 开关（写入后自动在 EPLAN 打开那一页），它挂在所有模式共用的那个工具上，每个模式都涨了
// 约 40 字符。规则没变长，只是多了一个开关的说明。
//
// 2026-11-23 第三次上调（page 14000→14800、edit 11400→12000、all 19700→20500）：
// 全部来自 session-a18a4a7f 的实测摩擦，不是形容词堆出来的——
//   · workspace +launch：模型不知道有这个，自己杀/起 EPLAN 花了 25 次调用；
//   · symbol_catalog +visual 与中文概念：它用「按钮」搜不到，翻全表 + 建 4 张试画页花了 18 次；
//   · page_edit 参数形状 + draw/items/type 归一化：5 次调用全撞在字段名上；
//   · page_inspect +detail（反过来把默认返回砍掉 8.8 KB/次）。
// 再加东西之前先想清楚能不能等价地砍掉旧说明；预算只许因为「少一次真实调用」而涨。
// 2026-11-24 第五次调整（**改成单一预算**）：
// 工具面不再随模式收口。原来按模式 disable 工具并发 tools/list_changed，切一次模式
// 系统提示里那段 SDK 声明就变一次 —— ① 前缀变了，整段缓存从顶到底作废；
// ② 已经在写的程序里 tools.mcp__eplan__workspace 半路变成 unknown tool
// （session-400917a2 白烧 1.5 分钟 + 一轮返工）。
// 所以现在五个模式看到的是同一份 12 个工具，预算也只剩一个数。
// 加东西之前先想清楚能不能等价地砍掉旧说明；预算只许因为「少一次真实调用」而涨。
const BUDGET = { any: 22500 }

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] })
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
  return new Promise((resolveCall) => {
    pending.set(id, resolveCall)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

await rpc('initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'tool-face', version: '1' },
})
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

console.log('模式     字符数   预算   余量  工具')
let over = 0
const seen = new Set()
for (const mode of ['page', 'edit', 'check', 'lib', 'all']) {
  await rpc('tools/call', { name: 'workspace', arguments: { action: 'focus', mode } })
  const listed = await rpc('tools/list', {})
  const tools = listed.result?.tools ?? []
  const chars = tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0)
  const budget = BUDGET.any
  const slack = budget - chars
  if (slack < 0) over += 1
  seen.add(tools.map((tool) => tool.name).join(','))
  console.log(
    `${mode.padEnd(6)} ${String(chars).padStart(7)} ${String(budget).padStart(6)} ${String(slack).padStart(6)}  ${tools
      .map((tool) => tool.name)
      .join(',')}`,
  )
}
// 模式之间必须一字不差：任何差异都会让系统提示前缀变化、缓存作废。
if (seen.size !== 1) {
  console.log(`\n✗ 五个模式的工具面不一致：${seen.size} 种`)
  over += 1
} else {
  console.log(`\n✓ 五个模式工具面一致（${[...seen][0].split(',').length} 个工具）`)
}

await rpc('tools/call', { name: 'workspace', arguments: { action: 'focus', mode: detailMode } })
const listed = await rpc('tools/list', {})
const tools = listed.result?.tools ?? []
console.log(`\n${detailMode} 模式逐工具：`)
for (const tool of [...tools].sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)) {
  console.log(`  ${String(JSON.stringify(tool).length).padStart(6)}  ${tool.name}`)
}

child.stdin.end()
child.kill()
process.exit(over === 0 ? 0 : 1)
