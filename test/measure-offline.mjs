// 离线验证 measure 工具：不需要 DSH、不需要 EPLAN、不需要真实截图。
//
// 用 ffmpeg 现场画一张 960×608 的黑底白格线图（每 40 px 一条），
// 这样每一条线的真实位置都是已知的，量错了立刻能看出来。
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findBinary } from '../server/video.mjs'
import * as mod from '../video-tool.js'

const dir = mkdtempSync(join(tmpdir(), 'eplan-measure-'))
const image = join(dir, 'grid.png')
const ffmpeg = findBinary('ffmpeg')

try {
  execFileSync(
    ffmpeg,
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=960x608', '-vf', 'drawgrid=w=40:h=40:t=1:c=white', '-frames:v', '1', image],
    { stdio: 'ignore' },
  )
} catch (error) {
  console.log(`跳过：ffmpeg 不可用（${error.message}）。装 ffmpeg 或用 EPLAN_MCP_FFMPEG 指定路径。`)
  process.exit(0)
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}

// 通过插件注册的入口调用：顺带验证 measure 真的挂在预设工具上。
let measureTool = null
mod.apply({
  tools: { register: (definition) => { if (definition.name === 'measure') measureTool = definition; return () => {} } },
  get() { return undefined },
})

check('measure 已注册为原生工具', measureTool !== null)
check('参数只要求 path + action', JSON.stringify(measureTool?.parameters?.required) === '["path","action"]')

async function run(args) {
  const result = await measureTool.execute({ path: image, ...args })
  return JSON.parse(result.content[0].text)
}

// ── 标定 ──────────────────────────────────────────────────────────────
const coarse = await run({ action: 'calibrate', from: [0, 0], to: [80, 0], mm: 20 })
check('粗分辨率标定算出 4 px/mm', Math.abs(coarse.pxPerMm - 4) < 0.01, `${coarse.pxPerMm} px/mm`)
check('低于 8 px/mm 直接告警', coarse.resolutionOk === false && typeof coarse.warning === 'string')

const fine = await run({ action: 'calibrate', from: [0, 0], to: [80, 0], mm: 5 })
check('高分辨率标定算出 16 px/mm', Math.abs(fine.pxPerMm - 16) < 0.01, `${fine.pxPerMm} px/mm`)
check('够用的分辨率不告警', fine.resolutionOk === true && fine.warning === undefined)

// ── 找线 ──────────────────────────────────────────────────────────────
const edges = await run({ action: 'edges', axis: 'x' })
check('竖线数量约等于 960/40', Math.abs(edges.count.x - 24) <= 2, `${edges.count.x} 条`)
check('第一条竖线在 x=0 附近', Math.abs(edges.x[0].px - 0) <= 2, `x=${edges.x[0].px}`)
check('相邻竖线间隔 40 px', Math.abs(edges.x[1].px - edges.x[0].px - 40) <= 2, `${edges.x[1].px - edges.x[0].px} px`)

const horizontal = await run({ action: 'edges', axis: 'y' })
check('横线数量约等于 608/40', Math.abs(horizontal.count.y - 15) <= 2, `${horizontal.count.y} 条`)

// ── 像素 → mm ─────────────────────────────────────────────────────────
const calibrated = await run({
  action: 'edges',
  axis: 'x',
  pxPerMm: 4,
  originPx: [0, 608],
  originMm: [0, 0],
  region: [0, 0, 400, 608],
})
const at80 = calibrated.x.find((item) => Math.abs(item.px - 80) <= 2)
check('像素 80 → 20 mm', at80 !== undefined && Math.abs(at80.mm - 20) <= 0.5, `${at80?.mm} mm`)
check('换算假设写进了 note', typeof calibrated.note === 'string' && calibrated.note.includes('px/mm'))

// ── 推间距 ────────────────────────────────────────────────────────────
const grid = await run({ action: 'grid', pxPerMm: 4 })
check('grid 推出 40 px 间距', grid.spacingPx.x === 40 && grid.spacingPx.y === 40, `${grid.spacingPx.x}/${grid.spacingPx.y} px`)
check('grid 置信度高', grid.confidence.x >= 0.9 && grid.confidence.y >= 0.9, `${grid.confidence.x}/${grid.confidence.y}`)
check('grid 同时给出 mm 间距', grid.spacingMm.x === 10 && grid.spacingMm.y === 10, `${grid.spacingMm.x}/${grid.spacingMm.y} mm`)

// ── 出错路径 ──────────────────────────────────────────────────────────
let notFound = null
try {
  await run({ action: 'edges', path: join(dir, 'nope.png') })
} catch (error) {
  notFound = error
}
check('文件不存在时报 MEASURE_NOT_FOUND', notFound?.code === 'MEASURE_NOT_FOUND', notFound?.message?.slice(0, 40))

const failed = checks.filter((item) => !item.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `失败 ${failed.length} 项`}：${checks.length - failed.length}/${checks.length}`)
process.exitCode = failed.length === 0 ? 0 : 1
