/**
 * 把用不到的工具从作用域里遮掉，只留 EPLAN 需要的那一小组。
 *
 * 为什么要单独挂一行插件：bash/pwsh 的安装器、工作目录、MCP 资源、goal 的创建工具
 * 都是 profile / host 级注册的；预设内部没法在 cordis.patch.yml 里逐条声明「不要」，
 * 只能在 preset 自己的作用域里用 tools.restrict 遮。
 *
 * 为什么要在三个时机各扫一遍：
 *   - apply 期：遮掉已经注册的（基础工具、pwsh7 安装器等）；
 *   - agent/created：子 agent 装配前再补一次；
 *   - turn/start：bili（billion-context）的 acp_* / decompress / search_context
 *     是在 proxy ready 之后才 tools.register 的，apply 时它们还不存在。
 * 老版本只在 apply 期点名这四个名字 → tools.restrict 抛 unknown global tool →
 * 这里把未知名字剔掉后 deny 变空 → 整次调用静默失效，一条限制都没盖上。
 * 实测 EPLAN 会话的工具表因此漏到 31/32 条（2026-11-09 复盘）。
 *
 * PTC 模式下这条更重要：SDK 声明是从「作用域内可见工具」生成的，漏进来的工具
 * 不只是多占提示词，还会变成 run_code 程序里可调用的绑定。
 *
 * 代价（必须写清楚）：decompress 被遮之后，被压缩的内容模型再也取不回来。
 * 所以压缩前要确认范围，宁可晚一点压，不要压了又想反悔。
 */

export const name = 'eplan-restrict-tools';

export const inject = ['tools'];

/**
 * 必须遮掉的宿主工具；遮不掉要报错，说明预设基线和本机环境对不上。
 * 只放真正的宿主内核工具：working_directory 由 dsh-base 的 tool-working-directory 行提供。
 *
 * 下面三个是「可选 profile 插件」才提供的，精简 bundles / 关掉 primary runtime 时会消失，
 * 不能当作基线（审计 M3）：load_workspace_dependencies 由 dsh-web-app 门控在 desktop +
 * DSH_PRIMARY_RUNTIME；pwsh7_install / pwsh7_status 来自 profile bundle @local/dsh-win-pwsh7。
 * 它们在 DENY_OPTIONAL 里照样会被遮，缺了只打 info，不报红。
 */
const DENY_REQUIRED = ['working_directory'];

/** 可选遮掉：只列本 preset 不提供的名字；preset 自己注册的 read / read_image /
 *  ask_user_question / goal_* / subagent / video / MCP 工具不要列，否则会被一起遮掉。
 *  bili 异步注册，没装或还没注册上都不算错。compress 不在里面，保留。 */
const DENY_OPTIONAL = [
  'edit', 'write', 'glob', 'grep', 'pwsh', 'skill', 'workflow',
  'todo_write', 'present', 'plugin_manager',
  'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
  'cordis_inspect_list', 'cordis_inspect_query',
  'load_workspace_dependencies', 'pwsh7_install', 'pwsh7_status',
  'subagent_fork', 'interrupt_agent', 'list_agents', 'send_message', 'wait_agent',
  'job_kill', 'job_list', 'job_output',
  'web_fetch', 'web_search',
  'ops_discover_tools', 'acp_status', 'acp_cache', 'decompress', 'search_context',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'
];

/** 测试用：导出真实清单，别让测试自己抄一份（抄过一次就跟不上插件了）。 */
export const DENY_LISTS = Object.freeze({
  required: [...DENY_REQUIRED],
  optional: [...DENY_OPTIONAL],
});

/**
 * 从 restrict 的报错里取出它不认识的名字。
 * 报错形如 `tools.restrict() names unknown global tool "a", "b"; known global
 * tools: ...` —— 分号前就是全部未知名字。
 */
const unknownNames = (error) => {
  const text = error instanceof Error ? error.message : String(error);
  if (!text.includes('names unknown global tool')) return [];
  return [...text.split(';')[0].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
};

export function apply(ctx) {
  const tools = ctx.tools;
  if (typeof tools?.restrict !== 'function') return;

  const applied = new Set();
  const missing = new Set();
  const disposers = [];
  let reportedRequired = false;
  let reportedOptional = false;

  const sweepDeny = () => {
    const wanted = [...DENY_REQUIRED, ...DENY_OPTIONAL].filter((tool) => !applied.has(tool));
    let deny = wanted;

    // 一次报错只会指出「不认识的名字」；剔掉它们再试，直到没得可遮或本轮清空。
    for (let round = 0; round < 2 && deny.length > 0; round += 1) {
      try {
        // 直接调、直接拿 disposer：包在 ctx.effect 里的话，restrict 抛出的
        // 「unknown global tool」会被 Cordis 的 effect 通道吞掉，拿不到名字。
        disposers.push(tools.restrict({ deny }));
        for (const tool of deny) {
          applied.add(tool);
          missing.delete(tool);
        }
        deny = [];
      } catch (error) {
        const unknown = unknownNames(error);
        if (unknown.length === 0) {
          ctx.logger?.error?.(`eplan: tools.restrict failed: ${String(error?.message ?? error)}`);
          return;
        }
        for (const tool of unknown) if (wanted.includes(tool)) missing.add(tool);
        deny = deny.filter((tool) => !unknown.includes(tool));
      }
    }

    if (!reportedRequired) {
      const absent = DENY_REQUIRED.filter((tool) => missing.has(tool));
      if (absent.length > 0) {
        reportedRequired = true;
        ctx.logger?.error?.(`eplan: required tool not available: ${absent.join(', ')}`);
      }
    }
    if (!reportedOptional) {
      const absent = [...missing].filter((tool) => !DENY_REQUIRED.includes(tool));
      if (absent.length > 0) {
        reportedOptional = true;
        ctx.logger?.info?.(`eplan: optional deny not present (plugin absent?): ${absent.join(', ')}`);
      }
    }
  };

  sweepDeny();
  ctx.on?.('agent/created', () => sweepDeny());
  ctx.on?.('session/event', (session, event) => {
    if (event?.type !== 'turn/start') return;
    sweepDeny();
  });

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {}
    }
  }, 'eplan: restrict tools');
}
