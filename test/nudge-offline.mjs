#!/usr/bin/env node
// experience-nudge 的离线用例。
//
// 为什么值得单独测：这段逻辑挂在 tools/execute 这个较内层的扩展点上，而且只对
// update_goal 的一个动作生效 —— 写错了不会报错，只会**永远不触发**。
// 真机验证要重启 DSH、建 goal、标完成，一轮几分钟；这里几百毫秒就能把分支走全。
//
//   node test/nudge-offline.mjs
import { apply } from '../preset/experience-nudge.js'

const handlers = new Map()
const ctx = {
  on(event, handler) {
    handlers.set(event, handler)
  },
  logger: { warn() {} },
}

apply(ctx)

const listener = handlers.get('tools/execute')
if (!listener) {
  console.error('✗ 没有注册 tools/execute 监听器')
  process.exit(1)
}

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const ORIGINAL = { content: [{ type: 'text', text: '{"ok":true}' }] }

async function run(name, args, result = ORIGINAL) {
  return listener({ name, arguments: args }, async () => result)
}

function appendedText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

// 1) complete：追加提醒，且原有内容还在
{
  const out = await run('update_goal', { action: 'complete' })
  const text = appendedText(out)
  check('complete 追加提醒', text.includes('结束前把经验留下来'))
  check('complete 不吞掉原结果', text.includes('{"ok":true}'))
  check('complete 提醒里给了 lesson 用法', text.includes('lesson'))
}

// 2) blocked（不是 block）：这是枚举里真正的值，写错就永远不触发
{
  const out = await run('update_goal', { action: 'blocked' })
  check('blocked 追加提醒', appendedText(out).includes('结束前把经验留下来'))
}

// 3) 其它动作不打扰
for (const action of ['edit', 'pause', 'resume']) {
  const out = await run('update_goal', { action })
  check(`${action} 不追加`, appendedText(out) === '{"ok":true}')
}

// 4) 别的工具完全不受影响
{
  const out = await run('page_create', { action: 'complete' })
  check('其它工具不受影响', appendedText(out) === '{"ok":true}')
}

// 5) 失败的结果不该被当成收尾
{
  const failed = { isError: true, content: [{ type: 'text', text: 'stale revision' }] }
  const out = await run('update_goal', { action: 'complete' }, failed)
  check('isError 时不追加', appendedText(out) === 'stale revision')
}

// 6) 没有 content 的结果也能安全追加
{
  const out = await run('update_goal', { action: 'complete' }, {})
  check('无 content 时不炸', appendedText(out).includes('结束前把经验留下来'))
}

// 7) next() 抛错必须原样抛出，不能被这个插件吞掉
{
  let threw = false
  try {
    await listener({ name: 'update_goal', arguments: { action: 'complete' } }, async () => {
      throw new Error('工具自己炸了')
    })
  } catch (error) {
    threw = error.message === '工具自己炸了'
  }
  check('工具异常原样抛出', threw)
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`}：${results.length - failed.length} 项通过`)
process.exit(failed.length === 0 ? 0 : 1)
