// 摘要缓存与快路径的回归：同一段视频第二次调用必须不重新解码。
//
// 2026-11-24 session-400917a2 的账：同一段 12:24 录屏被 video({at:N}) 调了 5 次，
// 每次 1.1~1.8 分钟（全片解码 + 重新转写），要的其实只是某秒的一张图。合计 6.3 分钟，
// 占全程 26%。这里把「第二次不许重算」钉成断言。
//
//   node test/video-cache.mjs
import { mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findBinary, digest } from '../server/video.mjs'

/** 缓存在 workRoot/<key>/digest-cache.json；key 随文件变，所以这里按目录找。 */
function cacheFile(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, 'digest-cache.json')
    if (existsSync(candidate)) return candidate
  }
  return null
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}

const work = join(tmpdir(), `eplan-video-cache-${process.pid}`)
const workRoot = join(work, 'digest')
mkdirSync(workRoot, { recursive: true })
const clip = join(work, 'clip.mp4')

try {
  const ffmpeg = findBinary('ffmpeg')
  // 24 秒、画面在 6/12/18 秒各换一次色块：足够切出几段，又不至于跑太久。
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i',
    'testsrc=duration=24:size=640x360:rate=25',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip,
  ])
  check('造出测试视频', existsSync(clip))

  const timed = async (options) => {
    const started = Date.now()
    const out = await digest(clip, { workRoot, maxPages: 3, ...options })
    return { out, ms: Date.now() - started }
  }

  const cold = await timed({})
  check('第一次是冷启动', cold.out.cached === false)
  check('冷启动切出了阶段', cold.out.pages.length > 0, `pages=${cold.out.pages.length}`)
  check('冷启动留下缓存文件', cacheFile(workRoot) !== null)
  check('摘要正文非空', typeof cold.out.text === 'string' && cold.out.text.includes('<video-digest>'))

  const warm = await timed({})
  check('第二次命中缓存', warm.out.cached === true)
  check('命中时正文与冷启动一致', warm.out.text === cold.out.text)
  check('命中时用的还是同一批图', JSON.stringify(warm.out.pages.map((p) => p.shot.path)) === JSON.stringify(cold.out.pages.map((p) => p.shot.path)))
  console.log(`  耗时（供参考）：冷 ${cold.ms} ms / 命中 ${warm.ms} ms`)
  check('命中明显快于冷启动', warm.ms < cold.ms, `${warm.ms} ms vs ${cold.ms} ms`)

  // 关键场景：只要某一秒的图。命中缓存时这张图必须单独抓，不重跑流水线。
  const atCold = await timed({ at: 7 })
  check('命中缓存 + at 仍然是命中', atCold.out.cached === true)
  check('at 只多给一张图', atCold.out.extra.length === 1, `extra=${atCold.out.extra.length}`)
  check('at 的图真的落在指定秒附近', Math.abs(atCold.out.extra[0].t - 7) < 1.5, `t=${atCold.out.extra[0].t}`)
  check('at 的图文件存在', existsSync(atCold.out.extra[0].shot.path))
  check('at 也很快（没有重新解码）', atCold.ms < cold.ms, `${atCold.ms} ms vs ${cold.ms} ms`)

  // 段数变化：用缓存里的采样重排，不重新解码。
  const more = await timed({ maxPages: 5 })
  check('改段数仍然命中缓存', more.out.cached === true)
  check('改段数后阶段数不减', more.out.pages.length >= cold.out.pages.length, `${more.out.pages.length} vs ${cold.out.pages.length}`)

  // 文件被换了（mtime 变）就必须重算，不能吃旧缓存。
  const before = statSync(cacheFile(workRoot)).mtimeMs
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=8:size=640x360:rate=25',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip,
  ])
  const changed = await timed({})
  check('视频换内容后重新计算（mtime 进了 key）', changed.out.cached === false)
  check('重算后缓存被刷新', statSync(cacheFile(workRoot)).mtimeMs >= before)

  const failed = checks.filter((item) => !item.ok)
  console.log(`\n${failed.length === 0 ? '全部通过' : `失败 ${failed.length} 项`}：${checks.length - failed.length}/${checks.length}`)
  process.exitCode = failed.length === 0 ? 0 : 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
