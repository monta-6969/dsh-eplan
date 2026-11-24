// 视频「发送即摘要」：用户一发录屏，就在进入模型之前把它换成预处理好的摘要。
//
// 为什么不靠模型自己调 video()：
//   实测 248 s 录屏，模型拿到的是「文件句柄 + 一个 video(path) 工具」，于是一路
//   调 video、抽帧、放大、再抽帧 —— 26 步 0 页。用户要求：第一次输入就该是切分好的内容。
//
// 机制：监听 agent/pre-step（瀑布），在把消息交给模型之前，把 content 里的 file 块
// （视频附件）换成 [摘要文字 + 每个阶段一张图]。用户原来打的字保持原样。
//
// 分工：
//   server/video.mjs   —— 只算事实：探测、切阶段、取图、量响度、切语音片段
//   本文件             —— 接 DSH 服务：转写（speechToText）、存图（attachments）、改消息
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { digest as analyzeDigest, decodeWav, encodeWav } from './server/video.mjs'

export const name = 'video-digest'

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts'])
// 一步最多 8 张新图（服务端硬限制）；focus 的符号图鉴占 4 张，这里留 4 张。
const DEFAULT_MAX_IMAGES = 4

/** 附件名是不是视频。file 块只有 name / bytes / sha256，没有 mediaType。 */
function isVideoName(name) {
  return VIDEO_EXTENSIONS.has(extname(String(name ?? '')).toLowerCase())
}

/**
 * 文本里 @ 出来的视频路径。
 *
 * 为什么要有这条：真实用法是用户在输入框里打 `@C:\...\xxx.mp4`（或直接粘路径），
 * DSH 把它变成一段**纯文本**，不是 file 附件块 —— 2026-11-23 session-a18a4a7f 里
 * 第一次发录屏就是这样，于是 file 块那条路根本没触发，模型只好自己调 video()，
 * 白多一轮，图还丢了（图在 console.log 里被 JSON.stringify 掉）。
 */
export function videoPathsInText(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const EXT = 'mp4|mkv|mov|avi|wmv|flv|webm|m4v|mpe?g|ts'
  const ROOT = '(?:[A-Za-z]:[\\\\/]|\\\\\\\\)'
  // 三种写法，按可信度从高到低：
  //   ① 带引号的（路径里可以有空格）：@"D:\录像\第一讲 01.mp4"
  //   ② @ 开头的：允许空格 —— DSH 的 @ 引用本来就支持带空格的路径
  //   ③ 裸写的：不允许空格，遇到空白/引号/中文标点就停
  const patterns = [
    new RegExp(`"(${ROOT}[^"]*?\\.(?:${EXT}))"`, 'gi'),
    new RegExp(`@(${ROOT}[^\\r\\n"'<>|?*。，；、]*?\\.(?:${EXT}))\\b`, 'gi'),
    new RegExp(`(${ROOT}[^\\s"'<>|?*\\r\\n]*?\\.(?:${EXT}))\\b`, 'gi'),
  ]
  const found = []
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1].replace(/[)\]}>,.;]+$/, '')
      if (raw.length === 0) continue
      if (!found.includes(raw)) found.push(raw)
    }
  }
  return found
}


/**
 * 逐段转写。失败必须带出原因 —— 旧的实现把 error 丢掉，只留空字符串，
 * 模型看到「有音频、有 1 步、没文字」只能去抽帧猜（2026-11-23 实测）。
 */
async function transcribeSpans(ctx, spans, audioPath, { language, signal } = {}) {
  const service = ctx.get('speechToText')
  if (!service) {
    return spans.map((span) => ({ ...span, text: '', error: '本机没有语音转写服务（speechToText 未启用）' }))
  }
  const samples = decodeWav(readFileSync(audioPath))
  const out = []
  let prepared = false
  for (const span of spans) {
    const from = Math.max(0, Math.floor(span.t0 * 16000))
    const to = Math.min(samples.length, Math.ceil(span.t1 * 16000))
    if (to - from < 1600) {
      out.push({ ...span, text: '', error: '片段短于 0.1 秒' })
      continue
    }
    const audio = encodeWav(samples.subarray(from, to))
    try {
      let spec
      try {
        spec = service.resolve({ audio, ...(language ? { language } : {}) })
      } catch (error) {
        out.push({ ...span, text: '', error: `转写参数无法解析：${error.message}` })
        continue
      }
      let result
      try {
        result = await service.transcribe(spec, signal ?? new AbortController().signal)
      } catch (error) {
        if (prepared) throw error
        prepared = true
        service.prepare?.(spec.provider.info.id, {})
        result = await service.transcribe(spec, signal ?? new AbortController().signal)
      }
      const text = String(result?.text ?? '').trim()
      out.push({ ...span, text, ...(text ? {} : { error: '转写返回空文本' }) })
    } catch (error) {
      out.push({ ...span, text: '', error: String(error?.message ?? error) })
    }
  }
  return out
}

/**
 * 跑一次视频摘要并拼成 content 块（文字 + 逐张图）。
 * @returns {Promise<{blocks: object[], digest: object}>}
 */
export async function buildDigest(ctx, path, { at = null, maxImages = DEFAULT_MAX_IMAGES, language, signal } = {}) {
  const result = await analyzeDigest(path, {
    maxPages: Math.min(Math.max(maxImages, 1), 8),
    at,
    transcribe: (spans, audioPath) => transcribeSpans(ctx, spans, audioPath, { language, signal }),
  })

  // 只要「某一秒的那张图」，而且摘要是缓存命中的 → 只发那一张 + 一行说明。
  //
  // 2026-11-24 session-400917a2：模型用 video({path, at:245/500/565/700/742}) 连要 5 张图，
  // 每次都把 3.5 KB 的全量摘要重发一遍（前后 17.6 KB 重复上下文）。它要的是图，不是摘要。
  const frameOnly = at !== null && result.cached === true && result.extra.length > 0
  const shots = frameOnly
    ? result.extra.map((item) => item.shot)
    : [...result.pages.map((page) => page.shot), ...result.extra.map((item) => item.shot)]

  const attachments = ctx.get('attachments')
  const blocks = []
  let images = []
  if (attachments && shots.length > 0) {
    const asImage = (shot) => ({
      data: readFileSync(shot.path),
      mediaType: shot.mimeType ?? 'image/png',
      name: basename(shot.path),
    })
    try {
      images = await attachments.saveImages(shots.map(asImage))
    } catch (error) {
      // 图片总量超限时逐张退让，一张都进不去就只给路径 —— 绝不因此让整轮失败。
      images = []
      for (const shot of shots) {
        try {
          const [saved] = await attachments.saveImages([asImage(shot)])
          images.push(saved)
        } catch {
          break
        }
      }
      result.text += `\n（部分图片因总量限制没进上下文：${error.message}）`
    }
  }

  if (frameOnly) {
    const shotAt = result.extra[0]
    blocks.push({
      type: 'text',
      text:
        `录屏 ${clockOf(result.meta.duration)} 的 ${clockOf(shotAt.t)} 那一帧（第 1 张图）。`
        + '摘要已在上文给过，这次没有重新解码，也没有重发全文；'
        + '要看下一帧就再传一个 at 秒数。',
    })
  } else {
    blocks.push({ type: 'text', text: result.text })
  }
  for (let index = 0; index < images.length; index += 1) {
    blocks.push({ type: 'image', attachment: images[index] })
  }
  return { blocks, digest: result }
}

/** 秒 → m:ss；本地一份，别为了一个格式化去 import 整条管线。 */
function clockOf(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 摘要失败时给模型的一句话：路径留着，它还能自己试一次。 */
function failureBlocks(path, error) {
  return [{
    type: 'text',
    text: `[视频「${basename(path)}」预处理失败：${String(error?.message ?? error)}。`
      + `可以直接用 video({path:"${path}"}) 再试一次，或先问用户要关键页的截图。]`,
  }]
}

/** 同一份文件只摘要一次（用户可能在同一轮里又 @ 了一次）。 */
async function digestForPath(ctx, path, { cache, signal }) {
  const key = `path:${path.toLowerCase()}`
  const hit = cache.get(key)
  if (hit) return hit
  let entry
  try {
    entry = await buildDigest(ctx, path, { signal })
  } catch (error) {
    entry = { blocks: failureBlocks(path, error) }
  }
  cache.set(key, entry)
  return entry
}

/** 把一条用户消息里的视频附件换成摘要块；没有视频就原样返回 null。 */
async function replaceVideoBlocks(ctx, message, { cache, signal }) {
  let changed = false
  const content = []
  for (const block of message.content) {
    if (block.type !== 'file' || !isVideoName(block.attachment?.name)) {
      content.push(block)
      continue
    }
    const id = String(block.attachment.attachmentId ?? block.attachment.name)
    let entry = cache.get(id)
    if (!entry) {
      const path = ctx.get('attachments')?.fileHostPath?.(block.attachment)
      if (!path) {
        content.push({ type: 'text', text: `[视频「${block.attachment.name}」已上传，但当前环境拿不到可读路径，无法预处理。]` })
        changed = true
        continue
      }
      entry = await digestForPath(ctx, path, { cache, signal })
      cache.set(id, entry)
    }
    for (const item of entry.blocks) content.push(item)
    changed = true
  }
  return changed ? { ...message, content } : null
}

/**
 * 文本里 @ 到的视频路径：摘要接在该段文字后面，用户原话保持不动。
 * 已经带过摘要的消息不重复处理（幂等）。
 */
async function expandPathMentions(ctx, message, { cache, signal }) {
  if (!Array.isArray(message.content)) return null
  const already = message.content.some((block) => block.type === 'text' && String(block.text ?? '').includes('<video-digest>'))
  if (already) return null

  const targets = []
  for (const block of message.content) {
    if (block.type !== 'text') continue
    for (const raw of videoPathsInText(block.text)) {
      const path = isAbsolute(raw) ? raw : resolve(raw)
      if (!existsSync(path)) continue
      if (!targets.includes(path)) targets.push(path)
    }
  }
  if (targets.length === 0) return null

  const content = []
  for (const block of message.content) {
    content.push(block)
    if (block.type !== 'text') continue
    const here = videoPathsInText(block.text)
      .map((raw) => (isAbsolute(raw) ? raw : resolve(raw)))
      .filter((path) => existsSync(path))
    for (const path of [...new Set(here)]) {
      const entry = await digestForPath(ctx, path, { cache, signal })
      for (const item of entry.blocks) content.push(item)
    }
  }
  return { ...message, content }
}

export function apply(ctx) {
  const cache = new Map()
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    let touched = false
    const messages = []
    for (const message of decision.messages) {
      if (message.role !== 'user') {
        messages.push(message)
        continue
      }
      try {
        const replaced = await replaceVideoBlocks(ctx, message, { cache, signal: payload.signal })
        if (replaced) {
          messages.push(replaced)
          touched = true
          continue
        }
        const expanded = await expandPathMentions(ctx, message, { cache, signal: payload.signal })
        if (expanded) {
          messages.push(expanded)
          touched = true
          continue
        }
      } catch {
        // 摘要出任何问题都不能挡住这一轮：退回原消息，模型还有 video() 可用。
      }
      messages.push(message)
    }
    return touched ? { ...decision, messages } : decision
  }, { prepend: true })
}
