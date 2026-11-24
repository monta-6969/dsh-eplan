// 量图：把截图/视频帧里的像素距离换算成毫米。
//
// 为什么单独做：审计里 42 分钟有 9 分钟花在「数格子再心算 mm」上，而且算错过。
// 这件事不需要 EPLAN，不需要建模，只要一次调用把结果连校准一起给出来。
//
// 只做三件事：
//   calibrate  两点像素 + 已知真实距离 → px/mm
//   edges      沿行/列找明暗跳变（图框线、器件边框、栅格线），给像素与 mm
//   grid       从边缘位置推主导间距（= 栅格或器件极距）
//
// 图像解码走 ffmpeg 的 rawvideo 灰度输出，不引第三方图像库。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { findBinary } from './video.mjs'

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function runBuffer(bin, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, { windowsHide: true })
    const out = []
    const err = []
    child.stdout?.on('data', (chunk) => out.push(chunk))
    child.stderr?.on('data', (chunk) => err.push(chunk))
    child.on('error', rejectPromise)
    child.on('close', (code) =>
      resolvePromise({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    )
  })
}

async function probeSize(path) {
  const ffprobe = findBinary('ffprobe')
  const result = await runBuffer(ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    path,
  ])
  const text = result.stdout.toString('utf8').trim()
  const match = /^(\d+),(\d+)/.exec(text)
  if (result.code !== 0 || !match) {
    throw fail('MEASURE_UNREADABLE', `读不出图片尺寸（${path}）：${result.stderr.trim() || text || 'ffprobe 无输出'}`)
  }
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** 解码成 8 位灰度。超过 4000 万像素直接拒绝，免得一口气吃掉几百 MB。 */
async function loadGray(path) {
  if (!existsSync(path)) throw fail('MEASURE_NOT_FOUND', `找不到图片：${path}`)
  const size = await probeSize(path)
  if (size.width * size.height > 40_000_000) {
    throw fail('MEASURE_TOO_LARGE', `图片太大（${size.width}×${size.height}），先裁出要量的区域再试。`)
  }
  const result = await runBuffer(findBinary('ffmpeg'), [
    '-v',
    'error',
    '-i',
    path,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    '-',
  ])
  if (result.code !== 0 || result.stdout.length < size.width * size.height) {
    throw fail('MEASURE_DECODE', `ffmpeg 解码失败：${result.stderr.trim() || `只拿到 ${result.stdout.length} 字节`}`)
  }
  return { width: size.width, height: size.height, data: result.stdout }
}

function otsuThreshold(histogram) {
  let total = 0
  let sum = 0
  for (let i = 0; i < histogram.length; i += 1) {
    total += histogram[i]
    sum += i * histogram[i]
  }
  if (total === 0) return 24
  let best = 24
  let bestVariance = -1
  let weightLow = 0
  let sumLow = 0
  for (let level = 1; level < histogram.length; level += 1) {
    weightLow += histogram[level - 1]
    sumLow += (level - 1) * histogram[level - 1]
    const weightHigh = total - weightLow
    if (weightLow === 0 || weightHigh === 0) continue
    const meanLow = sumLow / weightLow
    const meanHigh = (sum - sumLow) / weightHigh
    const variance = weightLow * weightHigh * (meanLow - meanHigh) * (meanLow - meanHigh)
    if (variance > bestVariance) {
      bestVariance = variance
      best = level
    }
  }
  // 太低的阈值会把压缩噪声当边：起码要 16。
  return Math.max(16, best)
}

function gradientHistogram(gray, width, region, axis) {
  const [x0, y0, x1, y1] = region
  const histogram = new Array(256).fill(0)
  if (axis === 'x') {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0 + 1; x < x1; x += 1) {
        histogram[Math.abs(gray[y * width + x] - gray[y * width + x - 1])] += 1
      }
    }
  } else {
    for (let y = y0 + 1; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        histogram[Math.abs(gray[y * width + x] - gray[(y - 1) * width + x])] += 1
      }
    }
  }
  return histogram
}

/** 把相邻的命中像素并成一条线，返回线的中心像素。 */
function cluster(positions, minGap) {
  const lines = []
  let sum = 0
  let weight = 0
  let last = null
  for (const { at, count } of positions) {
    if (last !== null && at - last > minGap) {
      lines.push(Math.round(sum / Math.max(1, weight)))
      sum = 0
      weight = 0
    }
    sum += at * count
    weight += count
    last = at
  }
  if (weight > 0) lines.push(Math.round(sum / weight))
  return lines
}

/**
 * 找垂直于 axis 的直线：axis=“x” 找竖线（列），"y" 找横线（行）。
 * 判据不是「整行都亮」，而是「这一列/行上足够多的扫描线出现明显跳变」，
 * 所以器件边框、图框线、栅格线都能被找出来，实线虚线都一样。
 */
function findLines(image, region, axis, gradientThreshold, minGap) {
  const [x0, y0, x1, y1] = region
  const hits = new Map()
  const threshold = gradientThreshold ?? otsuThreshold(gradientHistogram(image.data, image.width, region, axis))
  let scans = 0

  if (axis === 'x') {
    for (let y = y0; y < y1; y += 1) {
      let previous = image.data[y * image.width + x0]
      for (let x = x0 + 1; x < x1; x += 1) {
        const value = image.data[y * image.width + x]
        if (Math.abs(value - previous) >= threshold) hits.set(x, (hits.get(x) ?? 0) + 1)
        previous = value
      }
      scans += 1
    }
  } else {
    for (let x = x0; x < x1; x += 1) {
      let previous = image.data[y0 * image.width + x]
      for (let y = y0 + 1; y < y1; y += 1) {
        const value = image.data[y * image.width + x]
        if (Math.abs(value - previous) >= threshold) hits.set(y, (hits.get(y) ?? 0) + 1)
        previous = value
      }
      scans += 1
    }
  }

  // 至少四分之一扫描线都看到跳变才算线；纯噪点过不了这一关。
  const needed = Math.max(2, Math.floor(scans * 0.25))
  const positions = [...hits]
    .filter(([, count]) => count >= needed)
    .map(([at, count]) => ({ at, count }))
    .sort((a, b) => a.at - b.at)
  return { lines: cluster(positions, minGap), threshold }
}

function toMm(px, axis, calibration) {
  const { pxPerMm, originPx, originMm, flipY } = calibration
  const index = axis === 'x' ? 0 : 1
  const delta = (px - originPx[index]) / pxPerMm
  return Number((originMm[index] + (axis === 'y' && flipY ? -delta : delta)).toFixed(2))
}

function normalizeRegion(region, image) {
  if (!region) return [0, 0, image.width, image.height]
  if (!Array.isArray(region) || region.length !== 4) {
    throw fail('BAD_ARGUMENT', 'region 必须是 [x0, y0, x1, y1] 四个像素坐标。')
  }
  const [x0, y0, x1, y1] = region.map((value) => Math.round(Number(value)))
  if (![x0, y0, x1, y1].every(Number.isFinite) || x0 < 0 || y0 < 0 || x1 > image.width || y1 > image.height || x1 - x0 < 4 || y1 - y0 < 4) {
    throw fail('BAD_ARGUMENT', `region 超出图像范围（图 ${image.width}×${image.height}）：${JSON.stringify(region)}`)
  }
  return [x0, y0, x1, y1]
}

function gridFrom(lines) {
  const gaps = []
  for (let index = 1; index < lines.length; index += 1) {
    const gap = lines[index] - lines[index - 1]
    if (gap >= 3) gaps.push(gap)
  }
  if (gaps.length === 0) return { spacingPx: null, confidence: 0, samples: 0 }
  const sorted = [...gaps].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const near = gaps.filter((gap) => Math.abs(gap - median) <= Math.max(2, median * 0.2))
  return {
    spacingPx: median,
    confidence: Number((near.length / gaps.length).toFixed(2)),
    samples: gaps.length,
  }
}

export async function measure(args = {}) {
  const action = args.action ?? 'edges'
  const from = args.from
  const to = args.to

  if (action === 'calibrate') {
    if (!Array.isArray(from) || !Array.isArray(to) || from.length < 2 || to.length < 2) {
      throw fail('BAD_ARGUMENT', 'calibrate 需要 from 和 to 两个像素坐标 [x, y]。')
    }
    const mm = Number(args.mm)
    if (!Number.isFinite(mm) || mm <= 0) {
      throw fail('BAD_ARGUMENT', 'calibrate 需要 mm（这两点在现实里的距离，毫米）。')
    }
    const pxDistance = Math.hypot(Number(to[0]) - Number(from[0]), Number(to[1]) - Number(from[1]))
    if (!(pxDistance > 0.5)) throw fail('BAD_ARGUMENT', 'from 与 to 落在同一个像素上，量不出比例。')
    const pxPerMm = pxDistance / mm
    const payload = {
      action,
      pxDistance: Number(pxDistance.toFixed(2)),
      mm,
      pxPerMm: Number(pxPerMm.toFixed(3)),
      mmPerPx: Number((1 / pxPerMm).toFixed(4)),
      resolutionOk: pxPerMm >= 8,
    }
    if (pxPerMm < 8) {
      payload.warning =
        `这个分辨率下 1 mm 只有 ${pxPerMm.toFixed(2)} px，换算误差约 ±${(0.5 / pxPerMm).toFixed(2)} mm（半个像素）。` +
        '要量到 0.5 mm 以内，请把截图或录屏分辨率提高（至少 8 px/mm 才勉强够用）。'
    }
    return payload
  }

  const image = await loadGray(args.path)
  const region = normalizeRegion(args.region, image)
  const minGap = Math.max(1, Number(args.minGapPx ?? 3))

  const calibration = (() => {
    const pxPerMm = Number(args.pxPerMm)
    if (!Number.isFinite(pxPerMm) || pxPerMm <= 0) return null
    return {
      pxPerMm,
      originPx: Array.isArray(args.originPx) ? args.originPx.map(Number) : [0, image.height],
      originMm: Array.isArray(args.originMm) ? args.originMm.map(Number) : [0, 0],
      flipY: args.flipY !== false,
    }
  })()

  const axes = args.axis === 'x' || args.axis === 'y' ? [args.axis] : ['x', 'y']
  const threshold = args.threshold === undefined ? undefined : Math.max(1, Number(args.threshold))

  const result = {
    action,
    image: { width: image.width, height: image.height },
    region,
    threshold: threshold ?? null,
    axis: axes.length === 2 ? 'both' : axes[0],
  }

  const linesByAxis = {}
  for (const axis of axes) {
    const found = findLines(image, region, axis, threshold, minGap)
    result.threshold = found.threshold
    const lines = found.lines
    linesByAxis[axis] = lines
    if (action === 'grid') {
      const grid = gridFrom(lines)
      result.spacingPx = { ...(result.spacingPx ?? {}), [axis]: grid.spacingPx }
      result.confidence = { ...(result.confidence ?? {}), [axis]: grid.confidence }
      result.samples = { ...(result.samples ?? {}), [axis]: grid.samples }
      if (grid.spacingPx !== null && calibration) {
        result.spacingMm = { ...(result.spacingMm ?? {}), [axis]: Number((grid.spacingPx / calibration.pxPerMm).toFixed(2)) }
      }
    } else {
      const items = lines.slice(0, 60).map((px) => (calibration ? { px, mm: toMm(px, axis, calibration) } : { px }))
      result[axis] = items
      result.count = { ...(result.count ?? {}), [axis]: items.length }
    }
  }

  if (action === 'edges' && calibration) {
    result.note =
      `换算假设：图上的 (${calibration.originPx[0]}, ${calibration.originPx[1]}) 等于 (${calibration.originMm[0]}, ${calibration.originMm[1]}) mm，` +
      `${calibration.pxPerMm.toFixed(2)} px/mm${calibration.flipY ? '，图片 Y 轴向下而 EPLAN Y 轴向上（已翻转）' : ''}。` +
      '核对首尾两条线是否与已知尺寸对得上，对不上就是标定选错了。'
  }
  if (action === 'edges' && linesByAxis.x?.length === 0 && linesByAxis.y?.length === 0) {
    result.note = '一条线都没找到：可能是阈值太高，或 region 选的是空白区域。传 threshold=16 再试一次。'
  }
  return result
}
