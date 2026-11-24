// 文档与工具面的一致性检查。
//
// 为什么需要：工具改名之后，人设、四份知识文件、README 里到处是旧名字，
// 模型照着旧名字调用会直接失败，而这类漂移不会让任何测试变红。
// 这个脚本把「文档里提到的工具名」和「server.mjs 实际注册的工具名」对一遍。
//
//   node test/check-docs.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

// 1) 实际注册的工具名
const server = readFileSync(path.join(root, 'server', 'server.mjs'), 'utf8')
const registered = [...server.matchAll(/(?:regTool|registerTool)\(\s*'([a-z_]+)'/g)].map((m) => m[1])
const known = new Set(registered)

// 2) 改名后不许再出现的旧名字
const RETIRED = [
  'symbol_info',
  'symbol_insert',
  'page_open',
  'project_open',
  'project_close',
  'inspect',
  'look',
  'props',
  'check',
  'pages',
  'draw',
  'pdf',
  'status',
  'symbols',
]

const files = []
const skillsDir = path.join(root, 'skills')
if (existsSync(skillsDir)) {
  for (const name of readdirSync(skillsDir)) {
    const file = path.join(skillsDir, name, 'SKILL.md')
    if (existsSync(file)) files.push(file)
  }
}
files.push(path.join(root, 'cordis.patch.yml'))
files.push(path.join(root, 'README.md'))
files.push(path.join(root, 'INSTALL.md'))

const problems = []

for (const file of files) {
  if (!existsSync(file)) continue
  const label = path.relative(root, file)
  const lines = readFileSync(file, 'utf8').split('\n')

  lines.forEach((line, index) => {
    // 三种「看起来像旧名字、其实不是」的情况要先遮掉：
    //   1. 已经迁移的写法：workspace(action="status")
    //   2. JSON 里的参数名和取值：{"action":"status"}、{"symbols":[...]}
    //   3. 引号里的桥接器 op 名：call('status', ...)
    //   4. 文件名：symbols.json 里的 symbols 是旧工具名，但这里它只是个文件名
    const masked = line
      .replace(/\b(?:workspace|symbol_catalog|page_edit|page_inspect)\((?:action|format)="[a-z_]+"\)/g, '§')
      .replace(/"[^"]*"/g, '§')
      .replace(/'[^']*'/g, '§')
      .replace(/\b[A-Za-z0-9_-]+\.(?:jsonl?|md|mjs|cs|ps1|exe|dll|yml|png)\b/g, '§')

    for (const name of RETIRED) {
      // 前后不能是字母数字下划线连字符：避免 eplan-symbols、page_delete 之类误报。
      const pattern = new RegExp('(?<![A-Za-z0-9_-])' + name + '(?![A-Za-z0-9_-])')
      if (!pattern.test(masked)) continue
      // 退役的工具名后来又被用成了**参数名**（page_edit 的 draw[]、symbol_catalog 的
      // symbols[]）。按 JSON 写法出现（后面紧跟 : = [ 或引号）的不算「还在用旧工具名」；
      // 只要出现一次像工具调用的写法（draw( / symbols 空格…）就仍然报。
      const asParam = new RegExp('(?<![A-Za-z0-9_-])' + name + '(?=\\s*[:=\\[(])', 'g')
      const all = masked.match(new RegExp('(?<![A-Za-z0-9_-])' + name + '(?![A-Za-z0-9_-])', 'g')) ?? []
      const asParamCount = (masked.match(asParam) ?? []).length
      // 参数写法里也包含 `name(`，那种更像工具调用，单独排除掉。
      const bareCall = new RegExp('(?<![A-Za-z0-9_-])' + name + '\\s*\\(', 'g')
      const callCount = (masked.match(bareCall) ?? []).length
      if (callCount === 0 && all.length > 0 && asParamCount === all.length) continue
      problems.push(`${label}:${index + 1} 还在用旧名字 "${name}"`)
    }

    // mcp__eplan__xxx 必须真的注册过
    const prefixed = line.matchAll(/mcp__eplan__([a-z_]+)/g)
    for (const match of prefixed) {
      if (!known.has(match[1]) && match[1] !== '*') {
        problems.push(`${label}:${index + 1} 提到了未注册的工具 mcp__eplan__${match[1]}`)
      }
    }
  })
}

console.log(`实际注册工具（${registered.length}）：${registered.join(', ')}`)

if (problems.length === 0) {
  console.log(`\n文档一致性：通过（检查了 ${files.length} 个文件）`)
  process.exit(0)
}

console.log(`\n文档一致性：${problems.length} 处不一致`)
for (const problem of problems.slice(0, 40)) console.log('  ✗ ' + problem)
if (problems.length > 40) console.log(`  …还有 ${problems.length - 40} 处`)
process.exit(1)
