// 工具参数收口的离线测试：page_edit 同义词归一化 + 文本里 @ 到的视频路径识别。
//
// 这两段都是「模型写错一次、我们少一轮」的纯函数，不碰 EPLAN、不碰 ffmpeg。
//   node test/arg-shape.mjs
import { normalizeEditArgs } from '../server/edit-args.mjs'
import { videoPathsInText } from '../preset/video-digest.js'

let pass = 0
let fail = 0
// JSON.stringify 的键顺序取决于赋值顺序，而这里关心的是「归一化后的等价性」，
// 所以比较前按键排序，避免因为键的顺序把正确结果判成失败。
const stable = (value) => JSON.stringify(value, (key, val) => (
  val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
    : val
))
const eq = (label, actual, expected) => {
  const a = stable(actual)
  const b = stable(expected)
  if (a === b) {
    pass += 1
    console.log(`✓ ${label}`)
  } else {
    fail += 1
    console.log(`✗ ${label}\n  实际: ${a}\n  期望: ${b}`)
  }
}

// ---- page_edit 归一化 ----
eq(
  'draw_graphics: items + type 收成 draw + kind',
  normalizeEditArgs({ action: 'draw_graphics', page: '=A/1', items: [{ type: 'rect', from: [1, 2], to: [3, 4] }] }).draw,
  [{ kind: 'rect', from: [1, 2], to: [3, 4] }],
)
eq(
  'draw_graphics: rects 也收',
  normalizeEditArgs({ action: 'draw_graphics', page: '=A/1', rects: [{ from: [1, 2], to: [3, 4] }] }).draw,
  [{ kind: 'rect', from: [1, 2], to: [3, 4] }],
)
eq(
  'draw_graphics: kind=rect + at/to 时把 at 当 from',
  normalizeEditArgs({ action: 'draw_graphics', page: '=A/1', draw: [{ kind: 'rect', at: [152, 110], to: [196, 204] }] }).draw,
  [{ kind: 'rect', from: [152, 110], to: [196, 204] }],
)
eq(
  'draw_graphics: 只给 text 也能推成 kind=text',
  normalizeEditArgs({ action: 'draw_graphics', page: '=A/1', draw: [{ at: [1, 1], text: '说明' }] }).draw,
  [{ kind: 'text', at: [1, 1], text: '说明' }],
)
eq(
  'relocate: to:[x,y] 当坐标',
  (({ at }) => at)(normalizeEditArgs({ action: 'relocate', page: '=A/1', select: { objectId: '9' }, to: [110, 275] })),
  [110, 275],
)
eq(
  'relocate: position 也当坐标',
  (({ at }) => at)(normalizeEditArgs({ action: 'relocate', page: '=A/1', select: { objectId: '9' }, position: [1, 2] })),
  [1, 2],
)
eq(
  'relocate: 已经有 at 就不动',
  (({ at }) => at)(normalizeEditArgs({ action: 'relocate', at: [5, 5], to: [9, 9] })),
  [5, 5],
)
eq(
  'relabel: to 是字符串时不当坐标',
  (({ to }) => to)(normalizeEditArgs({ action: 'relabel', page: '=A/1', select: { deviceTag: '-K1' }, to: '-K2' })),
  '-K2',
)
eq(
  'relabel: newTag 收成 to',
  (({ to }) => to)(normalizeEditArgs({ action: 'relabel', page: '=A/1', select: { deviceTag: '-K1' }, newTag: '-K2' })),
  '-K2',
)
eq(
  'relabel: 顶层 deviceTag 不当新名字（它是选择条件）',
  (({ to }) => to)(normalizeEditArgs({ action: 'relabel', page: '=A/1', deviceTag: '-K1' })),
  undefined,
)
eq(
  '别的 action 原样不动',
  normalizeEditArgs({ action: 'insert_symbol', page: '=A/1', insert: { symbol: 'FA3', at: [1, 2] } }),
  { action: 'insert_symbol', page: '=A/1', insert: { symbol: 'FA3', at: [1, 2] } },
)

// ---- 文本里的视频路径 ----
const p1 = 'C:\\Users\\mota\\Desktop\\eplan\\f1c8c603_raw.mp4'
eq('@ 绝对路径能认出来', videoPathsInText(`@${p1} 帮我照着画`), [p1])
eq(
  '正斜杠也认',
  videoPathsInText('看 C:/tmp/a/clip.mkv 这个'),
  ['C:/tmp/a/clip.mkv'],
)
eq('中文路径能认', videoPathsInText('@D:\\录像\\2026 课程\\第一讲.mp4'), ['D:\\录像\\2026 课程\\第一讲.mp4'])
eq('句末标点不算路径的一部分', videoPathsInText('先看 C:\\v\\a.mp4，再画'), ['C:\\v\\a.mp4'])
eq('非视频后缀不认', videoPathsInText('@C:\\tmp\\notes.txt'), [])
eq('没有路径返回空', videoPathsInText('继续'), [])

console.log(`\n全部通过：${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
