// 生成「符号图鉴」：把常用符号在 EPLAN 里真画一遍，逐张导出成小图。
//
// 为什么要有：模型查元器件时看不到它长什么样，只能靠名字猜；用户要求「常用的几个图
// 在初始阶段就给出样子」。这里用 EPLAN 自己渲染，保证和真实库一致。
//
// 做法：建一张临时页 → 按网格插常用符号 → 渲染整页 → 按毫米坐标裁成单张 → 存进
// knowledge/symbols/。之后 focus / symbol_catalog(pins) 直接发这些图，不再麻烦 EPLAN。
//
//   node native/script/build-symbol-gallery.mjs [--keep-page]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const OUT_DIR = join(root, 'knowledge', 'symbols')
const PAGE = '=JQR2623/900'
const keepPage = process.argv.includes('--keep-page')

// 常用符号：名字 / 库 / 变体 / 裁切框（[宽, 高, 左边界占比]，毫米，相对插入点）
// 左边界占比是必要的：三极开关从插入点往右长 16 mm，居中对齐会把第三极切掉。
const SYMBOLS = [
  { key: 'BP', library: 'SPECIAL', variant: 0, box: [30, 24, 0.5] },
  { key: 'CO', library: 'SPECIAL', variant: 0, box: [24, 24, 0.5] },
  { key: 'TLRU', library: 'SPECIAL', variant: 0, box: [30, 24, 0.5] },
  { key: 'TOUR', library: 'SPECIAL', variant: 0, box: [30, 24, 0.5] },
  { key: 'TLRO', library: 'SPECIAL', variant: 0, box: [30, 24, 0.5] },
  { key: 'TOUL', library: 'SPECIAL', variant: 0, box: [30, 24, 0.5] },
  { key: 'CDPST', library: 'SPECIAL', variant: 0, box: [24, 28, 0.5] },
  { key: 'FA3', library: 'GB_symbol', variant: 0, box: [30, 20, 0.2] },
]

const COLS = 4
const PITCH_X = 70
const PITCH_Y = 80
const ORIGIN = [70, 230]

// ── MCP 客户端 ────────────────────────────────────────────────────────────
const child = spawn(process.execPath, ['server/server.mjs'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
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
    try { message = JSON.parse(line) } catch { continue }
    const resolve = pending.get(message.id)
    if (resolve) { pending.delete(message.id); resolve(message) }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`))

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 180000)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

async function call(tool, args) {
  const reply = await request('tools/call', { name: tool, arguments: args })
  const result = reply.result ?? {}
  const text = (result.content ?? []).find((block) => block.type === 'text')?.text ?? ''
  return { isError: result.isError === true, text, result }
}

/** 从工具返回里挖出第一个 JSON 对象（服务端通常会带一段说明文字）。 */
function jsonOf(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    if (text[index] === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, index + 1)) } catch { return null }
      }
    }
  }
  return null
}

// ── 主流程 ────────────────────────────────────────────────────────────────
try {
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'gallery', version: '0' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  const status = await call('workspace', { action: 'status' })
  const statusJson = jsonOf(status.text)
  console.log('项目:', statusJson?.currentProject?.name ?? statusJson?.project ?? '(未知)', '当前页:', statusJson?.visiblePage ?? '?')

  // 已存在的临时页先删掉，避免重复插入。
  const del = await call('page_delete', { page: PAGE, force: true })
  if (!del.isError) console.log('清理旧的图鉴页')

  const created = await call('page_create', { name: PAGE })
  console.log('建页:', created.isError ? `失败 ${created.text.slice(0, 200)}` : 'ok')
  if (created.isError) throw new Error(created.text.slice(0, 300))

  const placed = []
  for (let index = 0; index < SYMBOLS.length; index += 1) {
    const symbol = SYMBOLS[index]
    const column = index % COLS
    const row = Math.floor(index / COLS)
    const at = [ORIGIN[0] + column * PITCH_X, ORIGIN[1] - row * PITCH_Y]
    const inserted = await call('page_edit', {
      action: 'insert_symbol',
      page: PAGE,
      insert: { symbol: symbol.key, library: symbol.library, variant: symbol.variant, at },
    })
    if (inserted.isError) {
      console.log(`✗ ${symbol.key}: ${inserted.text.slice(0, 160)}`)
      continue
    }
    placed.push({ ...symbol, at })
    console.log(`✓ ${symbol.key} @ ${at.join(',')} mm`)
  }
  if (placed.length === 0) throw new Error('一个符号都没插进去，先看上面的错误')

  const shot = await call('page_inspect', { format: 'image', page: PAGE, width: 4200 })
  const shotJson = jsonOf(shot.text)
  const imagePath = shotJson?.imagePath ?? shotJson?.image?.path
  console.log('渲染:', imagePath ?? shot.text.slice(0, 200))
  if (!imagePath || !existsSync(imagePath)) throw new Error('没拿到渲染图路径')

  mkdirSync(OUT_DIR, { recursive: true })
  const { execFile } = await import('node:child_process')
  const run = (command, args) => new Promise((resolve) => execFile(command, args, { maxBuffer: 1 << 26 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })))

  // 页尺寸从渲染图反推：整页渲染时宽度对应纸宽毫米。
  const pageJson = jsonOf((await call('page_inspect', { format: 'structure', page: PAGE, view: 'summary' })).text)
  const paper = pageJson?.page?.size ?? pageJson?.size ?? [420, 297]
  const png = readFileSync(imagePath)
  const pngWidth = png.readUInt32BE(16)
  const pngHeight = png.readUInt32BE(20)
  const pxPerMm = pngWidth / paper[0]
  console.log(`渲染图 ${pngWidth}x${pngHeight}px，纸 ${paper[0]}x${paper[1]}mm，${pxPerMm.toFixed(2)} px/mm`)

  const manifest = []
  for (const symbol of placed) {
    const [boxW, boxH, leftRatio] = symbol.box
    // 先切一个宽松的窗口，让 cropdetect 去掉黑边再收紧 —— 各种符号的原点偏移不一样，
    // 写死像素框会把箭头切到边上（第一版就这样）。
    const leftMm = symbol.at[0] - boxW * leftRatio
    const bottomMm = symbol.at[1] - boxH * 0.5
    const x = Math.max(0, Math.round(leftMm * pxPerMm))
    const y = Math.max(0, Math.round((paper[1] - bottomMm - boxH) * pxPerMm))
    const w = Math.round(boxW * pxPerMm)
    const h = Math.round(boxH * pxPerMm)
    const raw = join(tmpdir(), `gallery-${symbol.key}.png`)
    const wide = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', imagePath, '-vf', `crop=${w}:${h}:${x}:${y}`, '-y', raw])
    if (wide.error || !existsSync(raw)) {
      console.log(`✗ 切 ${symbol.key}: ${wide.stderr?.slice(0, 160)}`)
      continue
    }

    // 去掉黑边：把这块导成灰度原始帧，自己在 Node 里找内容框。
    // （ffmpeg 的 cropdetect 在这种纯黑底单帧上什么都不打印，不可靠。）
    const gray = join(tmpdir(), `gallery-${symbol.key}.gray`)
    const dumped = await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', imagePath,
      '-vf', `crop=${w}:${h}:${x}:${y},format=gray`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-y', gray,
    ])
    let contentBox = null
    if (!dumped.error && existsSync(gray)) {
      const pixels = readFileSync(gray)
      let minX = w, minY = h, maxX = -1, maxY = -1
      for (let row = 0; row < h; row += 1) {
        for (let column = 0; column < w; column += 1) {
          if (pixels[row * w + column] > 40) {
            if (column < minX) minX = column
            if (column > maxX) maxX = column
            if (row < minY) minY = row
            if (row > maxY) maxY = row
          }
        }
      }
      if (maxX > minX && maxY > minY) {
        const pad = 8
        const cx = Math.max(0, minX - pad)
        const cy = Math.max(0, minY - pad)
        contentBox = {
          x: cx,
          y: cy,
          w: Math.min(w - cx, maxX - minX + 1 + pad * 2),
          h: Math.min(h - cy, maxY - minY + 1 + pad * 2),
        }
      }
    }

    const file = join(OUT_DIR, `${symbol.key}.png`)
    const filters = []
    if (contentBox) filters.push(`crop=${contentBox.w}:${contentBox.h}:${contentBox.x}:${contentBox.y}`)
    // 小符号最多放大 2 倍：再大就只是把 1~2 px 的线糊开，反而看不清。
    if (contentBox && contentBox.w < 200) filters.push('scale=iw*2:ih*2:flags=lanczos')
    const cropped = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', raw, '-vf', filters.join(','), '-y', file])
    if (cropped.error || !existsSync(file)) {
      console.log(`✗ 裁 ${symbol.key}: ${cropped.stderr?.slice(0, 160)}`)
      continue
    }
    manifest.push({ key: symbol.key, library: symbol.library, variant: symbol.variant, file: `${symbol.key}.png`, box: [boxW, boxH] })
    console.log(`✓ 出图 ${symbol.key}.png${contentBox ? ` (内容 ${contentBox.w}x${contentBox.h})` : ' (空图?)'}`)
  }

  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), page: PAGE, paper, pxPerMm, symbols: manifest }, null, 2), 'utf8')
  console.log(`完成：${manifest.length} 张图 → ${OUT_DIR}`)

  if (!keepPage) {
    const removed = await call('page_delete', { page: PAGE, force: true })
    console.log('清理临时页:', removed.isError ? `失败 ${removed.text.slice(0, 160)}` : 'ok')
  }
} catch (error) {
  console.error('失败：', error.message)
  process.exitCode = 1
} finally {
  child.stdin.end()
  child.kill()
}
