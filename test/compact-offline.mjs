// 载荷收敛层的离线回归：不碰 EPLAN，只用一份真实 inspect 快照量三档体积。
//
// 用法：node test/compact-offline.mjs [快照路径]
// 没有快照时会用内联的最小样本，保证 CI 里也能跑。
import { readFileSync, existsSync } from 'node:fs'
import { compactInspect, geometryProblems, digest, RepeatMemo } from '../server/compact.mjs'

const snapshot = process.argv[2]
const sample = {
  page: '=MI/13',
  pageType: 'Schematic',
  placementTotal: 6,
  functionTotal: 2,
  placements: [
    { type: 'Function', objectId: '1', location: [100, 200], symbolName: 'FA3', variant: 0, pins: [
      { location: [0, 4], direction: 'Up', index: 0 },
      { location: [0, -4], direction: 'Down', index: 1 },
      { location: [8, 4], direction: 'Up', index: 2 },
      { location: [8, -4], direction: 'Down', index: 3 },
    ] },
    // 与上一个同坐标同变体 → duplicate_symbol
    { type: 'Function', objectId: '2', location: [100, 200], symbolName: 'FA3', variant: 0, pins: [
      { location: [0, 4], direction: 'Up', index: 0 },
    ] },
    // 本体与第一个重叠 → symbol_overlap
    { type: 'Function', objectId: '7', location: [104, 200], symbolName: 'BOSW', variant: 0, pins: [
      { location: [0, 4], direction: 'Up', index: 0 },
      { location: [4, -4], direction: 'Down', index: 1 },
    ] },
    // 落在第一个元件本体内部 → text_on_symbol
    { type: 'Text', objectId: '3', location: [104, 200] },
    { type: 'InterruptionPoint', objectId: '4', location: [100, 208], symbolName: 'BP', variant: 1, pins: [
      { location: [0, -1], direction: 'Up', index: 0 },
    ] },
    { type: 'Rectangle', objectId: '5', location: [96, 156] },
    { type: 'Text', objectId: '6', location: [103, 190] },
  ],
  functions: [{ name: '=+-F11', visibleName: '', type: 'Function', symbolName: '=+-F11' }],
  connections: { count: -1, note: 'Page 上没有 Connections 属性。' },
}

const hasSnapshot = Boolean(snapshot && existsSync(snapshot))
const raw = hasSnapshot ? JSON.parse(readFileSync(snapshot, 'utf8')) : sample
const size = (value) => JSON.stringify(value).length

const summary = compactInspect(raw, { view: 'summary' })
const list = compactInspect(raw, { view: 'list', limit: 500 })
const full = compactInspect(raw, { view: 'full' })
const pretty = JSON.stringify(raw, null, 2).length

const checks = []
const expect = (name, condition, detail) => checks.push({ name, ok: Boolean(condition), detail })

expect('summary 小于 full', size(summary) < size(full), `summary=${size(summary)} full=${size(full)}`)
if (hasSnapshot) {
  // 体积比例只在真实一页上断言：内联样本只有 6 个对象，summary 的固定开销
  // （页名/页型/坐标范围）本来就到不了 1/4，拿它断言是测错了对象。
  expect('summary 小于 1/4 紧凑全量', size(summary) * 4 < size(raw), `summary=${size(summary)} raw="${size(raw)}"`)
}
expect('full 比原文缩进版小', size(full) < pretty, `full=${size(full)} pretty=${pretty}`)
expect('summary 带 problems', Array.isArray(summary.problems), `problems=${summary.problems.length}`)
expect('list 一行一对象', list.rows.length === raw.placements.length, `rows=${list.rows.length}`)
expect('list 比 full 小', size(list) < size(full), `list=${size(list)}`)

const problems = geometryProblems(raw, { grid: 4, pageSize: [420, 297] })
const kinds = new Set(problems.map((problem) => problem.kind))
// 重复符号只在构造样本里断言：真实页面本来就不该有重复，拿它当断言会反着测。
const sampleKinds = new Set(geometryProblems(sample, { grid: 4, pageSize: [420, 297] }).map((p) => p.kind))
expect('识别重复符号', sampleKinds.has('duplicate_symbol'), [...sampleKinds].join(','))
expect('识别符号重叠', sampleKinds.has('symbol_overlap'), [...sampleKinds].join(','))
expect('识别文字压符号', sampleKinds.has('text_on_symbol'), [...sampleKinds].join(','))
if (hasSnapshot) expect('真实页面不误报重复符号', !kinds.has('duplicate_symbol'), [...kinds].join(','))

const memo = new RepeatMemo()
const first = memo.check('k', { a: 1 })
const second = memo.check('k', { a: 1 })
const third = memo.check('k', { a: 2 })
expect('重复载荷被识别', first.repeat === false && second.repeat === true && third.repeat === false, '')
expect('digest 稳定', digest({ a: 1 }) === digest({ a: 1 }), digest({ a: 1 }))

const failed = checks.filter((check) => !check.ok)
console.log(`snapshot=${snapshot ?? '内联样本'} pretty=${pretty} compact=${size(raw)}`)
console.log(`summary=${size(summary)} list=${size(list)} full=${size(full)}`)
console.log(`problems: ${problems.map((problem) => problem.kind).join(', ') || '(none)'}`)
for (const check of checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}  ${check.detail}`)
if (failed.length > 0) {
  console.error(`${failed.length} 项失败`)
  process.exitCode = 1
} else {
  console.log(`${checks.length}/${checks.length} 通过`)
}
