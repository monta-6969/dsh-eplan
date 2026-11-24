/**
 * page_edit 的参数归一化。
 *
 * 为什么单独成文件：这一段全是「同义词收口」，纯函数，值得单独测。
 *
 * 为什么需要它：2026-11-23 session-a18a4a7f 里，模型为了画一个矩形连撞两次
 * （先 items+type，再 rects + at/to），为了挪一个文字再撞两次（to:[x,y] → at:[x,y]），
 * 5 次调用全花在字段名上，一次也没画成。与其让它在错误信息里猜，不如把常见写法都收下来。
 *
 * 边界：只做同义词映射，不猜意图 —— 看不懂的字段原样留着，交给 schema 校验报错。
 */

/** 图元类型：给了 type / 只给 text / 只给 points 也能推出 kind。 */
function kindOf(item) {
  if (item.kind) return item.kind
  if (item.type) return item.type
  if (item.text !== undefined) return 'text'
  if (Array.isArray(item.points)) return 'polyline'
  if (item.from && item.to) return 'rect'
  return undefined
}

export function normalizeEditArgs(input) {
  const args = { ...input }

  // draw_graphics：draw / items / rects / graphics 都收；矩形给了 at 没给 from 时把 at 当 from。
  const rawItems = args.draw ?? args.items ?? args.rects ?? args.graphics
  if (Array.isArray(rawItems)) {
    args.draw = rawItems.map((item) => {
      if (!item || typeof item !== 'object') return item
      const next = { ...item }
      const kind = kindOf(next)
      if (kind) next.kind = kind
      if (next.kind === 'rect' && !next.from && Array.isArray(next.at)) {
        next.from = next.at
        delete next.at
      }
      delete next.type
      return next
    })
  }

  if (args.action === 'relocate') {
    // relocate 的目标坐标常被写成 to / position / pos / xy —— 和 relabel 的 to（新标识）
    // 撞名，所以只在 relocate 且值数组时才当坐标。
    for (const field of ['to', 'position', 'pos', 'xy', 'target']) {
      if (!args.at && Array.isArray(args[field])) {
        args.at = args[field]
        if (field === 'to') delete args.to
      }
    }
    if (!args.at && Array.isArray(args.relocate?.to)) args.at = args.relocate.to
    if (!args.at && Array.isArray(args.relocate?.at)) args.at = args.relocate.at
    if (!args.offset && Array.isArray(args.relocate?.offset)) args.offset = args.relocate.offset
  }

  if (args.action === 'relabel') {
    // 新标识也可能写成 newTag / newDeviceTag / tag；deviceTag 在 relabel 里是「选谁」，
    // 不能当新名字用。
    if (typeof args.to !== 'string') {
      const candidate = args.newTag ?? args.newDeviceTag ?? args.tag
      if (typeof candidate === 'string') args.to = candidate
    }
  }

  return args
}
