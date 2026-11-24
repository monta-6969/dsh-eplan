// 离线验证视频摘要：不需要 DSH、不需要 EPLAN。
// 用一个假的 ctx 跑真实视频，检查「切阶段 → 逐张图 → 摘要文字」这条装配线，
// 以及 server/video.mjs 里几个纯函数（切段/取帧时刻/时长格式）。
//
//   node test/video-offline.mjs [视频路径]
//
// 2026-11-23 改版：工具不再返回 JSON + 关键帧，而是返回 <video-digest> 文字 + 逐张图。
// 旧断言（digest.steps / frames / region）随之作废，这里按新契约重写。
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import * as mod from '../video-tool.js'
import { clock, planStages, renderDigest, stableTime } from '../server/video.mjs'
const { apply } = mod

/** 找一段现成的测试视频：优先命令行参数，其次桌面的 eplan 目录。 */
function pickVideo() {
  if (process.argv[2]) return process.argv[2]
  for (const folder of [join(homedir(), 'Desktop', 'eplan'), join(homedir(), 'Desktop', '工程自动化')]) {
    if (!existsSync(folder)) continue
    const found = readdirSync(folder).find((entry) => /\.(mp4|mkv|mov)$/i.test(entry))
    if (found) return join(folder, found)
  }
  return null
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}

// ── 纯函数 ────────────────────────────────────────────────────────────────
check('clock 把秒格式化成分:秒', clock(248.15) === '4:08' && clock(0) === '0:00', `${clock(248.15)}`)

// 合成一段「一页画 90 秒 → 换页 → 再画 90 秒」的采样：只有两处大变化。
const series = {
  canvas: [],
  strip: [],
}
for (let t = 1; t <= 180; t += 1) {
  const boundary = t === 90 || t === 91
  series.canvas.push({ t, mean: boundary ? 120 : 1, changed: boundary ? 0.95 : 0.01 })
  series.strip.push({ t, mean: boundary ? 140 : 0.4, changed: boundary ? 0.97 : 0.002 })
}
const SEGMENTS = planStages(series, { duration: 180 }, 4)
check('planStages 按强边界切段', SEGMENTS.length === 4 && SEGMENTS[1].t1 === 90, SEGMENTS.map((s) => `${s.t0}-${s.t1}`).join(' '))
check('planStages 覆盖全长', SEGMENTS[0].t0 === 0 && SEGMENTS[SEGMENTS.length - 1].t1 === 180)
check('planStages 段数不超过上限', planStages(series, { duration: 180 }, 1).length === 1)
check('planStages 上限 2 时也守住', planStages(series, { duration: 180 }, 2).length === 2)
const late = stableTime({ t0: 0, t1: 100, seconds: 100 }, { canvas: series.canvas.slice(0, 99) })
check('stableTime 靠后取（越画越全）', late >= 80, `t=${late}`)

const rendered = renderDigest({
  meta: { duration: 100, width: 1920, height: 1080, fps: 20 },
  pages: [{ index: 1, t0: 0, t1: 100, seconds: 100, shotAt: 60, shot: { path: 'x.png', visiblePath: 'x.png' } }],
  speech: { verdict: 'none', headline: '无', note: '全片 1:40 没有可识别的语音。', transcript: [], totalSeconds: 0, coverage: 0 },
  visibleDir: 'C:\\tmp',
})
check('摘要明说「讲解：无」', rendered.includes('讲解：无——'), '')
check('摘要逐张列图（不拼图）', rendered.includes('第 1 张图') && rendered.includes('不拼图'))
check('摘要告诉模型别再抽帧', rendered.includes('不要') && rendered.includes('video()'))
check('摘要包在 video-digest 标签里', rendered.startsWith('<video-digest>') && rendered.endsWith('</video-digest>'))

// ── 工具装配 ──────────────────────────────────────────────────────────────
const VIDEO = pickVideo()
if (!VIDEO) {
  console.log('\n跳过工具装配：没有测试视频（可以传路径：node test/video-offline.mjs <视频>）')
  const failedPure = checks.filter((item) => !item.ok)
  console.log(`${failedPure.length === 0 ? '纯函数全部通过' : `失败 ${failedPure.length} 项`}：${checks.length - failedPure.length}/${checks.length}`)
  process.exitCode = failedPure.length === 0 ? 0 : 1
} else {
  let captured = null
  const registered = {}
  const savedImages = []
  const ctx = {
    tools: {
      register: (definition) => {
        registered[definition.name] = definition
        if (definition.name === 'video') captured = definition
        return () => {}
      },
    },
    get(name) {
      if (name === 'speechToText') {
        return {
          resolve: ({ audio }) => ({ provider: { info: { id: 'fake-local' } }, audio }),
          transcribe: async () => ({ text: '这一段是讲解' }),
          prepare() {},
        }
      }
      if (name === 'attachments') {
        return {
          fileHostPath: () => VIDEO,
          saveImages: async (inputs) => inputs.map((input, index) => {
            savedImages.push(input)
            return { attachmentId: `att-${savedImages.length}-${index}`, name: input.name, bytes: input.data.byteLength }
          }),
        }
      }
      return undefined
    },
  }

  check('声明了 inject: [tools]', Array.isArray(mod.inject) && mod.inject.includes('tools'))
  apply(ctx)
  check('注册了 video 工具', captured?.name === 'video')
  check('注册了 measure 工具', registered.measure?.name === 'measure')
  check('参数要求 path', captured?.parameters?.required?.includes('path'))

  // 第一次不带 at：要的是完整摘要（阶段 + 讲解 + 图）。
  const full = await captured.execute({ path: VIDEO, maxImages: 3 }, {})
  const fullBlocks = full?.content ?? []
  const text = fullBlocks.find((block) => block.type === 'text')?.text ?? ''
  const images = fullBlocks.filter((block) => block.type === 'image')

  check('返回文字摘要', text.startsWith('<video-digest>'))
  check(`图片逐张返回（不超过 maxImages=${3}）`, images.length > 0 && images.length <= 3, `${images.length} 张`)
  check('每张图都有独立附件引用', images.every((block) => block.attachment?.attachmentId))
  check('图片张数与摘要里列的阶段数一致', (text.match(/第 \d+ 张图/g) ?? []).length === images.length,
    `文字 ${(text.match(/第 \d+ 张图/g) ?? []).length} / 图 ${images.length}`)
  check('有讲解时写「讲解：N 段」', /讲解：\d+ 段/.test(text), (text.match(/讲解：[^\n]*/) ?? [''])[0])
  check('摘要给出图片目录', text.includes('图片（可直接打开）：'))

  // 第二次带 at，且摘要已在缓存里：只该回那一张图 + 一行说明，
  // 不许把几千字的摘要再发一遍（session-400917a2 里重复发了 5 次，17.6 KB）。
  const again = await captured.execute({ path: VIDEO, maxImages: 3, at: 60 }, {})
  const againBlocks = again?.content ?? []
  const againText = againBlocks.find((block) => block.type === 'text')?.text ?? ''
  const againImages = againBlocks.filter((block) => block.type === 'image')
  if (againText.startsWith('<video-digest>')) {
    // 缓存没命中（比如临时目录被清了）：退化成完整摘要，这也是对的。
    check('at 冷启动时退回完整摘要', againImages.length > 0 && againText.includes('指定时间点'))
  } else {
    check('at 命中缓存时只回一张图', againImages.length === 1, `${againImages.length} 张`)
    check('at 命中缓存时不重发全文', againText.length < 300 && !againText.includes('画面阶段'), `${againText.length} 字符`)
    check('at 命中缓存时说明没有重新解码', againText.includes('没有重新解码'))
  }

  const failed = checks.filter((item) => !item.ok)
  console.log(`\n${failed.length === 0 ? '全部通过' : `失败 ${failed.length} 项`}：${checks.length - failed.length}/${checks.length}`)
  process.exitCode = failed.length === 0 ? 0 : 1
}
