// 版面看相：把「散 / 挤 / 线太短」翻译成几何数字，不许靠感觉。
//   node test/appearance-offline.mjs
import { appearanceReport } from '../server/compact.mjs'

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

/** 一个 8×8 的元件：原点 + 四个角上的引脚，够算包围盒。 */
const part = (x, y, name = 'FA3') => ({
  type: 'Function',
  objectId: `${name}@${x},${y}`,
  location: [x, y],
  symbolName: name,
  name: `=+-${name}`,
  pins: [
    { location: [0, 4], direction: 'Up', index: 0 },
    { location: [0, -4], direction: 'Down', index: 1 },
    { location: [8, 4], direction: 'Up', index: 2 },
    { location: [8, -4], direction: 'Down', index: 3 },
  ],
})

// 三组：左边一列三个（间距 20），右边一组两个（间距 20），两组之间空 30；远处一个孤零零的。
const tight = {
  placements: [
    part(40, 240), part(40, 212), part(40, 184),
    part(120, 240), part(120, 212),
    part(240, 220),
  ],
}

const report = appearanceReport(tight, { pageSize: [420, 297] })
check('分组数正确（左列 / 右列 / 远处各一组）', report.groups === 3, `groups=${report.groups}`)
check('统计到全部元件', report.items === 6, `items=${report.items}`)
check('组间空隙有数字', Array.isArray(report.gaps) && report.gaps.length >= 2, JSON.stringify(report.gaps))
check('同列间距有中位数', report.pitches.median !== null, JSON.stringify(report.pitches))
check('四边余量给了四项', report.margins && ['left', 'right', 'top', 'bottom'].every((key) => typeof report.margins[key] === 'number'), JSON.stringify(report.margins))

// 远到 60 mm 开外 → groups_scattered（「散」）
const scattered = appearanceReport({ placements: [part(40, 240), part(300, 240)] }, { pageSize: [420, 297] })
check('两组隔得太开 → groups_scattered', scattered.issues.some((item) => item.kind === 'groups_scattered'), JSON.stringify(scattered.issues.map((i) => i.kind)))
check('scattered 带可照做的 fix', scattered.issues.every((item) => typeof item.fix === 'string' && item.fix.length > 10))

// 贴在一起 → group_crowded（「挤」）
const crowded = appearanceReport({ placements: [part(40, 240), part(50, 240)] }, { pageSize: [420, 297] })
check('两组贴在一起 → group_crowded', crowded.issues.some((item) => item.kind === 'group_crowded'), JSON.stringify(crowded.issues.map((i) => i.kind)))

// 同列挨太紧 → short_wires（「线修长一点」）
const stubby = {
  placements: [
    { ...part(40, 240), pins: [{ location: [0, 4], direction: 'Up', index: 0 }, { location: [0, -4], direction: 'Down', index: 1 }] },
    { ...part(40, 232), pins: [{ location: [0, 4], direction: 'Up', index: 0 }, { location: [0, -4], direction: 'Down', index: 1 }] },
    { ...part(40, 224), pins: [{ location: [0, 4], direction: 'Up', index: 0 }, { location: [0, -4], direction: 'Down', index: 1 }] },
    { ...part(40, 216), pins: [{ location: [0, 4], direction: 'Up', index: 0 }, { location: [0, -4], direction: 'Down', index: 1 }] },
  ],
}
const shortWires = appearanceReport(stubby, { pageSize: [420, 297] })
check('同列挤成一串 → short_wires', shortWires.issues.some((item) => item.kind === 'short_wires'), JSON.stringify(shortWires.issues.map((i) => i.kind)))

// 空页 / 只有文字：不许炸，也不许编问题。
check('空页不炸', appearanceReport({ placements: [] }).issues.length === 0)
check('没有 placements 也不炸', appearanceReport({}).items === 0)
check('没有 pageSize 时不给 margins', appearanceReport(tight).margins === undefined)

// 好看的样板（skill 里那份）不该报任何 issue —— 否则模型会对着「合格」的图改个不停。
const nice = {
  placements: [
    // 主回路：一列三个，间距 36
    part(48, 268), part(48, 232), part(48, 196),
    // 二次侧：右上角一组，与主回路相隔 ~30
    part(96, 232), part(96, 196),
  ],
}
const niceReport = appearanceReport(nice, { pageSize: [420, 297] })
check('规整样板不报版面问题', niceReport.issues.length === 0, JSON.stringify(niceReport.issues.map((i) => i.kind)))

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass}/${pass + fail}`)
process.exitCode = fail === 0 ? 0 : 1
