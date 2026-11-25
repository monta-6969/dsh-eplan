// video(path)：录屏 → 「阶段 + 每阶段一张图 + 讲解文字」。
//
// 现在摘要的主体在 video-digest.js（发送视频时自动跑一次），这个工具只负责两件事：
//   1. 用户后来又提到路径、或自动摘要失败时，手动跑同一套摘要；
//   2. 需要某个具体时间点的整页图时，用 at 取一张。
// 图片逐张返回，绝不拼成一张拼图（2026-11-23 用户要求）。
import { buildDigest } from './video-digest.js'

export const name = 'video-tool'

// Cordis 只有 inject 之后才会把 services 挂到 ctx 上；tools 是必须的。
// attachments / speechToText 用 ctx.get 取，取不到就降级。
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'video',
    description: [
      '录屏摘要：按画面变化切成若干阶段，每阶段给一张最稳的整页图（逐张返回，不拼图），并把讲解语音转成文字。',
      '视频在发送时已经被预处理过一次，摘要会直接出现在对话里——通常不用再调用它。',
      '摘要按「文件 + 大小 + 修改时间」缓存：命中时只做取图，不重新解码、不重新转写，秒回。',
      '只要某一秒的画面就用 at：命中缓存时只回那一张图和一行说明，不会把 3.5 KB 摘要重发一遍。',
      '没有讲解会明确写「讲解：无」；转写失败会写明原因，不要靠不断取帧来猜画面。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: '视频文件的绝对路径（mp4/mkv/mov 等 ffmpeg 能读的格式）。' },
        at: { type: 'number', description: '额外取这个时间点（秒）的一张整页图；只在需要看清某一刻时给。' },
        maxImages: { type: 'integer', description: '阶段图最多几张，默认 6，上限 8（一步最多 8 张图；自动摘要那次只用 4 张，把额度留给符号图鉴）。' },
        language: { type: 'string', description: '语音语言提示，如 zh / en；不给就用 DSH 的默认设置。' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => value.content,
    },
    async execute(args, exec) {
      const maxImages = Math.min(Math.max(args.maxImages ?? 6, 1), 8)
      const { blocks } = await buildDigest(ctx, args.path, {
        at: typeof args.at === 'number' ? args.at : null,
        maxImages,
        language: args.language,
        signal: exec?.signal,
      })
      return { content: blocks }
    },
  })

  // 量图：把截图/录屏帧里的像素换算成毫米。
  // 挂在预设工具上而不是 MCP：它跟 EPLAN 无关，也不该占 MCP 工具面的固定成本。
  ctx.tools.register({
    name: 'measure',
    description: [
      '量图：把截图或录屏帧里的像素距离换算成毫米，替代手工数字数格子。',
      '顺序：先 calibrate（两个已知点的像素坐标 + 真实毫米 → px/mm），再 edges（找竖线/横线，给出像素与 mm），',
      'grid（从线的间距推栅格/极距）。分辨率低于 8 px/mm 时 calibrate 会直接给 warning，别硬量。',
      '只量像素，不改任何文件和 EPLAN。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'action'],
      properties: {
        path: { type: 'string', description: '图片绝对路径（png/jpg/bmp 等 ffmpeg 能读的格式）。' },
        action: { type: 'string', enum: ['calibrate', 'edges', 'grid'], description: 'calibrate 定比例；edges 找线；grid 推间距。' },
        from: { type: 'array', items: { type: 'number' }, description: 'calibrate：第一点的像素坐标 [x, y]。' },
        to: { type: 'array', items: { type: 'number' }, description: 'calibrate：第二点的像素坐标 [x, y]。' },
        mm: { type: 'number', description: 'calibrate：这两点之间的真实距离（毫米）。' },
        axis: { type: 'string', enum: ['x', 'y', 'both'], description: 'edges/grid 的扫描方向，默认 both。' },
        pxPerMm: { type: 'number', description: 'edges/grid 换算用：来自 calibrate 的 pxPerMm。不给就只报像素。' },
        originPx: { type: 'array', items: { type: 'number' }, description: '像素原点 [x, y]；默认左下角 (0, 图高)。' },
        originMm: { type: 'array', items: { type: 'number' }, description: '毫米原点 [x, y]，默认 [0, 0]。' },
        flipY: { type: 'boolean', description: '图片 Y 向下、EPLAN Y 向上时翻转，默认 true。' },
        region: { type: 'array', items: { type: 'number' }, description: '只扫这个矩形 [x0, y0, x1, y1]（像素）。' },
        threshold: { type: 'number', description: '明暗跳变阈值 0-255，默认自动（Otsu）。线找不全就降到 16。' },
        minGapPx: { type: 'number', description: '相邻线的最小像素间隔，默认 3。' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => value.content,
    },
    async execute(args) {
      const { measure } = await import('../server/measure.mjs')
      const payload = await measure(args)
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
    },
  })
}
