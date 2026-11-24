#!/usr/bin/env node
// 验证「偏好分层 + 项目台账」不依赖 EPLAN。
//
// 做法同 notes-offline：EPLAN_MCP_CONFIG 指一条不存在的桥接器，LOCALAPPDATA 指到临时目录，
// 然后只用本地能力：lesson(prefer) / workspace(status) / plan_put / plan_get / claim / release。
//
//   node test/preferences-offline.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, '..', 'server', 'server.mjs')

const scratch = mkdtempSync(join(tmpdir(), 'eplan-mcp-prefs-'))
const fakeConfig = join(scratch, 'eplan.config.json')
writeFileSync(fakeConfig, JSON.stringify({ bridgeExe: join(scratch, 'no-such-bridge.exe') }, null, 2), 'utf8')

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, EPLAN_MCP_CONFIG: fakeConfig, LOCALAPPDATA: scratch },
})

let nextId = 1
const pending = new Map()
let buffer = ''

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let reply
    try {
      reply = JSON.parse(line)
    } catch {
      continue
    }
    const waiter = pending.get(reply.id)
    if (!waiter) continue
    pending.delete(reply.id)
    if (reply.error) waiter.reject(new Error(reply.error.message))
    else waiter.resolve(reply.result)
  }
})

function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

async function callTool(name, args) {
  const reply = await rpc('tools/call', { name, arguments: args })
  const text = reply?.content?.[0]?.text ?? ''
  if (reply?.isError) throw new Error(text)
  return text
}

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

await rpc('initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'eplan-preferences-offline', version: '1' },
})

const marker = `偏好用例 ${Date.now()}`

// 1) 偏好单独存
try {
  const saved = JSON.parse(await callTool('lesson', { action: 'prefer', text: marker, weight: 8, source: 'user' }))
  check('lesson.prefer 能写偏好', saved.saved === true, saved.file ?? '')
} catch (error) {
  check('lesson.prefer 能写偏好', false, error.message)
}

// 2) status 带回偏好，且与经验分开
try {
  const status = JSON.parse(await callTool('workspace', { action: 'status' }))
  const entries = status.preferences?.entries ?? []
  const found = entries.some((entry) => entry?.text === marker)
  check('status 带回偏好条目', found, `total=${status.preferences?.total ?? 0}`)
  check('偏好与经验是两个字段', status.lessons !== undefined && status.preferences !== undefined)
} catch (error) {
  check('status 带回偏好条目', false, error.message)
}

// 3) 台账：写清单、读回来
try {
  const plan = JSON.parse(
    await callTool('workspace', {
      action: 'plan_put',
      project: 'offline-test',
      items: [
        { page: '=T/1', title: '进线', status: 'done' },
        { page: '=T/2', title: '控制', status: 'todo' },
      ],
    }),
  )
  check('plan_put 写入两页', plan.count === 2, plan.file ?? '')
  const got = JSON.parse(await callTool('workspace', { action: 'plan_get', project: 'offline-test' }))
  check('plan_get 读回两页', got.count === 2 && got.entries[1]?.title === '控制')
} catch (error) {
  check('plan_put 写入两页', false, error.message)
}

// 4) 页锁：第二个人认领同一页要失败
try {
  const first = JSON.parse(await callTool('workspace', { action: 'claim', project: 'offline-test', page: '=T/1', owner: 'session-a' }))
  check('第一人认领成功', first.claimed === true)
  let blocked = false
  try {
    await callTool('workspace', { action: 'claim', project: 'offline-test', page: '=T/1', owner: 'session-b' })
  } catch {
    blocked = true
  }
  check('第二人认领同一页被拒', blocked)
  const released = JSON.parse(await callTool('workspace', { action: 'release', project: 'offline-test', page: '=T/1' }))
  check('release 释放成功', released.released === true)
  const locksFile = join(scratch, 'eplan-mcp', 'projects', 'offline-test', 'lock.json')
  check('锁文件落在项目目录', existsSync(locksFile), locksFile)
} catch (error) {
  check('第一人认领成功', false, error.message)
}

child.stdin.end()
child.kill()

const failed = results.filter((item) => !item.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`}：${results.length - failed.length} 项通过`)
process.exit(failed.length === 0 ? 0 : 1)
