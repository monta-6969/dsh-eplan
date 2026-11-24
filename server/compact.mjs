// 载荷收敛层：把桥接器返回的原始 JSON 压成「模型真正需要的那一层」。
//
// 为什么需要这一层：桥接器的 inspect 返回带缩进的 2 空格 JSON，一页 107 个对象
// 实测 80,924 字符，其中**缩进和空字段占了一半以上**（紧凑序列化只有 32,927）。
// 模型拿到的每一步都要为这些字节付一次上下文，而真正要做的判断（有没有重叠、
// 引脚接没接上、超没超图框）反而要它自己在脑子里算。
//
// 这里只做三件事，不改任何 EPLAN 行为：
//   1) compact：去掉缩进与空串噪声；
//   2) view：summary / list / full 三档，默认只给结论；
//   3) geometry：把「重叠 / 共点 / 压字 / 偏栅格 / 超框」算好直接给问题清单。
import { createHash } from 'node:crypto'

/** 桥接器的文本块可能是 JSON，也可能不是（比如渲染信息）。解析失败返回 null。 */
export function parseJsonText(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/** 稳定短摘要，用来判断「和上次一模一样」，也用来做内容哈希。 */
export function digest(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return createHash('sha1').update(text ?? '').digest('hex').slice(0, 12)
}

/**
 * 重复调用记忆：同参数再问一次时，只回「没变」而不是把整包重发一遍。
 *
 * 实测 42 分钟里 341 KB（占全部内层载荷 31%）是字节级重复 —— 5 次相同的
 * symbol_catalog 42,516 B、6 次相同的 10,644 B。模型之所以重问，是因为它
 * 不确定拿到的还是不是同一份；明确回一句 unchanged 比省字节更重要。
 */
export class RepeatMemo {
  constructor(limit = 64) {
    this.limit = limit
    this.map = new Map()
  }

  /**
   * @returns {{repeat: boolean, digest: string}}
   */
  check(key, payload) {
    const stamp = digest(payload)
    const previous = this.map.get(key)
    this.map.delete(key)
    this.map.set(key, stamp)
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
    return { repeat: previous === stamp, digest: stamp }
  }

  clear() {
    this.map.clear()
  }
}

const round = (value) => Math.round(value * 1000) / 1000

const pointOf = (value) =>
  Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])
    ? [Number(value[0]), Number(value[1])]
    : null

/**
 * 一个对象的世界坐标点。
 *
 * 分两种包络，因为它们的含义完全相反：
 *   - 「引脚包络」= 元件本体，重叠一定是错的；
 *   - 「完整包络」还含属性放置点（设备标识那片文字），相邻元件之间重叠是常态，
 *     只有本体不重叠而文字区域重叠时才值得提醒一句（标签会压字）。
 */
function pointsOf(item, options = {}) {
  const withProps = options.withProps !== false
  const origin = pointOf(item?.location)
  if (!origin) return []
  const points = [origin]
  for (const pin of item.pins ?? []) {
    const offset = pointOf(pin?.location)
    if (offset) points.push([origin[0] + offset[0], origin[1] + offset[1]])
  }
  if (withProps) {
    for (const prop of item.propertyPlacements ?? []) {
      const offset = pointOf(prop?.at)
      if (offset) points.push([origin[0] + offset[0], origin[1] + offset[1]])
    }
  }
  return points
}

const footprintOf = (item) => pointsOf(item)
const pinPointsOf = (item) => pointsOf(item, { withProps: false })

function bboxOf(points) {
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

/** 页面上所有对象按类型计数 + 世界坐标范围。 */
function censusOf(raw) {
  const placements = Array.isArray(raw?.placements) ? raw.placements : []
  const byType = {}
  const bySymbol = {}
  const deviceTags = []
  const seenTags = new Set()
  let pinTotal = 0
  const pins = []

  const points = []
  for (const item of placements) {
    const type = item?.type ?? 'Unknown'
    byType[type] = (byType[type] ?? 0) + 1

    if (type === 'Function' || type === 'InterruptionPoint') {
      const symbol = item.symbolName ?? '(匿名)'
      bySymbol[symbol] = (bySymbol[symbol] ?? 0) + 1

      const origin = pointOf(item.location)
      const itemPins = Array.isArray(item.pins) ? item.pins : []
      pinTotal += itemPins.length
      for (const pin of itemPins) {
        const offset = pointOf(pin?.location)
        if (!origin || !offset) continue
        pins.push({
          x: round(origin[0] + offset[0]),
          y: round(origin[1] + offset[1]),
          direction: pin?.direction ?? '?',
          index: pin?.index ?? -1,
          symbol,
          objectId: item.objectId ?? null,
        })
      }
      for (const point of footprintOf(item)) points.push(point)
    } else {
      const origin = pointOf(item.location)
      if (origin) points.push(origin)
    }
  }

  for (const fn of raw?.functions ?? []) {
    const name = typeof fn?.name === 'string' ? fn.name : null
    if (name && !seenTags.has(name)) {
      seenTags.add(name)
      deviceTags.push(name)
    }
  }

  const box = bboxOf(points)
  const bounds = box
    ? {
        min: [round(box.minX), round(box.minY)],
        max: [round(box.maxX), round(box.maxY)],
        width: round(box.maxX - box.minX),
        height: round(box.maxY - box.minY),
      }
    : null

  return { placements, byType, bySymbol, deviceTags, pinTotal, pins, bounds }
}

/**
 * 几何门禁：把模型以前只能靠看渲染图发现的问题算出来。
 *
 * 只做能从 inspect 数据确定的判断，不确定的一律不报 —— 假阳性比漏报更贵，
 * 因为模型会照着它去「修」一个本来正确的地方。
 *
 * @returns {Array<{kind: string, where: string, detail: string, fix: string}>}
 */
export function geometryProblems(raw, options = {}) {
  const grid = Number.isFinite(options.grid) ? options.grid : 4
  const pageSize = Array.isArray(options.pageSize) ? options.pageSize : null
  const { placements, pins } = censusOf(raw)
  const problems = []

  // 1) 同一个符号摆了两遍（同 symbol+变体、位置几乎相同）
  const placed = new Map()
  for (const item of placements) {
    if (item?.type !== 'Function' && item?.type !== 'InterruptionPoint') continue
    const origin = pointOf(item.location)
    if (!origin) continue
    const key = `${item.symbolName ?? '?'}#${item.variant ?? 0}`
    const bucket = placed.get(key) ?? []
    for (const other of bucket) {
      if (Math.abs(other[0] - origin[0]) < 0.05 && Math.abs(other[1] - origin[1]) < 0.05) {
        problems.push({
          kind: 'duplicate_symbol',
          where: `${item.symbolName} @ (${round(origin[0])}, ${round(origin[1])})`,
          detail: '同一个符号变体在同一坐标被放了两次，叠在一起看不出来，但连接点会重复。',
          fix: '删掉其中一个，或确认后把 at 改到别的坐标。',
        })
      }
    }
    bucket.push(origin)
    placed.set(key, bucket)
  }

  // 2) 共用连接点：两个不同符号的引脚落在同一坐标 —— EPLAN 会报「共用连接点」
  const pinAt = new Map()
  for (const pin of pins) {
    const key = `${pin.x},${pin.y}`
    const bucket = pinAt.get(key) ?? []
    bucket.push(pin)
    pinAt.set(key, bucket)
  }
  const reportedPin = new Set()
  for (const [key, bucket] of pinAt) {
    if (bucket.length < 2) continue
    const symbols = new Set(bucket.map((pin) => pin.symbol))
    if (symbols.size < 2) continue
    if (reportedPin.has(key)) continue
    reportedPin.add(key)
    const [x, y] = key.split(',')
    problems.push({
      kind: 'shared_pin_point',
      where: `(${x}, ${y})`,
      detail: `${[...symbols].join(' / ')} 的引脚落在同一点，EPLAN 视为一个节点；若本意是跨线不连，这里会静默连通。`,
      fix: '确认该点是否应该相连；不该连就把其中一个符号挪开至少一个栅格。',
    })
  }

  // 3) 本体压本体 / 只有文字区压
  const funcs = placements
    .filter((item) => item?.type === 'Function')
    .map((item) => ({ item, pins: bboxOf(pinPointsOf(item)), box: bboxOf(footprintOf(item)) }))
    .filter((entry) => entry.box !== null)

  const overlapOf = (a, b, tolerance = 0.5) => {
    if (!a || !b) return null
    const width = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)
    const height = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY)
    return width > tolerance && height > tolerance ? { width, height } : null
  }

  for (let i = 0; i < funcs.length; i += 1) {
    for (let j = i + 1; j < funcs.length; j += 1) {
      const body = overlapOf(funcs[i].pins, funcs[j].pins)
      if (body) {
        problems.push({
          kind: 'symbol_overlap',
          where: `${funcs[i].item.symbolName} ∩ ${funcs[j].item.symbolName}`,
          detail: `两个元件的本体（引脚包络）重叠 ${round(body.width)}×${round(body.height)} mm。`,
          fix: '把其中一个按栅格挪开，或改用更小的变体。',
        })
        continue
      }
      const label = overlapOf(funcs[i].box, funcs[j].box, 1)
      if (label) {
        problems.push({
          kind: 'label_overlap',
          where: `${funcs[i].item.symbolName} ∩ ${funcs[j].item.symbolName}`,
          detail:
            `本体没重叠，但设备标识那片文字区重叠 ${round(label.width)}×${round(label.height)} mm，渲染时标签会互相压字。`,
          fix: '把其中一个的设备标识挪到另一侧，或改用更短的标识；不算错误，只影响可读性。',
        })
      }
    }
  }

  // 4) 文字压在元件本体里（只看引脚包络 —— 标签区本来就是留给文字的）
  for (const item of placements) {
    if (item?.type !== 'Text') continue
    const origin = pointOf(item.location)
    if (!origin) continue
    for (const entry of funcs) {
      const box = entry.pins
      if (!box) continue
      if (
        origin[0] > box.minX + 1 &&
        origin[0] < box.maxX - 1 &&
        origin[1] > box.minY + 1 &&
        origin[1] < box.maxY - 1
      ) {
        problems.push({
          kind: 'text_on_symbol',
          where: `${entry.item.symbolName} @ (${round(origin[0])}, ${round(origin[1])})`,
          detail: '文字落在元件本体内部，渲染时会压住符号或引脚代号。',
          fix: '把文字挪到元件外侧，或改用元件自带的属性放置。',
        })
        break
      }
    }
  }

  // 5) 元件偏离栅格（文字和属性放置点不算：它们的坐标本来就带小数）
  if (grid > 0) {
    const offenders = []
    for (const item of placements) {
      if (item?.type !== 'Function' && item?.type !== 'InterruptionPoint') continue
      const origin = pointOf(item.location)
      if (!origin) continue
      const dx = Math.abs(origin[0] / grid - Math.round(origin[0] / grid)) * grid
      const dy = Math.abs(origin[1] / grid - Math.round(origin[1] / grid)) * grid
      if (dx > 0.05 || dy > 0.05) {
        offenders.push(`${item.type}@(${round(origin[0])},${round(origin[1])})`)
      }
    }
    if (offenders.length > 0) {
      problems.push({
        kind: 'off_grid',
        where: offenders.slice(0, 6).join(' '),
        detail: `${offenders.length} 个元件不在 ${grid} mm 栅格上。`,
        fix: '用 page_edit 的 relocate 对齐到栅格，或在 page_create 里传 layout 让坐标自动吸附。',
      })
    }
  }

  // 6) 超出图框
  if (pageSize && pageSize.length >= 2) {
    const [width, height] = pageSize
    const outside = placements.filter((item) => {
      const origin = pointOf(item.location)
      if (!origin) return false
      return origin[0] < 0 || origin[1] < 0 || origin[0] > width || origin[1] > height
    })
    if (outside.length > 0) {
      problems.push({
        kind: 'out_of_frame',
        where: outside.slice(0, 6).map((item) => `${item.type}(${round(item.location[0])},${round(item.location[1])})`).join(' '),
        detail: `${outside.length} 个对象落在 ${width}×${height} 的图框外，打印时会丢。`,
        fix: '挪回图框内；整页都偏就整页平移。',
      })
    }
  }

  return problems
}

/** summary：只回答「这页有什么、齐不齐、有没有毛病」，通常 1–3 KB。 */
function inspectSummary(raw, problems) {
  const { byType, bySymbol, deviceTags, pinTotal, bounds } = censusOf(raw)
  const topSymbols = Object.entries(bySymbol)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)

  return {
    page: raw?.page ?? null,
    pageType: raw?.pageType ?? null,
    totals: {
      placements: Array.isArray(raw?.placements) ? raw.placements.length : 0,
      functions: Number.isFinite(raw?.functionTotal) ? raw.functionTotal : (raw?.functions ?? []).length,
      pins: pinTotal,
      ...byType,
    },
    deviceTags: deviceTags.slice(0, 40),
    deviceTagCount: deviceTags.length,
    topSymbols: Object.fromEntries(topSymbols),
    bounds,
    problems,
    hint:
      '要看每个对象的坐标和引脚用 view="list"；要全量原始结构用 view="full"。' +
      (problems.length > 0 ? 'problems 里每一项都有 fix，照它改就行。' : ''),
  }
}

/** list：一行一个对象，坐标保留 2 位小数，比全量小一个数量级。 */
function inspectList(raw, options) {
  const only = Array.isArray(options.only) && options.only.length > 0 ? new Set(options.only) : null
  const limit = Number.isFinite(options.limit) ? options.limit : 200
  const placements = Array.isArray(raw?.placements) ? raw.placements : []
  const rows = []
  let skipped = 0

  for (const item of placements) {
    const type = item?.type ?? 'Unknown'
    if (only && !only.has(type)) {
      skipped += 1
      continue
    }
    const origin = pointOf(item.location)
    const row = {
      t: type.slice(0, 4),
      x: origin ? round(origin[0]) : null,
      y: origin ? round(origin[1]) : null,
    }
    if (item.symbolName) row.sym = item.symbolName
    if (Number.isFinite(item.variant) && item.variant !== 0) row.v = item.variant
    if (Array.isArray(item.pins) && item.pins.length > 0) row.pins = item.pins.length
    if (item.objectId !== undefined) row.id = String(item.objectId)
    rows.push(row)
    if (rows.length >= limit) break
  }

  return {
    page: raw?.page ?? null,
    count: rows.length,
    ...(only ? { filter: [...only] } : {}),
    ...(rows.length < placements.length - skipped ? { truncated: true, total: placements.length } : {}),
    rows,
  }
}

/** full：原始结构，只做「去空噪声 + 紧凑」两件事。 */
function inspectFull(raw, options) {
  const only = Array.isArray(options.only) && options.only.length > 0 ? new Set(options.only) : null
  const limit = Number.isFinite(options.limit) ? options.limit : null
  const placements = Array.isArray(raw?.placements) ? raw.placements : []

  const cleaned = []
  for (const item of placements) {
    if (only && !only.has(item?.type)) continue
    const copy = { ...item }
    if (Array.isArray(copy.propertyPlacements)) {
      // text/contents 为空、height 是 EPLAN 的占位值时，整条没有信息量。
      const kept = copy.propertyPlacements.filter((prop) => {
        const text = typeof prop?.text === 'string' ? prop.text.trim() : ''
        const contents = typeof prop?.contents === 'string' ? prop.contents.trim() : ''
        return text.length > 0 || contents.length > 0
      })
      if (kept.length > 0) copy.propertyPlacements = kept
      else delete copy.propertyPlacements
    }
    cleaned.push(copy)
    if (limit !== null && cleaned.length >= limit) break
  }

  return {
    page: raw?.page ?? null,
    pageType: raw?.pageType ?? null,
    placementTotal: Number.isFinite(raw?.placementTotal) ? raw.placementTotal : placements.length,
    placements: cleaned,
    ...(Array.isArray(raw?.functions) ? { functions: raw.functions } : {}),
    ...(raw?.connections === undefined ? {} : { connections: raw.connections }),
    ...(cleaned.length < placements.length ? { truncated: true, note: `只返回前 ${cleaned.length} 个对象` } : {}),
  }
}

/**
 * page_inspect 的收敛入口。
 * @param {object} raw 桥接器原始 JSON
 * @param {{view?: string, only?: string[], limit?: number}} options
 */
export function compactInspect(raw, options = {}) {
  if (raw === null || typeof raw !== 'object') return raw
  const view = options.view ?? 'summary'
  const problems = view === 'full' ? null : geometryProblems(raw, { pageSize: options.pageSize })
  if (view === 'list') return { ...inspectList(raw, options), problems: problems ?? [] }
  if (view === 'full') return inspectFull(raw, options)
  return inspectSummary(raw, problems ?? [])
}
