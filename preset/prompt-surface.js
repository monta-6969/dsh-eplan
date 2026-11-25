/**
 * EPLAN 预设的提示词收敛层（只在本 preset 的 agent 作用域内生效）。
 *
 * 本模式只有 run_code 一个直调入口，mcp__eplan__* / tools.* 都在 SDK 里。
 * 基础平面仍会注入几段与 EPLAN 无关的全局说明：
 *   - harness:identity  「You are an AI agent powered by DeepSeek Harness.」
 *   - tool:jobs         宿主 job_* 工具（本模式没挂 tool-jobs）
 *   - tool:workflow     workflow 工具（本模式没挂）
 * 用同名空 section 遮蔽；文本为空时 renderPrompt 会整段丢掉。
 *
 * 保留 tool:read / tool:goal / tool:subagent / tool:ask_user_question：
 * 这些是本模式实际挂载或实际用到的能力。
 */

export const name = 'eplan-prompt-surface'

export const inject = ['systemPrompt']

const SHADOWED = [
  ['harness:identity', 'HARNESS_IDENTITY'],
  ['tool:jobs', 'TOOL_JOBS'],
  ['tool:workflow', 'TOOL_WORKFLOW'],
  // 本模式没有终端能力（pwsh 已 deny、bash 未挂载），
  // 提示词里的 exit-code 说明只会把模型引向不存在的工具。
  ['tool:pwsh', 'TOOL_PWSH'],
  ['tool:bash', 'TOOL_BASH'],
]

export function apply(ctx) {
  const sp = ctx.systemPrompt

  for (const [section, key] of SHADOWED) {
    try {
      const order = sp.getSectionOrder(key)
      if (typeof order !== 'number') {
        ctx.logger?.warn?.(`eplan: no section order for ${key}, skip ${section}`)
        continue
      }
      ctx.effect(
        () => sp.section({ name: section, order, text: '', interpolate: false }),
        `eplan: shadow ${section}`,
      )
    } catch (error) {
      // 同层已有同名 section 时只告警，不让整个预设装配失败。
      ctx.logger?.warn?.(
        `eplan: cannot shadow ${section}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
