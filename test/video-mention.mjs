// 端到端：用户在消息里 @ 一段录屏路径（不是文件附件）时，摘要必须自动接在后面。
//
// 为什么要这条测试：2026-11-23 session-a18a4a7f 里用户发的就是 `@C:\...\xxx_raw.mp4`，
// DSH 把它变成**纯文本**，原来只认 file 附件的实现根本没触发，模型只好自己调 video()。
// 这里用 ffmpeg 现造一段 2 秒的小视频跑完整管线（切阶段 → 抽帧 JPEG → 拼块），
// 不需要 DSH、不需要 EPLAN、不需要语音服务。
//
//   node test/video-mention.mjs
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findBinary } from '../server/video.mjs'
import * as plugin from '../video-digest.js'

let pass = 0
let fail = 0
const check = (label, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`✓ ${label}`) } else { fail += 1; console.log(`✗ ${label}${extra ? '\n  ' + extra : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'eplan-video-mention-'))
const clip = join(dir, '汇报 录屏.mp4')   // 故意带中文和空格：@ 引用本来就得支持
const made = spawnSync(findBinary('ffmpeg'), [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-shortest', '-pix_fmt', 'yuv420p', clip,
], { encoding: 'utf8', timeout: 60000 })
if (made.status !== 0 || !existsSync(clip)) {
  console.error('造不出测试视频，跳过：', String(made.stderr ?? '').slice(0, 300))
  process.exit(2)
}

// 假 ctx：attachments 把图片写到临时目录，返回引用；没有 speechToText（模拟未启用）。
const saved = []
const ctx = {
  get(name) {
    if (name === 'attachments') {
      return {
        saveImages: async (items) => items.map((item, index) => {
          const file = join(dir, `att-${saved.length + index}.img`)
          const { writeFileSync } = require('node:fs')
          writeFileSync(file, item.data)
          const ref = { attachmentId: `sha256:${saved.length + index}`, mediaType: item.mediaType, bytes: item.data.length, name: item.name }
          saved.push({ ...ref, file })
          return ref
        }),
      }
    }
    return undefined
  },
  on(event, handler) { if (event === 'agent/pre-step') this.preStep = handler },
}

const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)

plugin.apply(ctx)
check('插件挂上了 agent/pre-step', typeof ctx.preStep === 'function')
check('路径识别能处理中文+空格', JSON.stringify(plugin.videoPathsInText(`@${clip} 照这个画`)) === JSON.stringify([clip]),
  JSON.stringify(plugin.videoPathsInText(`@${clip} 照这个画`)))

const userText = `@${clip} 照这个画`
const message = { role: 'user', content: [{ type: 'text', text: userText }] }
const decision = await ctx.preStep({ signal: undefined }, async () => ({ kind: 'enter', messages: [message] }))

const blocks = decision.messages?.[0]?.content ?? []
const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text)
const images = blocks.filter((b) => b.type === 'image')
check('用户原话还在', texts[0] === userText)
check('自动接上了摘要', texts.some((t) => t.includes('<video-digest>')))
check('摘要带阶段图', images.length >= 1, `${images.length} 张`)
check('图是 JPEG（PNG 太大）', images.every((b) => b.attachment?.mediaType === 'image/jpeg'),
  JSON.stringify(images.map((b) => b.attachment?.mediaType)))
check('阶段图不超过 4 张（给符号图鉴留额度）', images.length <= 4, `${images.length} 张`)
check('摘要里写清了「不要自己抽帧」', texts.some((t) => t.includes('不要再调用 video()')))
const big = images.map((b) => b.attachment?.bytes ?? 0)
check('单张图不超过 400 KB', big.every((size) => size < 400 * 1024), JSON.stringify(big.map((n) => Math.round(n / 1024) + 'KB')))
check('没有语音服务时写明原因', texts.some((t) => t.includes('语音转写') || t.includes('讲解：')))

// 不带视频的消息原样返回（不碰）。
const plain = { role: 'user', content: [{ type: 'text', text: '继续' }] }
const untouched = await ctx.preStep({ signal: undefined }, async () => ({ kind: 'enter', messages: [plain] }))
check('普通消息原样不动', untouched.messages?.[0] === plain)

// 路径不存在时不硬跑（避免拿一个错路径去起 ffmpeg）。
const missing = { role: 'user', content: [{ type: 'text', text: '@C:\\nope\\missing.mp4 画这个' }] }
const skipped = await ctx.preStep({ signal: undefined }, async () => ({ kind: 'enter', messages: [missing] }))
check('路径不存在就跳过', skipped.messages?.[0] === missing)

console.log(`\n全部通过：${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
