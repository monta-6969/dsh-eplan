// 硬件解码的回归用例：同一段视频，走 CPU 与走硬件必须产出**逐点相同**的采样。
//
// 为什么只比采样、不比时间：不同机器的显卡/驱动冷暖差异很大，卡时间的断言
// 会变成随机失败；而「解码路径换了、结果不能变」是必须守住的契约。
// 耗时只打印出来供人看（本机 631 s 录屏实测：auto 9.7 s / off 19.2 s）。
//
//   node test/video-decode.mjs
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findBinary, motionSeries, probe, resetHardwareState } from '../server/video.mjs'

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}

const work = join(tmpdir(), `eplan-video-decode-${process.pid}`)
mkdirSync(work, { recursive: true })
const clip = join(work, 'testsrc.mp4')

try {
  const ffmpeg = findBinary('ffmpeg')
  // 12 秒、640×360、30 fps：够短，两次采样都在几秒内跑完；又真的走一遍解码。
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=12:size=640x360:rate=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip,
  ])
  check('造出测试视频', existsSync(clip))

  const meta = await probe(clip)
  check('读到元信息', meta.duration > 11 && meta.width === 640, `${meta.duration.toFixed(1)} s`)

  const runOnce = async (mode) => {
    process.env.EPLAN_MCP_HWACCEL = mode
    // 12 秒的测试片低于默认 120 秒门槛，这里把门槛降下来，
    // 否则「auto」这一跑其实还是软件解码，等于什么都没测。
    process.env.EPLAN_MCP_HWACCEL_MIN_SECONDS = '0'
    resetHardwareState()
    const started = Date.now()
    const out = await motionSeries(clip, meta, work)
    return { out, ms: Date.now() - started }
  }

  const cpu = await runOnce('off')
  const auto = await runOnce('auto')

  check('两次采样帧数一致', cpu.out.frames === auto.out.frames, `cpu ${cpu.out.frames} / auto ${auto.out.frames}`)
  const sameCanvas = JSON.stringify(cpu.out.canvas) === JSON.stringify(auto.out.canvas)
  const sameStrip = JSON.stringify(cpu.out.strip) === JSON.stringify(auto.out.strip)
  check('整屏采样逐点相同', sameCanvas, `${cpu.out.canvas.length} 点`)
  check('标题栏采样逐点相同', sameStrip, `${cpu.out.strip.length} 点`)
  console.log(`  耗时（供参考，不作断言）：cpu ${cpu.ms} ms / auto ${auto.ms} ms`)

  const failed = checks.filter((item) => !item.ok)
  console.log(`\n${failed.length === 0 ? '全部通过' : `失败 ${failed.length} 项`}：${checks.length - failed.length}/${checks.length}`)
  process.exitCode = failed.length === 0 ? 0 : 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
