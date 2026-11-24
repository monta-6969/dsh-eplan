// page_edit 参数归一：同一个 `to` 在 relabel 里是字符串、在 box 里是坐标，
// 收口之后不许再因为「类型不符」白丢一个回合。
//   node test/page-edit-args.mjs
import { normalizeEditArgs } from '../server/edit-args.mjs'

let pass = 0
let fail = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}  ${detail}`)
  }
}

// relabel：to 是字符串，原样留着
const relabel = normalizeEditArgs({ action: 'relabel', page: '=A/1', select: { deviceTag: '-K1' }, to: '-K2' })
check('relabel 的字符串 to 不被当成坐标', relabel.to === '-K2' && relabel.at === undefined)

// relabel：老写法 newTag / tag 也收
const relabelAlt = normalizeEditArgs({ action: 'relabel', page: '=A/1', select: { deviceTag: '-K1' }, newTag: '-K3' })
check('relabel 收 newTag', relabelAlt.to === '-K3')

// relocate：to 写成坐标要落到 at
const relocate = normalizeEditArgs({ action: 'relocate', page: '=A/1', select: { objectId: 'x' }, to: [120, 240] })
check('relocate 的坐标 to 归到 at', JSON.stringify(relocate.at) === '[120,240]' && relocate.to === undefined)

// box：平铺 from/to 保持原样（清单一律按 action 分派，不做类型转换）
const box = normalizeEditArgs({ action: 'box', page: '=A/1', from: [24, 204], to: [164, 152], deviceTag: '-U1' })
check('box 的平铺 from/to 原样保留', JSON.stringify(box.from) === '[24,204]' && JSON.stringify(box.to) === '[164,152]')

// box：已经嵌在 box 里的不动
const nested = normalizeEditArgs({ action: 'box', page: '=A/1', box: { from: [0, 0], to: [40, 40] } })
check('嵌套 box 不被压平', nested.box && nested.box.from[0] === 0)

// draw_graphics：items + type → draw + kind；矩形写 at 当 from
const draw = normalizeEditArgs({
  action: 'draw_graphics',
  page: '=A/1',
  items: [{ type: 'rect', at: [10, 20], to: [40, 60] }, { text: '说明', at: [10, 80] }],
})
check('items 收成 draw', Array.isArray(draw.draw) && draw.draw.length === 2)
check('type 收成 kind', draw.draw[0].kind === 'rect' && draw.draw[0].type === undefined)
check('矩形的 at 当 from', JSON.stringify(draw.draw[0].from) === '[10,20]')
check('文字按内容推 kind', draw.draw[1].kind === 'text')

// 不认识的动作不许被悄悄改写
const other = normalizeEditArgs({ action: 'insert_symbol', page: '=A/1', to: [1, 2] })
check('其他动作不瞎改 to', JSON.stringify(other.to) === '[1,2]')

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass}/${pass + fail}`)
process.exitCode = fail === 0 ? 0 : 1
