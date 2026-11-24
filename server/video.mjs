// 视频摘要管线：把一段录屏压成「几段 + 每段一张整页图 + 讲解文字」。
//
// 设计原则（2026-11-23 用户要求）：
//   1. 模型不该反复看视频、抽帧、放大细节 —— 那是工具的活。发送时就把视频变成摘要。
//   2. 切分依据是**页码变化**（标题栏/标签），不是整屏 scene 阈值：
//      画图时画面一直在小改，全局 scene 只能给出 1 帧（实测 248 s 录屏只出 1 帧）。
//   3. 没有讲解就要**明说没有**，并且转写失败必须带出原因，不许静默给空字符串。
//
// 只做事实，不做猜测：探测、切分、取图、量响度、切语音都由这里算；
// 转写由调用方注入（DSH 的 speechToText 服务在 Host 进程内，这里够不到）。
//
// 命令行：
//   node video.mjs --path <视频> [--max-pages 6] [--at 136] [--series]
// 输出一行 JSON 到 stdout。

import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, existsSync, statSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const FFMPEG_CANDIDATES = [
  process.env.EPLAN_MCP_FFMPEG,
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  'C:/ffmpeg/bin/ffmpeg.exe',
].filter(Boolean)

export function findBinary(name) {
  const explicit = name === 'ffmpeg' ? process.env.EPLAN_MCP_FFMPEG : process.env.EPLAN_MCP_FFPROBE
  if (explicit && existsSync(explicit)) return explicit
  for (const candidate of FFMPEG_CANDIDATES) {
    const sibling = candidate.replace(/ffmpeg\.exe$/i, `${name}.exe`)
    if (existsSync(sibling)) return sibling
  }
  return `${name}.exe` // 交给 PATH，找不到由 spawn 报 ENOENT。
}

/** 跑一个进程，按需收集 stdout / stderr。 */
function run(bin, args, { collectStdout = true, cwd } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { windowsHide: true, cwd })
    const out = []
    const err = []
    child.stdout?.on('data', (chunk) => { if (collectStdout) out.push(chunk) })
    child.stderr?.on('data', (chunk) => { err.push(chunk) })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      resolvePromise({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
  })
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// ---------------------------------------------------------------------------
// 硬件解码。
//
// 采样一遍整段录屏要把每一帧都解码，这是这条流水线里最贵的一步。
// 实测（1080p H.264、631 s、fps=1 采样一遍，同一台机器）：
//
//   纯 CPU                              20.0 s
//   cuda  + 只在采样后下载（本文件用法）    9.5 s
//   d3d11va + 只在采样后下载                10.9 s
//   cuda 不带 output_format（隐式逐帧下载） 27–52 s   ← 比 CPU 还慢
//
// 结论不是「开硬件解码就快」，而是「哪些帧被拷回内存」：
// 把 fps 放在 GPU 上跑、每秒只 hwdownload 那一帧才省；逐帧下载会把省下的
// 解码时间全赔在显存→内存的拷贝上。所以这里固定用
// `-hwaccel X -hwaccel_output_format Y` + 滤镜里 fps 之后立刻 hwdownload。
//
// 单帧取图（grabFrame）**不**走硬件：每次调用要建一次解码上下文，
// 实测比软件解码慢，而单帧本来就是几十毫秒的事。
// ---------------------------------------------------------------------------
let hwProbe = null
// 这次进程里已经证明硬件解码跑不动（个别编码/驱动组合），别再试第二遍。
let hwFailed = false

/** 让测试和长跑进程能重新探测（换机器、换驱动、改环境变量的场景）。 */
export function resetHardwareState() {
  hwProbe = null
  hwFailed = false
}

/** ffmpeg 这台机器上到底支持哪些硬件解码器，只问一次。 */
async function availableAccel(ffmpeg) {
  if (hwProbe) return hwProbe
  let models = []
  try {
    const result = await run(ffmpeg, ['-hide_banner', '-hwaccels'])
    models = result.stdout
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.endsWith(':'))
  } catch {
    models = [] // 连 -hwaccels 都跑不了就当没有硬件，走软件解码。
  }
  hwProbe = { models }
  return hwProbe
}

/**
 * 决定这次采样用不用硬件解码。
 *
 * 短片段不用：建一次解码上下文在 12 秒测试片上实测 342 ms，而纯软件只要 90 ms，
 * 硬件解码省下的是「解码每一帧」的时间，片太短还没摊平初始化的开销。
 * 默认门槛 120 秒，可用 EPLAN_MCP_HWACCEL_MIN_SECONDS 调；
 * 显式写 EPLAN_MCP_HWACCEL=cuda / d3d11va 表示强制用（短片段也照用）。
 */
async function pickHwAccel(ffmpeg, seconds = 0) {
  if (hwFailed) return null
  const setting = String(process.env.EPLAN_MCP_HWACCEL ?? 'auto').trim().toLowerCase()
  if (setting === 'off' || setting === 'none' || setting === '0') return null

  const forced = setting !== 'auto' && setting !== 'always'
  if (!forced) {
    const minSeconds = Number(process.env.EPLAN_MCP_HWACCEL_MIN_SECONDS ?? 120)
    if (Number.isFinite(minSeconds) && seconds < minSeconds) return null
  }

  const { models } = await availableAccel(ffmpeg)
  const preferred = forced ? [setting] : ['cuda', 'd3d11va']
  const model = preferred.find((name) => models.includes(name)) ?? null
  if (!model) return null
  const format = model === 'cuda' ? 'cuda' : model === 'd3d11va' ? 'd3d11' : model
  process.stderr.write(`[eplan-mcp] 视频解码走硬件：${model}（${Math.round(seconds)} 秒素材）\n`)
  return { model, format }
}

function round2(value) { return Math.round(value * 100) / 100 }

function clamp(value, low, high) { return Math.min(high, Math.max(low, value)) }

/** 秒 → m:ss 便于人读。 */
export function clock(seconds) {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/** 视频元信息。 */
export async function probe(path) {
  if (!existsSync(path)) throw fail('VIDEO_NOT_FOUND', `找不到视频文件：${path}`)
  const ffprobe = findBinary('ffprobe')
  let result
  try {
    result = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
  } catch (error) {
    throw fail('VIDEO_NO_FFMPEG', `调用 ffprobe 失败：${error.message}。可以用 EPLAN_MCP_FFMPEG 指定 ffmpeg 路径。`)
  }
  if (result.code !== 0) throw fail('VIDEO_UNREADABLE', `ffprobe 读不了这个文件：${result.stderr.trim()}`)
  const info = JSON.parse(result.stdout)
  const video = (info.streams ?? []).find((stream) => stream.codec_type === 'video')
  const audio = (info.streams ?? []).find((stream) => stream.codec_type === 'audio')
  if (!video) throw fail('VIDEO_NO_STREAM', '这个文件里没有视频轨。')
  const [num, den] = String(video.r_frame_rate ?? '0/1').split('/').map(Number)
  return {
    path: resolvePath(path),
    bytes: statSync(path).size,
    duration: Number(info.format?.duration ?? video.duration ?? 0),
    width: Number(video.width),
    height: Number(video.height),
    fps: den ? Math.round((num / den) * 100) / 100 : null,
    videoCodec: video.codec_name ?? null,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
  }
}

/**
 * 逐秒采样两种画面：整屏（缩到 192×120）与标题栏（顶部 7%，384×28）。
 * 输出灰度原始帧，差值在 Node 里算 —— 比解析 ffmpeg 的 stderr 稳，也能拿到变化面积。
 */
export async function motionSeries(path, meta, workDir) {
  const ffmpeg = findBinary('ffmpeg')
  const canvasW = 192
  const canvasH = Math.max(8, Math.round(canvasW * meta.height / meta.width / 2) * 2)
  const stripH = Math.max(8, Math.round(meta.height * 0.07 / 2) * 2)
  const stripW = 384
  const canvasFile = join(workDir, 'canvas.raw')
  const stripFile = join(workDir, 'strip.raw')

  // 软件解码的滤镜图：两路都用 fps=1 之后自己的缩放。
  const softwareGraph =
    `[0:v]fps=1,scale=${canvasW}:${canvasH},format=gray[a];`
    + `[0:v]fps=1,crop=iw:${stripH}:0:0,scale=${stripW}:${Math.max(8, Math.round(stripH / 6))},format=gray[b]`

  // 硬件解码的滤镜图：fps 在 GPU 上跑，只把每秒那一帧下载回内存，
  // 然后 split 成两路（下载一次，别每路各下一次）。
  const hardwareGraph =
    `[0:v]fps=1,hwdownload,format=nv12,split=2[whole][strip];`
    + `[whole]scale=${canvasW}:${canvasH},format=gray[a];`
    + `[strip]crop=iw:${stripH}:0:0,scale=${stripW}:${Math.max(8, Math.round(stripH / 6))},format=gray[b]`

  const build = (hw) => [
    '-hide_banner', '-loglevel', 'error',
    ...(hw?.model ? ['-hwaccel', hw.model, '-hwaccel_output_format', hw.format] : []),
    '-i', path,
    '-filter_complex', hw?.model ? hardwareGraph : softwareGraph,
    '-map', '[a]', '-f', 'rawvideo', '-pix_fmt', 'gray', '-y', canvasFile,
    '-map', '[b]', '-f', 'rawvideo', '-pix_fmt', 'gray', '-y', stripFile,
  ]

  const hardware = await pickHwAccel(ffmpeg, meta.duration)
  let result
  try {
    result = await run(ffmpeg, build(hardware))
    if (hardware?.model && (result.code !== 0 || !existsSync(canvasFile))) {
      // GPU 解码在个别编码/驱动组合上会失败（老 VP9、AV1、虚拟显卡等）。
      // 记住这次失败，整段降级回软件解码，别让用户看到一次失败就整条链路挂掉。
      process.stderr.write(
        `[eplan-mcp] 硬件解码不可用，回退软件解码：${result.stderr.trim().slice(0, 160)}\n`,
      )
      hwFailed = true
      result = await run(ffmpeg, build(null))
    }
  } catch (error) {
    throw fail('VIDEO_NO_FFMPEG', `调用 ffmpeg 失败：${error.message}`)
  }
  if (result.code !== 0 || !existsSync(canvasFile)) {
    throw fail('VIDEO_SAMPLE_FAILED', `采样失败：${result.stderr.trim().slice(0, 400)}`)
  }
  const canvasBytes = canvasW * canvasH
  const stripPixels = Math.max(8, Math.round(stripH / 6))
  const stripBytes = stripW * stripPixels
  const canvas = readFileSync(canvasFile)
  const strip = existsSync(stripFile) ? readFileSync(stripFile) : Buffer.alloc(0)
  const frames = Math.floor(canvas.length / canvasBytes)
  const canvasSeries = []
  const stripSeries = []
  for (let index = 1; index < frames; index += 1) {
    const previous = canvas.subarray((index - 1) * canvasBytes, index * canvasBytes)
    const current = canvas.subarray(index * canvasBytes, (index + 1) * canvasBytes)
    let sum = 0
    let changed = 0
    for (let pixel = 0; pixel < canvasBytes; pixel += 1) {
      const delta = Math.abs(current[pixel] - previous[pixel])
      sum += delta
      if (delta > 24) changed += 1
    }
    canvasSeries.push({
      t: index,
      mean: round2(sum / canvasBytes),
      changed: round2(changed / canvasBytes),
    })
    const stripIndex = index * stripBytes
    if (strip.length >= stripIndex + stripBytes) {
      const stripPrevious = strip.subarray(stripIndex - stripBytes, stripIndex)
      const stripCurrent = strip.subarray(stripIndex, stripIndex + stripBytes)
      let stripSum = 0
      let stripChanged = 0
      for (let pixel = 0; pixel < stripBytes; pixel += 1) {
        const delta = Math.abs(stripCurrent[pixel] - stripPrevious[pixel])
        stripSum += delta
        if (delta > 24) stripChanged += 1
      }
      stripSeries.push({
        t: index,
        mean: round2(stripSum / stripBytes),
        changed: round2(stripChanged / stripBytes),
      })
    }
  }
  return { canvas: canvasSeries, strip: stripSeries, frames, canvasSize: { width: canvasW, height: canvasH } }
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * 强边界：标题栏大改（页码/标签变了）或整屏重画。
 *
 * 实测校准（248 s 录屏）：画同一页时每秒都在小改，标题栏 0.14~0.69 的抖动是
 * 鼠标划过标签/窗口；真正的阶段切换都是 0.93 以上。所以门限取 0.5（并随噪声抬高），
 * 整屏重画取 0.88，且两个边界至少隔 15 秒 —— 否则一页纸会被切成一堆碎段。
 */
export function strongBoundaries(series, meta, {
  minSegment = 15,
  stripFloor = 0.5,
  repaintFloor = 0.88,
} = {}) {
  const canvas = series?.canvas ?? []
  const strip = series?.strip ?? []
  if (canvas.length === 0) {
    return [{ index: 1, t0: 0, t1: meta.duration, seconds: meta.duration, reason: 'single', switchScore: null }]
  }
  const stripValues = strip.filter((point) => point.t > 2).map((point) => point.changed)
  const floor = Math.max(stripFloor, median(stripValues) * 4)
  const boundaries = []
  for (const point of strip) {
    if (point.t < 2) continue
    if (point.changed >= floor && point.mean >= 6) {
      boundaries.push({ t: point.t, reason: 'title', score: point.changed })
    }
  }
  for (const point of canvas) {
    if (point.t < 2) continue
    if (point.changed >= repaintFloor) boundaries.push({ t: point.t, reason: 'repaint', score: point.changed })
  }
  boundaries.sort((a, b) => a.t - b.t)

  // 距离太近的边界合并（保留分数高的那个），再切段。
  const kept = []
  for (const boundary of boundaries) {
    const last = kept[kept.length - 1]
    if (last && boundary.t - last.t < minSegment) {
      if (boundary.score > last.score) kept[kept.length - 1] = boundary
      continue
    }
    kept.push(boundary)
  }
  const edges = [0, ...kept.map((boundary) => boundary.t), meta.duration]
  const segments = []
  for (let index = 0; index < edges.length - 1; index += 1) {
    const t0 = edges[index]
    const t1 = edges[index + 1]
    if (t1 - t0 < 1) continue
    segments.push({
      index: segments.length + 1,
      t0: round2(t0),
      t1: round2(t1),
      seconds: round2(t1 - t0),
      reason: index === 0 ? 'start' : kept[index - 1]?.reason ?? 'start',
      switchScore: index === 0 ? null : kept[index - 1]?.score ?? null,
    })
  }
  return segments.length > 0 ? segments : [{ index: 1, t0: 0, t1: meta.duration, seconds: meta.duration, reason: 'single', switchScore: null }]
}

/** 段内挑一帧「最稳」的画面：避开切换瞬间，靠后取（同一页越画越全，后段更像成品）。 */
export function stableTime(segment, series) {
  const canvas = series?.canvas ?? []
  const from = segment.t0 + Math.max(1, segment.seconds * 0.35)
  const to = segment.t1 - 0.5
  const candidates = canvas.filter((point) => point.t >= from && point.t <= to)
  if (candidates.length === 0) {
    const middle = canvas.filter((point) => point.t >= segment.t0 + 0.5 && point.t <= segment.t1)
    if (middle.length === 0) return round2((segment.t0 + segment.t1) / 2)
    let bestMiddle = middle[0]
    for (const point of middle) if (point.mean < bestMiddle.mean) bestMiddle = point
    return round2(bestMiddle.t)
  }
  let best = candidates[0]
  // 并列时取**靠后**的那一帧：同一页画到后面更完整，早的帧往往还没画完。
  for (const point of candidates) if (point.mean <= best.mean) best = point
  return round2(best.t)
}

/**
 * 排阶段：先按强边界切，再补切最长的段，直到够 maxPages 张图；
 * 段数超过 maxPages 时丢掉分数最低的边界（首尾段永远保留，结尾不能丢）。
 * 每段出一张图 —— 逐张给，绝不拼成一张拼图。
 */
export function planStages(series, meta, maxPages = 6, { minSplit = 16 } = {}) {
  const limit = Math.max(1, maxPages)
  let segments = strongBoundaries(series, meta)
  while (segments.length < limit) {
    let target = null
    for (const segment of segments) {
      if (segment.seconds < minSplit) continue
      if (!target || segment.seconds > target.seconds) target = segment
    }
    if (!target) break
    const middle = Math.round((target.t0 + target.t1) / 2)
    const index = segments.indexOf(target)
    segments.splice(index, 1,
      { ...target, t1: middle, seconds: round2(middle - target.t0) },
      { index: 0, t0: middle, t1: target.t1, seconds: round2(target.t1 - middle), reason: 'split', switchScore: null },
    )
  }
  while (segments.length > limit) {
    // 只剩两段时只能把它们并成一段（上限=1 这种极端请求）。
    if (segments.length === 2) {
      segments = [{ ...segments[0], t1: segments[1].t1, seconds: round2(segments[1].t1 - segments[0].t0) }]
      continue
    }
    let weakest = -1
    for (let index = 1; index < segments.length - 1; index += 1) {
      if (weakest < 0 || (segments[index].switchScore ?? 0) < (segments[weakest].switchScore ?? 0)) weakest = index
    }
    if (weakest < 0) break
    const removed = segments.splice(weakest, 1)[0]
    segments[weakest - 1] = {
      ...segments[weakest - 1],
      t1: removed.t1,
      seconds: round2(removed.t1 - segments[weakest - 1].t0),
    }
  }
  return segments.map((segment, index) => ({ ...segment, index: index + 1 }))
}

/** 可见目录：带 .png 后缀的副本，人和模型都能直接打开。 */
export function visibleDirFor(key) {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(base, 'eplan-mcp', 'video-digest', key)
}

/**
 * 抓一帧：可选裁剪/缩放，写两份（工作目录 + 可见目录）。
 *
 * 为什么默认 JPEG（q3，4:4:4 无色度抽样）而不是 PNG：实测 2880×1800 录屏截一帧
 * 缩到 1920 宽的 PNG 有 **700 KB**，6 段摘要一次进上下文就是 3.9 MB（2026-11-23
 * session-a18a4a7f 的真实数字）。同一帧 JPEG q3 只有它的 1/4，细线仍然清楚。
 * 4:4:4 是为了不让红色导线和黑色文字边缘糊掉。
 * @returns {{path:string, visiblePath:string, bytes:number, t:number, region:object, mimeType:string}}
 */
export async function grabFrame(
  path,
  meta,
  time,
  outDir,
  { name = 'frame.png', visibleDir, maxEdge = 1920, crop, format = 'jpeg', quality = 3 } = {},
) {
  const ffmpeg = findBinary('ffmpeg')
  const jpeg = format === 'jpeg'
  const base = String(name).replace(/\.(png|jpe?g)$/i, '')
  const file = join(outDir, `${base}${jpeg ? '.jpg' : '.png'}`)
  const longEdge = Math.max(meta.width, meta.height)
  const scale = longEdge > maxEdge ? `scale=${Math.round(maxEdge)}:-2` : null
  const filters = [crop, scale].filter(Boolean)
  const encode = jpeg ? ['-q:v', String(quality), '-pix_fmt', 'yuvj444p'] : []
  const region = crop ? parseCrop(crop) : { x: 0, y: 0, w: meta.width, h: meta.height }
  const result = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, time)), '-i', path,
    '-frames:v', '1', ...(filters.length > 0 ? ['-vf', filters.join(',')] : []),
    ...encode,
    '-y', file,
  ])
  if (result.code !== 0 || !existsSync(file)) {
    throw fail('VIDEO_FRAME_FAILED', `取帧失败（t=${time}）：${result.stderr.trim().slice(0, 300)}`)
  }
  let visible = file
  if (visibleDir) {
    try {
      mkdirSync(visibleDir, { recursive: true })
      visible = join(visibleDir, `${base}${jpeg ? '.jpg' : '.png'}`)
      copyFileSync(file, visible)
    } catch {
      visible = file
    }
  }
  return {
    path: file,
    visiblePath: visible,
    bytes: statSync(file).size,
    t: round2(time),
    region,
    mimeType: jpeg ? 'image/jpeg' : 'image/png',
  }
}

function parseCrop(crop) {
  const match = /^crop=(\d+):(\d+):(\d+):(\d+)$/.exec(crop)
  if (!match) return { x: 0, y: 0, w: null, h: null }
  const [, w, h, x, y] = match.map(Number)
  return { x, y, w, h }
}

/** 整段响度：判「有没有讲解」用 max，判「是不是全静音」看 mean。 */
export async function loudness(path, meta) {
  if (!meta.hasAudio) return { maxVolume: null, meanVolume: null, silent: true }
  const ffmpeg = findBinary('ffmpeg')
  const result = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'])
  const maxMatch = /max_volume:\s*(-?[0-9.]+)\s*dB/.exec(result.stderr)
  const meanMatch = /mean_volume:\s*(-?[0-9.]+)\s*dB/.exec(result.stderr)
  const maxVolume = maxMatch ? Number(maxMatch[1]) : null
  const meanVolume = meanMatch ? Number(meanMatch[1]) : null
  const silent = maxVolume === null || maxVolume < -55
  return { maxVolume, meanVolume, silent }
}

/** 抽成 16k 单声道 WAV，给语音转写用。 */
export async function extractAudio(path, meta, outDir) {
  if (!meta.hasAudio) return null
  const ffmpeg = findBinary('ffmpeg')
  const wav = join(outDir, 'audio.wav')
  const result = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', path,
    '-vn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-y', wav,
  ])
  if (result.code !== 0 || !existsSync(wav)) return null
  return { path: wav, bytes: statSync(wav).size }
}

/**
 * 语音片段：按实测响度自适应门限找静音，取静音之间的部分，过长再切开。
 *
 * 写死 -35 dB 的后果实测过：一段 248 s 录屏（mean -39 dB）只切出 1.86 s，
 * 讲解直接丢光。这里用 max_volume 往下 22 dB 作门限，并夹在 [-55, -22]。
 */
export async function speechSpans(wavPath, {
  maxVolume = null,
  minSegmentSeconds = 0.8,
  maxSegmentSeconds = 20,
  gapSeconds = 0.5,
} = {}) {
  const ffmpeg = findBinary('ffmpeg')
  const noiseDb = clamp((maxVolume ?? -20) - 22, -55, -22)
  const result = await run(ffmpeg, [
    '-hide_banner', '-nostats', '-i', wavPath,
    '-af', `silencedetect=noise=${noiseDb}dB:d=0.35`, '-f', 'null', '-',
  ])
  const silences = []
  let current = null
  for (const line of result.stderr.split('\n')) {
    const start = /silence_start:\s*(-?[0-9.]+)/.exec(line)
    const end = /silence_end:\s*(-?[0-9.]+)/.exec(line)
    if (start) current = { start: Math.max(0, Number(start[1])), end: null }
    if (end && current) { current.end = Number(end[1]); silences.push(current); current = null }
  }
  if (current) { current.end = Number.POSITIVE_INFINITY; silences.push(current) }

  const audioSeconds = (statSync(wavPath).size - 44) / 32000
  const spans = []
  let cursor = 0
  for (const silence of silences) {
    if (silence.start - cursor >= minSegmentSeconds) spans.push({ t0: cursor, t1: silence.start })
    cursor = Math.max(cursor, Number.isFinite(silence.end) ? silence.end : audioSeconds)
  }
  if (audioSeconds - cursor >= minSegmentSeconds) spans.push({ t0: cursor, t1: audioSeconds })
  if (spans.length === 0 && audioSeconds > 0) spans.push({ t0: 0, t1: audioSeconds })

  const cut = []
  for (const span of spans) {
    const length = span.t1 - span.t0
    if (length <= maxSegmentSeconds) { cut.push({ t0: round2(span.t0), t1: round2(span.t1) }); continue }
    const parts = Math.ceil(length / maxSegmentSeconds)
    const step = length / parts
    for (let index = 0; index < parts; index += 1) {
      cut.push({ t0: round2(span.t0 + index * step), t1: round2(span.t0 + (index + 1) * step) })
    }
  }
  const merged = []
  for (const segment of cut) {
    const last = merged[merged.length - 1]
    if (last && segment.t0 - last.t1 < gapSeconds && segment.t1 - last.t0 <= maxSegmentSeconds * 1.2) {
      last.t1 = segment.t1
    } else {
      merged.push({ ...segment })
    }
  }
  return { spans: merged, noiseDb, audioSeconds: round2(audioSeconds) }
}

/** WAV 头 + 16bit PCM（16k 单声道），供转写服务使用。 */
export function encodeWav(samples) {
  const header = Buffer.alloc(44)
  const dataSize = samples.length * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(16000 * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  const pcm = Buffer.alloc(dataSize)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    pcm.writeInt16LE(Math.round(clamped * 32767), index * 2)
  }
  return Buffer.concat([header, pcm])
}

/** 把整段 WAV 解成 Float32，便于按片段切。 */
export function decodeWav(buffer) {
  const int16 = new Int16Array(buffer.buffer, buffer.byteOffset + 44, (buffer.byteLength - 44) >> 1)
  const samples = new Float32Array(int16.length)
  for (let index = 0; index < int16.length; index += 1) samples[index] = int16[index] / 32768
  return samples
}

/**
 * 全流程：元信息 → 响度 → 切页 → 每页一张图 → 语音片段。
 * 转写由调用方传入（`transcribe(spans, audioPath)` 返回 [{t0,t1,text,error?}]）。
 */
export async function digest(path, {
  maxPages = 6,
  workRoot,
  transcribe,
  // 1600 宽足够看清手册上的接线图与端子号；再大只是把上下文撑满（见 grabFrame 注释）。
  maxEdge = 1600,
  frameQuality = 3,
  at = null,
} = {}) {
  const meta = await probe(path)
  const key = createHash('sha1').update(`${meta.path}:${meta.bytes}`).digest('hex').slice(0, 12)
  const outDir = workRoot ?? join(tmpdir(), 'eplan-mcp', 'video-digest', key)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const visibleDir = visibleDirFor(key)

  const series = await motionSeries(path, meta, outDir)
  const segments = planStages(series, meta, maxPages)
  const pages = []
  for (const segment of segments) {
    const time = stableTime(segment, series)
    const shot = await grabFrame(path, meta, time, outDir, {
      name: `stage-${String(segment.index).padStart(2, '0')}.png`,
      visibleDir,
      maxEdge,
      quality: frameQuality,
    })
    pages.push({ ...segment, shotAt: shot.t, shot })
  }

  const loud = await loudness(path, meta)
  let speech = { verdict: 'none', note: '这段录像没有音轨。', spans: [], transcript: [], totalSeconds: 0, coverage: 0, noiseDb: null }
  if (meta.hasAudio && !loud.silent) {
    const audio = await extractAudio(path, meta, outDir)
    if (audio) {
      const detected = await speechSpans(audio.path, { maxVolume: loud.maxVolume })
      const totalSeconds = round2(detected.spans.reduce((sum, span) => sum + (span.t1 - span.t0), 0))
      const coverage = meta.duration > 0 ? round2(totalSeconds / meta.duration) : 0
      let transcript = []
      if (transcribe && detected.spans.length > 0 && totalSeconds >= 1) {
        try {
          transcript = await transcribe(detected.spans, audio.path)
        } catch (error) {
          transcript = detected.spans.map((span) => ({ ...span, text: '', error: error.message }))
        }
      }
      speech = describeSpeech({ meta, loud, detected, transcript, totalSeconds, coverage })
    }
  }

  const extra = []
  if (at !== null && Number.isFinite(Number(at))) {
    const shot = await grabFrame(path, meta, Number(at), outDir, {
      name: 'at.png',
      visibleDir,
      maxEdge: Math.max(maxEdge, 2000),
      quality: 2,
    })
    extra.push({ t: shot.t, shot })
  }

  const text = renderDigest({ meta, pages, speech, visibleDir, extra })
  writeFileSync(join(outDir, 'digest.json'), JSON.stringify({ meta, segments, pages, loud, speech, extra }, null, 2), 'utf8')
  return { ok: true, key, meta, segments, pages, loud, speech, extra, text, workDir: outDir, visibleDir }
}

/** 判定「讲解」属于哪一种状态，并把原因写清楚 —— 空字符串绝不许悄悄过去。 */
function describeSpeech({ meta, loud, detected, transcript, totalSeconds, coverage }) {
  const base = {
    spans: detected.spans.map((span, index) => {
      const entry = transcript[index] ?? {}
      return {
        index: index + 1,
        t0: span.t0,
        t1: span.t1,
        text: String(entry.text ?? '').trim(),
        ...(entry.error ? { error: String(entry.error).slice(0, 300) } : {}),
      }
    }),
    totalSeconds,
    coverage,
    maxVolume: loud.maxVolume,
    meanVolume: loud.meanVolume,
    noiseDb: detected.noiseDb,
  }
  if (totalSeconds < 1 || detected.spans.length === 0) {
    return {
      ...base,
      transcript: [],
      verdict: 'none',
      headline: '无',
      note: `全片 ${clock(meta.duration)} 没有可识别的语音（峰值 ${loud.maxVolume} dB，门限 ${detected.noiseDb} dB）。`,
    }
  }
  const errors = base.spans.filter((span) => span.error)
  const spoken = base.spans.filter((span) => span.text && !span.error)
  if (errors.length > 0 && spoken.length === 0) {
    return { ...base, transcript: base.spans, verdict: 'failed', headline: '失败', note: errors[0].error }
  }
  if (spoken.length === 0) {
    return {
      ...base,
      transcript: base.spans,
      verdict: 'empty',
      headline: '空',
      note: `有 ${totalSeconds} 秒响动，转写结果为空（可能是噪声、按键声或外语）。`,
    }
  }
  const note = errors.length > 0 ? `部分片段转写失败（${errors.length}/${base.spans.length}）。` : null
  return { ...base, transcript: base.spans, verdict: 'transcribed', headline: null, note }
}

/** 模型看到的那段文字：结构固定，先说结论，再说图在哪。 */
export function renderDigest({ meta, pages, speech, visibleDir, extra = [] }) {
  const lines = []
  lines.push('<video-digest>')
  lines.push(`录屏 ${clock(meta.duration)} · ${meta.width}×${meta.height} · ${meta.fps ?? '?'} fps · ${pages.length} 段`)
  if (speech.verdict === 'transcribed') {
    lines.push(`讲解：${speech.transcript.filter((span) => span.text).length} 段，共 ${speech.totalSeconds} 秒（占 ${Math.round(speech.coverage * 100)}%）`)
  } else if (speech.headline) {
    lines.push(`讲解：${speech.headline}——${speech.note ?? ''}`)
  } else {
    lines.push(`讲解：${speech.note ?? '未知'}`)
  }
  lines.push('')
  lines.push('画面阶段（逐张给图，不拼图；每张是该阶段最稳的一帧，靠后取，越往后越接近成品）：')
  for (const page of pages) {
    lines.push(`  ${page.index}) ${clock(page.t0)}–${clock(page.t1)}（${page.seconds}s）第 ${page.index} 张图 @ ${clock(page.shotAt)}`)
  }
  if (extra.length > 0) {
    for (const item of extra) lines.push(`  指定时间点 ${clock(item.t)}：第 ${pages.length + 1} 张图`)
  }
  if (speech.verdict === 'transcribed') {
    lines.push('')
    lines.push('讲解原文：')
    for (const span of speech.transcript) {
      if (!span.text) continue
      lines.push(`  [${clock(span.t0)}] ${span.text}`)
    }
  }
  lines.push('')
  lines.push(`图片（可直接打开）：${visibleDir}`)
  lines.push('已预处理完毕：不要再调用 video() 抽帧、不要放大细节；需要某一时刻的整页图就用 video({path, at:秒})。')
  lines.push('</video-digest>')
  return lines.join('\n')
}

// ---- CLI ----
const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]).replace(/\\/g, '/').endsWith('/video.mjs')
if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const arg = (name, fallback) => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
  }
  const path = arg('path')
  if (!path) {
    console.error('用法：node video.mjs --path <视频> [--max-pages 6] [--at 秒] [--series]')
    process.exit(2)
  }
  try {
    if (argv.includes('--series')) {
      const meta = await probe(path)
      const outDir = join(tmpdir(), 'eplan-mcp', 'video-series', createHash('sha1').update(path).digest('hex').slice(0, 8))
      rmSync(outDir, { recursive: true, force: true })
      mkdirSync(outDir, { recursive: true })
      const series = await motionSeries(path, meta, outDir)
      const segments = planStages(series, meta, Number(arg('max-pages', 6)))
      process.stdout.write(JSON.stringify({ ok: true, meta, segments, canvas: series.canvas, strip: series.strip }) + '\n')
    } else {
      const result = await digest(path, { maxPages: Number(arg('max-pages', 6)), at: arg('at', null) })
      process.stdout.write(JSON.stringify(result) + '\n')
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? 'VIDEO_FAILED', message: error.message }) + '\n')
    process.exitCode = 1
  }
}
