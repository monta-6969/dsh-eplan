// 离线验证图片额度：不需要 DSH、不需要 EPLAN。
// 造一个假 ctx，模拟「同一步里两次 video 返回 8 + 12 张图」，检查超额的图被换成路径文字。
//
//   node test/image-budget.mjs
import * as mod from '../preset/image-budget.js'

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}

// 假附件仓库：真建文件，否则算不出带后缀的副本（副本要能读源文件）。
const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const store = mkdtempSync(join(tmpdir(), 'eplan-budget-'))

// 假 ctx：收集监听器，按需要触发。
const listeners = { 'tools/post-execute': [], 'session/event': [] }
const logs = []
const ctx = {
  get(name) {
    if (name === 'attachments') {
      return {
        imageHostPath: (ref) => {
          const file = join(store, String(ref.attachmentId))
          if (!existsSync(file)) writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
          return file
        },
      }
    }
    if (name === 'fs') return { processPathFromHostPath: (path) => path }
    return undefined
  },
  on(event, handler) { (listeners[event] ??= []).push(handler) },
  logger: { info: (message) => logs.push(message), warn: () => {} },
}

check('声明了插件名', typeof mod.name === 'string' && mod.name.length > 0)
check('导出 apply', typeof mod.apply === 'function')
mod.apply(ctx)

check('挂了 post-execute 监听', listeners['tools/post-execute'].length === 1)
check('挂了 session/event 监听', listeners['session/event'].length === 1)

const image = (id) => ({ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', width: 10, height: 10 } })
const session = { header: { id: 'sess-1' } }
const agent = { session }

/** 跑一次 post-execute：默认 next() 放行，返回给定内容。 */
async function run(content, additionalContexts = []) {
  const next = async () => ({ kind: 'accept', content, additionalContexts })
  const handler = listeners['tools/post-execute'][0]
  return handler({ name: 'video', agent }, { content, isError: false }, next)
}

// 第一次：8 张图，额度 6 → 6 张留着，第 7、8 张换成文字。
const first = await run([{ type: 'text', text: '步骤' }, ...Array.from({ length: 8 }, (_, i) => image(`a${i}`))])
const keptFirst = first.content.filter((block) => block.type === 'image').length
const droppedFirst = first.content.filter((block) => block.type === 'text' && block.text.includes('没放进上下文')).length
check('第一次返回 8 张只留 6 张', keptFirst === 6, `${keptFirst} 张`)
check('被挤掉的 2 张换成文字', droppedFirst === 2, `${droppedFirst} 段`)
check(
  '文字里带带后缀的副本路径',
  first.content.some((block) => block.type === 'text' && /images[\\/]budget-.+\.png/.test(block.text)),
  first.content.filter((block) => block.type === 'text').map((block) => block.text).join(' ').slice(0, 120),
)
check('原有文字还在', first.content.some((block) => block.type === 'text' && block.text === '步骤'))

// 第二次（同一步）：额度已用完，12 张全部换成文字，且不报错。
const second = await run([...Array.from({ length: 12 }, (_, i) => image(`b${i}`))])
const keptSecond = second.content.filter((block) => block.type === 'image').length
const droppedSecond = second.content.filter((block) => block.type === 'text' && block.text.includes('没放进上下文')).length
check('同一步再要 12 张一张都进不去', keptSecond === 0, `${keptSecond} 张`)
check('12 张全部换成文字', droppedSecond === 12, `${droppedSecond} 段`)

// 步骤切换后额度恢复。
listeners['session/event'][0](session, { type: 'step/start' })
const third = await run(Array.from({ length: 3 }, (_, i) => image(`c${i}`)))
check('新一步额度恢复，3 张全部放行', third.content.filter((block) => block.type === 'image').length === 3)

// PTC 子调用的图走 additionalContexts，同样计入额度。
listeners['session/event'][0](session, { type: 'step/start' })
const sub = await run([{ type: 'text', text: 'ok' }], [
  { role: 'user', source: { kind: 'ptc-mode' }, content: Array.from({ length: 9 }, (_, i) => image(`d${i}`)) },
])
const keptSub = (sub.additionalContexts?.[0]?.content ?? []).filter((block) => block.type === 'image').length
check('additionalContexts 里的图也算额度', keptSub === 6, `${keptSub} 张`)

// 没图的工具结果原样返回（同一个对象，不改结构）。
listeners['session/event'][0](session, { type: 'step/start' })
const plain = await run([{ type: 'text', text: '纯文字' }])
check('没有图的调用不受影响', plain.content.length === 1 && plain.content[0].text === '纯文字')

// pre-step 注入的图（视频摘要）也要占额度：摘要 4 张 + 工具再要 6 张 = 10 会顶爆服务端上限，
// 所以要挡住后面 4 张。
check('挂了 pre-step 监听', (listeners['agent/pre-step'] ?? []).length === 1)
listeners['session/event'][0](session, { type: 'step/start' })
const digestMessage = { role: 'user', content: [{ type: 'text', text: '<video-digest>' }, ...Array.from({ length: 4 }, (_, i) => image(`v${i}`))] }
await (listeners['agent/pre-step'][0])(
  { agent, signal: undefined },
  async () => ({ kind: 'enter', messages: [digestMessage] }),
)
listeners['session/event'][0](session, { type: 'step/start' })
const afterDigest = await run([{ type: 'text', text: 'focus' }, ...Array.from({ length: 4 }, (_, i) => image(`g${i}`))])
const keptAfterDigest = afterDigest.content.filter((block) => block.type === 'image').length
const droppedAfterDigest = afterDigest.content.filter((block) => block.type === 'text' && block.text.includes('没放进上下文')).length
check('摘要占了 4 张额度后，工具只能再放 2 张', keptAfterDigest === 2, `${keptAfterDigest} 张`)
check('其余 2 张换成文字', droppedAfterDigest === 2, `${droppedAfterDigest} 段`)

// 没有摘要的下一步：额度恢复成 6。
listeners['session/event'][0](session, { type: 'step/start' })
const clean = await run(Array.from({ length: 6 }, (_, i) => image(`h${i}`)))
check('没有摘要的步骤额度恢复', clean.content.filter((block) => block.type === 'image').length === 6)

check('超额时写了日志', logs.length > 0, logs[0] ?? '')

const failed = checks.filter((item) => !item.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `失败 ${failed.length} 项`}：${checks.length - failed.length}/${checks.length}`)
process.exit(failed.length === 0 ? 0 : 1)
