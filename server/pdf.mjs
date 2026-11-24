// PDF 读取：把手册变成模型能用的文字和坐标。
//
// 为什么需要它：DSH 内置的文档解析器不支持 xref-stream / object-stream 的 PDF
// （现代 PDF 1.5+ 基本都是这种），而电气手册恰好都是。没有这个模块，
// 模型连「手册里有哪些图、端子怎么定义」都不知道，只能靠猜。
//
// 用 pdfjs-dist 的 legacy 构建：纯 JS，不需要 canvas，不需要原生编译。
// 迁移到新机器时只要能 npm install 就行，不会卡在编译工具链上。
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

let pdfjsPromise = null

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((mod) => {
      // 关掉 eval 和字体渲染：我们只要文字，不要安全风险和 canvas 依赖。
      return mod
    })
  }
  return pdfjsPromise
}

async function openDocument(path) {
  if (!existsSync(path)) {
    const error = new Error(`找不到文件：${path}`)
    error.code = 'PDF_NOT_FOUND'
    throw error
  }

  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(await readFile(path))

  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    // 空密码能打开「仅限制编辑」的 PDF；真正加密的会走 catch 分支。
    password: '',
    verbosity: 0,
  })

  try {
    return { doc: await task.promise, pdfjs }
  } catch (error) {
    const wrapped = new Error(
      `这个 PDF 打不开：${error.message}。` +
        '如果它加了密码，请先另存一份去掉密码的版本；如果是扫描件（整页是图片），' +
        '文字抽不出来，需要把相关页截图发给我。',
    )
    wrapped.code = 'PDF_UNREADABLE'
    throw wrapped
  }
}

/**
 * 把一页的文字项按行归并。
 *
 * PDF 里没有「行」的概念，只有一个个带坐标的文字块。电气手册的端子表和
 * 接线图说明全靠位置对齐，所以必须按 y 坐标分组成行，否则拼出来是乱的。
 */
function groupIntoLines(items, tolerance = 2.2) {
  const rows = []
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue
    const x = item.transform[4]
    const y = item.transform[5]
    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= tolerance)
    if (!row) {
      row = { y, cells: [] }
      rows.push(row)
    }
    row.cells.push({ x, text: item.str })
  }

  rows.sort((a, b) => b.y - a.y)
  return rows.map((row) => {
    row.cells.sort((a, b) => a.x - b.x)
    return {
      y: Math.round(row.y * 10) / 10,
      // 用多个空格保留横向间隔，读起来更接近原表。
      text: row.cells
        .map((cell, index) => (index === 0 ? cell.text : ' '.repeat(Math.max(1, Math.round((cell.x - row.cells[index - 1].x) / 2.2))) + cell.text))
        .join('')
        .replace(/\s+$/, ''),
      cells: row.cells.map((cell) => ({ x: Math.round(cell.x * 10) / 10, text: cell.text })),
    }
  })
}

function describeError(error) {
  const item = { code: error.code ?? 'PDF_ERROR', message: error.message }
  return item
}

/** 手册结构：多少页、每页有多少字、有没有目录。用来决定「画哪些页」。 */
export async function pdfOutline(path) {
  const { doc } = await openDocument(path)

  const meta = await doc.getMetadata().catch(() => null)
  const info = meta?.info ?? {}

  const pages = []
  const total = doc.numPages
  for (let index = 1; index <= total; index += 1) {
    const page = await doc.getPage(index)
    const viewport = page.getViewport({ scale: 1 })
    const text = await page.getTextContent()
    const chars = text.items.reduce((sum, item) => sum + (item.str ? item.str.length : 0), 0)
    pages.push({
      page: index,
      chars,
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
      // 字数太少通常意味着这是扫描页或整页图，只能靠截图。
      looksScanned: chars < 40,
    })
  }

  const outline = await doc.getOutline().catch(() => null)

  return {
    path,
    numPages: total,
    info: {
      title: info.Title ?? null,
      author: info.Author ?? null,
      creator: info.Creator ?? null,
    },
    scannedPages: pages.filter((page) => page.looksScanned).map((page) => page.page),
    outline: outline
      ? outline.slice(0, 80).map((item) => ({ title: item.title, page: null }))
      : null,
    pages,
  }
}

/** 按页取文字。layout=true 时按坐标分行，适合读端子表；false 时纯文本。 */
export async function pdfText(path, options = {}) {
  const { doc } = await openDocument(path)
  const from = Math.max(1, options.from ?? 1)
  const to = Math.min(doc.numPages, options.to ?? from)
  const layout = options.layout !== false

  const out = []
  for (let index = from; index <= to; index += 1) {
    const page = await doc.getPage(index)
    const content = await page.getTextContent()
    const lines = groupIntoLines(content.items)
    out.push({
      page: index,
      text: layout ? lines.map((line) => line.text).join('\n') : content.items.map((item) => item.str).join(' '),
      lines: layout ? lines.length : undefined,
    })
  }

  return { path, from, to, numPages: doc.numPages, pages: out }
}

/** 在一份或几份 PDF 里搜关键词，返回命中页。找「端子」「接线」「主回路」用这个。 */
export async function pdfSearch(path, queries) {
  const { doc } = await openDocument(path)
  const terms = (queries ?? []).filter((q) => q && q.length > 0)
  if (terms.length === 0) {
    const error = new Error('至少给一个要搜的词（queries）。')
    error.code = 'BAD_ARGUMENT'
    throw error
  }

  const hits = []
  for (let index = 1; index <= doc.numPages; index += 1) {
    const page = await doc.getPage(index)
    const content = await page.getTextContent()
    const text = content.items.map((item) => item.str).join('')
    const matched = terms.filter((term) => text.indexOf(term) >= 0)
    if (matched.length > 0) {
      hits.push({ page: index, matched, snippet: text.slice(0, 160) })
    }
  }

  return { path, queries: terms, numPages: doc.numPages, hits }
}

export { describeError }
