// 目标结束时的经验提醒。
//
// 为什么需要它：人设里写着「踩到坑就记一条」，但那是一句软指令 —— 模型做完事、
// 目标一标完成，就顺着收尾了，多半想不起去写经验。而经验库的价值全在于「当时写下」，
// 隔一轮再补，细节已经丢了。
//
// 为什么不用 goal/changed 事件 + agent.followup()：
//   1. followup 需要 createUserMessage（@deepseek-ai/dsh-llm），而 link: 类型的 bundle
//      里 import 不到那个包，只能手工复刻消息结构，形状一变就静默坏掉；
//   2. followup 会多起一整轮对话，还可能搅乱目标轮次计数。
// 挂在 tools/execute 上只包一层、就地追加一段文字，同一步内生效，不碰目标状态机。
//
// 提醒失败绝不能影响工具本身的返回：所以改写包在 try 里，出错就原样返回。
export const name = 'experience-nudge'

const NUDGE = [
  '',
  '---',
  '📝 结束前把经验留下来。',
  '这次如果踩到坑、发现某个参数/动作名和预想的不一样、或者验证出一条可行的做法，',
  '现在就用 `lesson { action: "add", text: "...", kind: "pitfall|recipe|decision" }` 记下来。',
  '写法是「做了什么 → 看到什么现象 → 结论」，给下一个会话看，别写「见上文」。',
  '确实没有值得记的就直接回一句「无新增经验」，不要为了凑数编。',
].join('\n')

export function apply(ctx) {
  // 只认 update_goal 的 complete / blocked：这两个动作意味着这次目标工作收尾了。
  // 注意是 blocked 不是 block —— 枚举值来自 dsh-tool-goal 的 UPDATE_ACTIONS。
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()

    try {
      if (exec?.name !== 'update_goal') return result
      const action = exec.arguments?.action
      if (action !== 'complete' && action !== 'blocked') return result
      // 目标没更新成功（比如 revision 过期）就没有收尾可言，不打扰。
      if (!result || result.isError) return result

      const content = Array.isArray(result.content) ? [...result.content] : []
      content.push({ type: 'text', text: NUDGE })
      return { ...result, content }
    } catch (error) {
      ctx.logger?.warn?.(`experience-nudge: 追加提醒失败，已忽略：${error?.message ?? error}`)
      return result
    }
  })
}
