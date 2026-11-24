// 工具遮蔽插件的离线测试：用假的 ctx 复刻 Cordis 的 restrict / on / effect 语义，
// 专测「apply 时还看不见的工具、之后才注册」这条真实踩过的坑。
//
// 名单从插件导入，不在测试里另抄一份 —— 抄过的那一版就和插件漂开了，
// 5 个断言一直红着没人发现（2026-11-16 修）。
//
//   node test/restrict-tools.test.mjs
import { DENY_LISTS, apply } from '../restrict-tools.js'

let failed = 0
const ok = (condition, label) => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}`)
  }
}

const REQUIRED = DENY_LISTS.required
const OPTIONAL = DENY_LISTS.optional
const ALL = [...REQUIRED, ...OPTIONAL]

const makeCtx = (known) => {
  const state = {
    known: new Set(known),
    calls: [],
    removed: [],
    info: [],
    errors: [],
    handlers: new Map(),
    dispose: null,
  }
  const tools = {
    restrict({ deny }) {
      const unknown = deny.filter((name) => !state.known.has(name))
      if (unknown.length > 0) {
        const label = unknown.map((name) => `"${name}"`).join(', ')
        throw new Error(
          `tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${label}; ` +
            `known global tools: ${[...state.known].sort().join(', ') || '(none)'}`,
        )
      }
      state.calls.push([...deny])
      return () => state.removed.push([...deny])
    },
  }
  const ctx = {
    tools,
    logger: {
      info: (message) => state.info.push(message),
      error: (message) => state.errors.push(message),
    },
    on(type, handler) {
      const list = state.handlers.get(type) ?? []
      list.push(handler)
      state.handlers.set(type, list)
    },
    effect(fn) {
      state.dispose = fn()
    },
  }
  const emit = (type, ...args) => {
    for (const handler of state.handlers.get(type) ?? []) handler(...args)
  }
  return { ctx, state, emit }
}

console.log('清单本身')
{
  ok(REQUIRED.length > 0, `必选项 ${REQUIRED.length} 个`)
  ok(OPTIONAL.length > 0, `可选项 ${OPTIONAL.length} 个`)
  ok(new Set(ALL).size === ALL.length, '两个清单没有重复')
  // preset 自己注册或实际使用的工具绝不能被遮掉，否则 PTC 里就没有对应绑定。
  const keep = ['read', 'read_image', 'ask_user_question', 'create_goal', 'get_goal',
    'update_goal', 'subagent', 'video', 'compress', 'run_code']
  ok(keep.every((name) => !ALL.includes(name)), '不遮 preset 自己要用的工具')
}

console.log('apply 时全部在场')
{
  const { ctx, state } = makeCtx(ALL)
  apply(ctx)
  ok(state.calls.length === 1, '只调一次 restrict')
  ok(ALL.every((name) => state.calls[0].includes(name)), `${ALL.length} 个名字一次盖上`)
  ok(state.errors.length === 0 && state.info.length === 0, '没有日志噪音')
}

console.log('bili 的工具晚到（真实事故场景）')
{
  const { ctx, state, emit } = makeCtx(REQUIRED)
  apply(ctx)
  ok(state.calls.length === 1 && state.calls[0].length === REQUIRED.length, `apply 期只盖上已知的 ${REQUIRED.length} 个`)
  ok(state.info.some((m) => m.includes(OPTIONAL[0])), '晚到的名字只记一次 info')
  ok(state.errors.length === 0, '可选缺席不算错误')

  // 下一轮 bili 注册完，turn/start 再扫一遍。
  state.known = new Set(ALL)
  emit('session/event', {}, { type: 'turn/start' })
  ok(state.calls.length === 2 && state.calls[1].length === OPTIONAL.length, `turn/start 补盖 ${OPTIONAL.length} 个`)
  ok(state.calls[1].every((name) => OPTIONAL.includes(name)), '补盖的只是可选项')

  emit('session/event', {}, { type: 'turn/start' })
  emit('agent/created')
  ok(state.calls.length === 2, '没有新名字时不重复调 restrict')
}

console.log('必选项缺席')
{
  const pwsh7 = 'pwsh7_status'
  const known = ALL.filter((name) => name !== pwsh7)
  const { ctx, state } = makeCtx(known)
  apply(ctx)
  // pwsh7_status 是可选插件提供的：缺席只记 info，不报红。
  ok(state.errors.length === 0, '可选插件缺席不报 red')
  ok(state.info.some((m) => m.includes(pwsh7)), '可选项缺席记 info')
}

console.log('宿主内核工具缺席要报红')
{
  const { ctx, state } = makeCtx(ALL.filter((name) => name !== 'working_directory'))
  apply(ctx)
  ok(state.errors.length === 1 && state.errors[0].includes('working_directory'), '报一次 error 并点名')
}

console.log('卸载时撤销遮蔽')
{
  const { ctx, state } = makeCtx(ALL)
  apply(ctx)
  state.dispose()
  ok(state.removed.length === 1, 'disposer 被调用')
  ok(state.removed[0].length === ALL.length, '撤销的是同一批名字')
}

console.log('没有 tools.restrict 的宿主')
{
  const { ctx, state } = makeCtx(ALL)
  delete ctx.tools.restrict
  apply(ctx)
  ok(state.calls.length === 0, '什么都不做，不抛')
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
