// 符号候选：名字写错时给出的候选必须真的能用。
//   node test/fuzzy-offline.mjs
import { editDistance, closestSymbolNames } from '../server/fuzzy.mjs'

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

check('编辑距离基本性质', editDistance('DCP', 'DCP') === 0)
check('一字之差 = 1', editDistance('FA3', 'FA31') === 1)
check('对称', editDistance('SON', 'SOM') === editDistance('SOM', 'SON'))
check('空串', editDistance('', 'ABC') === 3)

// 真实库里的名字（GB_symbol 的常见叫法）。
const LIB = [
  'FA3', 'FA3A', 'QSF3', 'QSF3A', 'TLRU', 'LSW1', 'LSW1A', 'LSW2', 'LSW3', 'SSA', 'SON',
  'BOSW', 'BSSW', 'KM2', 'BP', 'DCPL', 'DCPS', 'FUSE3', 'MOTOR', 'PE',
]

const dcp = closestSymbolNames('DCP', LIB)
check('DCP 给出候选而不是空', dcp.length > 0, JSON.stringify(dcp))
check('DCP 首选 DCPL', dcp[0] === 'DCPL', JSON.stringify(dcp))
check('DCP 不推荐无关的 MOTOR', !dcp.slice(0, 3).includes('MOTOR'), JSON.stringify(dcp))

check('精确命中时自己排第一', closestSymbolNames('FA3', LIB)[0] === 'FA3')
check('前缀写法都排在前面', closestSymbolNames('LSW', LIB).every((name) => name.startsWith('LSW')), JSON.stringify(closestSymbolNames('LSW', LIB)))
check('短名不推无关的（SSA 不该出现在 LSW 的候选里）', !closestSymbolNames('LSW', LIB).includes('SSA'))

// 完全不像的名字：返回空是结论，不是失败 —— 调用方据此换策略。
check('无关名字返回空', closestSymbolNames('ZZZZZZZZ', LIB).length === 0)
check('大小写不敏感', closestSymbolNames('son', LIB)[0] === 'SON')
check('限个数', closestSymbolNames('K', LIB, 2).length <= 2)
check('空输入不炸', closestSymbolNames('', LIB).length === 0 && closestSymbolNames('A', null).length === 0)

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass}/${pass + fail}`)
process.exitCode = fail === 0 ? 0 : 1
