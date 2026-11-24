// 真机冒烟：直接走 stdio 调 server.mjs 的几个我改过的工具。
// 只读为主；visual 会建一张临时页再删掉（finally 保证删）。
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(resolve(here, '..'), 'server', 'server.mjs')
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
  setTimeout(() => reject(new Error(`${method} 超时`)), 180000)
})

const call = async (name, args) => {
  const result = await rpc('tools/call', { name, arguments: args })
  const text = (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const images = (result.content ?? []).filter((b) => b.type === 'image')
  return { text, images, isError: result.isError === true }
}

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })

const show = (label, value) => console.log(`\n=== ${label}\n${value}`)

// 1) status：ready 时不该带 blocked / nextSteps
const status = await call('workspace', { action: 'status' })
const st = JSON.parse(status.text)
show('status', JSON.stringify({ ready: st.ready, blocked: st.blocked ?? null, project: st.currentProject?.name ?? null, pages: st.currentProject?.pageCount ?? null, processes: st.eplanProcesses ?? null, nextSteps: st.nextSteps ? st.nextSteps.length : null }))

// 2) brief
const brief = await call('workspace', { action: 'brief' })
const br = JSON.parse(brief.text)
show('brief', JSON.stringify({ ready: br.ready, blocked: br.blocked ?? null, project: br.project, pages: (br.pages ?? []).slice(0, 6), hint: br.hint ? br.hint.slice(0, 40) : null }))

// 3) 中文概念搜索（不碰 EPLAN 也能回 concepts）
const cn = await call('symbol_catalog', { action: 'search', query: '空开' })
show('search 空开', cn.text.slice(0, 600))

// 4) 英文子串搜索
const en = await call('symbol_catalog', { action: 'search', filter: 'SON' })
const enj = JSON.parse(en.text)
show('search SON', JSON.stringify({ matched: enj.matchedCount, returned: enj.returned, names: (enj.symbols ?? []).map((s) => s.name).slice(0, 8) }))

// 5) page_inspect format=image：文字部分应该很小（不再有 functions 数组）
const page = (br.pages ?? [])[0]
const look = await call('page_inspect', { format: 'image', page, width: 1600 })
show('page_inspect image', `text=${look.text.length} chars, images=${look.images.length}\n${look.text.slice(0, 400)}`)

// 6) visual：一张样子表
const vis = await call('symbol_catalog', { action: 'visual', symbols: ['SON', 'SSA', 'KM2'], cols: 3, width: 1600 })
show('visual', `text=${vis.text.length} chars, images=${vis.images.length}\n${vis.text.slice(0, 500)}`)

// 7) visual 之后临时页应该已经删掉
const pagesAfter = await call('workspace', { action: 'list_pages' })
const pj = JSON.parse(pagesAfter.text)
const names = (pj.pages ?? pj.items ?? []).map((p) => p?.name ?? p)
show('list_pages after visual', JSON.stringify({ count: names.length, temp: names.filter((n) => String(n).startsWith('=TMP')) }))

// 8) launch：已经就绪时必须拒绝再开一个实例（多实例会抢项目锁）
const launched = await call('workspace', { action: 'launch' })
show('launch (already ready)', JSON.stringify(JSON.parse(launched.text)))

child.kill()
