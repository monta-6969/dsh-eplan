/**
 * 一步最多能带几张图：在工具这一层自己守住，别等模型服务端 400。
 *
 * 实测（2026-11-16，session-a24d40d3）：deepseek-v4.1-flash 在一条 assistant 消息之后
 * 最多接受 8 张新图。那次模型在同一步里先 video(maxFrames:8)、再 video(maxFrames:12)，
 * 20 张一起进请求，整轮直接 INVALID_REQUEST —— 程序白跑，用户只看到红字报错。
 *
 * 这个插件在 tools/post-execute 里数图，两条通路一起盖：
 *   - decision.content：普通工具结果里的图片块；
 *   - decision.additionalContexts：PTC 子调用（video 等）的图，会另起一条 user 消息进下一轮。
 * 每出现一条 step/start 就清零：服务端窗口是「最后一条 assistant 消息之后」，而每个 step
 * 就是一次新的请求。超额的图就地换成一行文字（原图路径 + 怎么看）—— 图本来已经落盘，
 * 换文字不丢信息，只是让模型下一轮用 read_image 单独看，比整轮失败好得多。
 *
 * 计数宁可偏严：子调用和顶层结果各记一次时，模型拿到的图更少但不会报错，
 * 而且每条被换掉的图都带着路径，下一轮补得回来。
 *
 * 为什么在工具层而不是提示词里：提示词只能说「别多调」，管不住模型真的调两次；
 * 这里按实际返回的图片块计数，任何来源（MCP、原生工具、子代理）都盖得住。
 */

export const name = 'eplan-image-budget'

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 一步里实际可以放进上下文的图片上限。8 是服务端硬限制，留 2 张余量给用户自己贴的图。 */
const BUDGET = 6

/** 附件 → 宿主路径 → 执行世界路径。缺服务时只给提示文字，不当成失败。 */
function imagePath(ctx, block) {
  try {
    const attachments = ctx.get('attachments')
    const fsService = ctx.get('fs')
    if (typeof attachments?.imageHostPath !== 'function') return undefined
    if (typeof fsService?.processPathFromHostPath !== 'function') return undefined
    const host = attachments.imageHostPath(block.attachment)
    if (host === undefined) return undefined
    return fsService.processPathFromHostPath(host)
  } catch {
    return undefined
  }
}

/**
 * 给用户/模型一个**带 .png 后缀**的副本路径。
 *
 * 附件仓库里的对象是 sha256 名字、没有扩展名：Windows 双击打不开，
 * 图片查看器和聊天界面预览也认不出（2026-11-16 用户反馈「这是无格式的文件」）。
 * 所以抄一份到 eplan-mcp\images\ 下，按 mediaType 补后缀。
 */
function visibleCopy(ctx, block) {
  const source = imagePath(ctx, block)
  if (!source) return undefined
  try {
    const dir = join(configDir(), 'images')
    mkdirSync(dir, { recursive: true })
    const mediaType = block.attachment?.mediaType ?? 'image/png'
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[mediaType] ?? '.png'
    const id = String(block.attachment?.attachmentId ?? Date.now()).replace(/^sha256:/, '').slice(0, 16)
    const target = join(dir, `budget-${id}${ext}`)
    if (!existsSync(target)) writeFileSync(target, readFileSync(source))
    return target
  } catch {
    return undefined
  }
}

/** 和 server.mjs 用同一个配置目录：%LOCALAPPDATA%\eplan-mcp。 */
function configDir() {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(base, 'eplan-mcp')
}

function omission(ctx, block, ordinal) {
  const path = visibleCopy(ctx, block)
  const where = path
    ? `原图已另存为 ${path}`
    : '原图这一轮没取出来'
  return {
    type: 'text',
    text: `[第 ${ordinal} 张图没放进上下文：一步最多 ${BUDGET} 张。${where}；要看就用 read_image 打开这个 .png，或下一轮再取。]`,
  }
}

const isImage = (block) => block?.type === 'image'
const hasImage = (blocks) => Array.isArray(blocks) && blocks.some(isImage)

export function apply(ctx) {
  if (typeof ctx.on !== 'function') return

  /** sessionId → 本步已放行的图片数。 */
  const spent = new Map()
  /** sessionId → 本步开始前（pre-step 注入）已经塞进消息里的图片数。 */
  const pendingPreStep = new Map()
  const keyOf = (session) => {
    const id = session?.header?.id ?? session?.id
    return id === undefined ? 'unknown' : String(id)
  }

  const countImages = (messages) => (messages ?? []).reduce(
    (sum, message) => sum + (Array.isArray(message?.content) ? message.content.filter(isImage).length : 0),
    0,
  )

  // 视频摘要是在 pre-step 里直接把图塞进消息的（video-digest.js），不经过工具结果，
  // 所以要在这里先记上，否则「摘要 4 张 + focus 4 张」= 8 张刚好顶满服务端上限，再来一张就 400。
  // prepend:true 让它排在 video-digest 外层，next() 回来时已经能看到注入后的消息。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter') return decision
    pendingPreStep.set(keyOf(payload?.agent?.session), countImages(decision.messages))
    return decision
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'step/start') return
    // pre-step 在 step/start 之前跑，所以这里才把「已经发出去的图」记进本步额度。
    const key = keyOf(session)
    const carried = pendingPreStep.get(key) ?? 0
    pendingPreStep.delete(key)
    if (carried > 0) spent.set(key, carried)
    else spent.delete(key)
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    // 只有 accept 且真的带了 content 数组才动；带 value 的决策以值为准，改 content 没用。
    if (decision?.kind !== 'accept' || !Array.isArray(decision.content)) return decision

    const content = decision.content
    const contexts = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    if (!hasImage(content) && !contexts.some((message) => hasImage(message?.content))) {
      return decision
    }

    const key = keyOf(exec?.agent?.session)
    const used = spent.get(key) ?? 0
    let budget = BUDGET - used
    let kept = 0
    let dropped = 0

    const rewrite = (blocks) => blocks.map((block) => {
      if (!isImage(block)) return block
      if (budget > 0) {
        budget -= 1
        kept += 1
        return block
      }
      dropped += 1
      return omission(ctx, block, kept + dropped)
    })

    // 先算再判断：改动只有一次，kept / dropped 也只在这次改写里累加。
    const rewrittenContent = hasImage(content) ? rewrite(content) : content
    const rewrittenContexts = contexts.map((message) => (
      hasImage(message?.content) ? { ...message, content: rewrite(message.content) } : message
    ))

    // 顶层结果与 PTC 子调用的图会分别经过这里，同一步里累计。计数偏严不会报错。
    spent.set(key, used + kept)

    if (dropped === 0) return decision

    ctx.logger?.info?.(
      `eplan: ${exec.name} 返回 ${kept + dropped} 张图，本步只剩 ${kept} 张额度，其余换成路径文字`,
    )
    return {
      ...decision,
      content: rewrittenContent,
      ...(contexts.length > 0 ? { additionalContexts: rewrittenContexts } : {}),
    }
  })
}
