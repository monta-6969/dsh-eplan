#!/usr/bin/env node
// 提示词预算：人设、计划模式段不能无限膨胀。
//
// 为什么要有上限：这两段每条消息都随请求下发，多 1,000 字就是每次调用多 1,000 字。
// 规则可以加，但必须删掉同样多的旧话——所以把预算写成测试，超了就红。
//
//   node test/prompt-budget.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', 'cordis.patch.yml')
const lines = readFileSync(file, 'utf8').split('\n')

// 取出某个 `key: |-` 块标量（按首行缩进去掉公共前缀），取第一个匹配。
function blockScalar(key) {
  const head = lines.findIndex((line) => new RegExp(`^\\s+${key}: \\|-$`).test(line))
  if (head < 0) throw new Error(`找不到 ${key} 块`)
  const indent = lines[head].length - lines[head].trimStart().length
  const body = []
  for (let i = head + 1; i < lines.length; i += 1) {
    const line = lines[i]
    const lead = line.length - line.trimStart().length
    if (line.trim().length === 0) {
      body.push('')
      continue
    }
    if (lead <= indent) break
    body.push(line)
  }
  const firstLead = body.find((line) => line.trim().length > 0)?.length - String(body.find((line) => line.trim().length > 0)).trimStart().length ?? 0
  return body.map((line) => (line.length === 0 ? '' : line.slice(firstLead))).join('\n').trim()
}

const persona = blockScalar('prefix')
const planning = blockScalar('section')

const checks = []
function check(label, ok, detail) {
  checks.push({ label, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

check('人设 ≤ 6000 字符', persona.length <= 6000, `${persona.length} 字符`)
check('人设不是空的', persona.length >= 800, `${persona.length} 字符`)
check('计划模式段 ≤ 1200 字符', planning.length <= 1200, `${planning.length} 字符`)
check('计划模式段要求 # 标题', planning.includes('# title') || planning.includes('# '), '')
check('人设提到 run_code 入口', persona.includes('run_code'), '')
check('人设要求交付前呈现', persona.includes('present'), '')

const failed = checks.filter((item) => !item.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`}：${checks.length - failed.length} 项通过`)
process.exit(failed.length === 0 ? 0 : 1)
