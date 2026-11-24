// EPLAN 绘图 MCP 服务。
//
// 这个进程本身不懂 EPLAN：它只把工具调用翻译成桥接器（EplanBridge.exe）能读的
// 行协议，桥接器再用 .NET Remoting 把请求送进运行中的 EPLAN 进程。
// 真正的绘图逻辑在 script/EplanMcpBridge.cs 里，跑在 EPLAN 内部。
//
//   MCP (stdio)  ◀──▶  server.mjs  ◀──▶  EplanBridge.exe  ◀──▶  EPLAN.exe
//
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import z from 'zod'
// 载荷收敛层：只改「回给模型的形状」，不碰任何 EPLAN 行为。
import { compactInspect, geometryProblems, appearanceReport, digest, RepeatMemo } from './compact.mjs'
import { closestSymbolNames } from './fuzzy.mjs'
import { normalizeEditArgs } from './edit-args.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// 桥接器每次都编译成带时间戳的新文件（跑起来会被占用，同名覆盖必然失败），
// 所以启动时扫一遍目录取最新的那个。
function newestBridge() {
  const dir = join(root, 'bridge', 'bin')
  try {
    const candidates = readdirSync(dir)
      .filter((name) => /^EplanBridge.*\.exe$/i.test(name))
      .map((name) => ({ name, time: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
    if (candidates.length > 0) return join(dir, candidates[0].name)
  } catch {
    // 目录不存在或读不了，退回约定名，让后面的启动报错带上下文。
  }
  return join(dir, 'EplanBridge.exe')
}

const DEFAULTS = {
  bridgeExe: newestBridge(),
  eplanExe: 'D:\\EPLAN\\Platform\\2.9.4\\Bin\\Eplan.exe',
  eplanVariant: 'Electric P8',
  symbolLibrary: 'GB_symbol',
  // dark：把 EPLAN 的打印配色换成用户屏幕上的深色方案（黑底/黄符号/红导线/浅色图框）。
  renderTheme: 'dark',
  requestTimeoutMs: 290000,
}

function loadConfig() {
  // 配置放三个地方，按优先级找：
  //   1. EPLAN_MCP_CONFIG —— 测试用，指一份假配置（比如故意给个不存在的桥接器路径），
  //      验证「EPLAN 不可达时经验库仍然可用」。平时不设这个变量。
  //   2. %LOCALAPPDATA%\eplan-mcp\eplan.config.json —— setup.mjs 写在用户目录里。
  //      包目录会被 pnpm/npm 在升级时整体替换，写在那儿的话升一次级就得重跑 setup。
  //   3. 包内的 server/eplan.config.json —— 老装法（0.12 及以前）与手工调试用。
  const env = process.env.EPLAN_MCP_CONFIG
  const userFile = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'eplan-mcp', 'eplan.config.json')
    : null
  const legacyFile = join(here, 'eplan.config.json')
  const file = [env, userFile, legacyFile].find((path) => path && existsSync(path))
  if (!file) return { ...DEFAULTS }
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {
    process.stderr.write(`[eplan-mcp] ${file} 解析失败，使用默认值: ${error.message}\n`)
    return { ...DEFAULTS }
  }
}

const config = loadConfig()

// ---------------------------------------------------------------------------
// 经验库：本地文件，**不经过 EPLAN**。
//
// 为什么不放在宿主 DLL 里：`lesson` 原先走 桥接器 → EPLAN 宿主，EPLAN 没开就既读不到
// 也写不进。而 EPLAN 崩溃、被模态框卡死这两种最需要把教训记下来的时刻，恰恰就是它
// 不在正常状态的时候 —— 把经验库绑在 EPLAN 上，等于在最需要它的时候掉链子。
//
// 路径与宿主的 Paths.cs 保持一致：%LOCALAPPDATA%\eplan-mcp\knowledge\notes.jsonl。
// ---------------------------------------------------------------------------
const KNOWLEDGE_DIR = (() => {
  const base = process.env.LOCALAPPDATA
  const dir = base
    ? join(base, 'eplan-mcp', 'knowledge')
    : join(tmpdir(), 'eplan-mcp', 'knowledge')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // 建不出来就让后面的读写自己报错，那里有更具体的上下文。
  }
  return dir
})()

/** 配置根目录：%LOCALAPPDATA%\eplan-mcp。给「用户能直接打开」的图片副本用。 */
function configDir() {
  const base = process.env.LOCALAPPDATA
  return base ? join(base, 'eplan-mcp') : join(tmpdir(), 'eplan-mcp')
}

// ---------------------------------------------------------------------------
// 多用户冲突护栏。
//
// 2026-11-20 实测：同一个 Windows 用户开两个 EPLAN 实例（PID 33496 开 变频器控制、
// PID 12164 开 test），第二个实例再去开第一个实例的项目时，EPLAN 弹一个
// 「多用户冲突 / 数据库被另一用户单独锁定」的**模态框**。模态框会挡住 EPLAN 的
// 消息循环，MCP 调用只能干等到 290 秒超时，用户看到的现象是「卡死」。
//
// 桥接器（bridge\src\Program.cs:342-361）拿到多台 server 时只按 "P8" 挑第一个，
// 挑中哪个实例不确定，所以这种冲突会随机复发。这里在 open_project 之前先做两件
// 能确定的事：
//   1) 问当前连着的这个实例：项目是不是已经开着（开着就直接复用，不再开）；
//   2) 看项目的 .edb 目录里 *.lck 是否还被别的进程握着 —— EPLAN 打开项目时会一直
//      握着这些锁文件（判定方法见下面 edbLockedByOther 的注释，别用 fs.open）。
//      .lck 被占 + 本机不止一个 EPLAN ⇒ 再开必弹框，提前把话说清楚，别让调用等 290 秒。
//
// 注意：这里**不碰**锁文件本身，也不去杀进程 —— 只判断、只报错。
// ---------------------------------------------------------------------------

const DEFAULT_PROJECT_DIR = 'C:\\Users\\Public\\EPLAN\\Data\\项目\\Company name'

let eplanProcessCache = { at: 0, ids: [] }

/** 本机正在跑的 EPLAN.exe 进程号。tasklist 输出是纯 ASCII，绕开中文编码问题。 */
function eplanProcessIds() {
  if (process.platform !== 'win32') return []
  const now = Date.now()
  if (now - eplanProcessCache.at < 5000) return eplanProcessCache.ids
  let ids = []
  try {
    const out = execFileSync('tasklist', ['/NH', '/FO', 'CSV', '/FI', 'IMAGENAME eq EPLAN.exe'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    ids = String(out)
      .split(/\r?\n/)
      .map((line) => line.match(/^"EPLAN\.exe","(\d+)"/i))
      .filter((match) => match !== null)
      .map((match) => Number(match[1]))
  } catch {
    ids = []
  }
  eplanProcessCache = { at: now, ids }
  return ids
}

/** 项目名/路径 → .elk 绝对路径（和宿主的默认目录保持一致）。 */
function projectElkPath(args) {
  if (args.path) return resolve(args.path)
  return resolve(args.dir ?? DEFAULT_PROJECT_DIR, `${args.name}.elk`)
}

/** 同名 .edb 目录：EPLAN 的项目数据库，锁文件都在里面。 */
function projectEdbDir(elkPath) {
  const name = basename(elkPath).replace(/\.elk$/i, '')
  return join(dirname(elkPath), `${name}.edb`)
}

/**
 * 项目数据库的锁文件是否已经被别的进程打开。
 *
 * 不能拿 Node 的 fs.open 来判断：libuv 一律以「共享读写」打开，而 EPLAN 打开 .lck
 * 时虽然也允许别人共享读，但 .NET 默认的 FileShare.Read 会因为「对方持有写权限」
 * 而被拒 —— 两种判定相反的结论。真正稳定的判据是 FileShare.None：只要还有**任何**
 * 进程握着这个文件，独占打开就必失败。Node 的 fs 没有 share 参数，所以借一次
 * PowerShell/.NET 来问，脚本用 -EncodedCommand 传（避开中文路径的编码问题），
 * 输出只有 FREE / LOCKED:... 这种 ASCII。
 *
 * 返回 true=被占用，false=没被占用，null=问不出来（目录不存在/超时）。
 */
function edbLockedByOther(elkPath) {
  const dir = projectEdbDir(elkPath)
  if (!existsSync(dir)) return null
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$dir='${dir.replace(/'/g, "''")}'`,
    '$held=@()',
    'foreach ($f in Get-ChildItem -LiteralPath $dir -Filter *.lck -Force) {',
    "  try { $fs=[System.IO.File]::Open($f.FullName,'Open','ReadWrite','None'); $fs.Close() }",
    '  catch { $held += $f.Name }',
    '}',
    "if ($held.Count -gt 0) { 'LOCKED:' + ($held -join ',') } else { 'FREE' }",
  ].join('\n')
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const text = String(out.stdout ?? '')
    if (text.includes('LOCKED:')) return true
    if (text.trim().endsWith('FREE')) return false
    return null
  } catch {
    return null
  }
}

function samePath(a, b) {
  try {
    return resolve(a).toLowerCase() === resolve(b).toLowerCase()
  } catch {
    return false
  }
}

/**
 * 开项目之前先问清楚：这个项目是不是已经在这个实例里开着？是不是被别的实例占着？
 * 返回 { alreadyOpenHere } | { conflict } | {}
 */
async function projectPreflight(elkPath) {
  let openProjects = []
  try {
    const status = await callBridge('status', {}, { timeoutMs: 20000 })
    if (Array.isArray(status?.openProjects)) openProjects = status.openProjects
  } catch {
    // EPLAN 没开、或被别的模态框挡着：交给 project_open 自己报错，这里不抢答。
    return {}
  }

  if (openProjects.some((item) => item?.path && samePath(item.path, elkPath))) {
    return { alreadyOpenHere: true }
  }
  if (!edbLockedByOther(elkPath)) return {}

  const ids = eplanProcessIds()
  // 只有本机确实不止一个 EPLAN 时才判定成冲突：单个实例 + 锁被占更像残留句柄，
  // 那种情况让 EPLAN 自己去处理，不要拿一句「被占用」把人挡住。
  if (ids.length < 2) return { lockedButAlone: true }
  return { conflict: true, pids: ids }
}

async function openProject(args) {
  const elkPath = projectElkPath(args)
  const preflight = await projectPreflight(elkPath)

  if (preflight.alreadyOpenHere) {
    return ok({
      ok: true,
      alreadyOpen: true,
      path: elkPath,
      note: '这个项目已经在当前 EPLAN 实例里打开了，不用再开；直接切页或读页就行。',
    })
  }

  if (preflight.conflict) {
    throw fail(
      'PROJECT_LOCKED_BY_OTHER_INSTANCE',
      `项目 ${basename(elkPath)} 现在被另一个 EPLAN 实例占着（本机有 ${preflight.pids.length} 个 EPLAN：pid ${preflight.pids.join('、')}）。` +
        '这时候再开必然弹「多用户冲突 / 数据库被另一用户单独锁定」，模态框会把后面的调用一起卡死，所以没有去开。',
      '三条路选一条：① 就在已经打开它的那个 EPLAN 窗口里干活，别在这个实例里再开；' +
        '② 关掉多余的 EPLAN，只留一个实例；' +
        '③ 如果那个实例是用「专有」编辑模式打开的，在那里关掉项目、打开时把编辑模式选成「默认」重开 —— ' +
        'EPLAN 的多用户共用只在「默认」模式下成立，「专有」等于独占，别的实例一律进不来。',
    )
  }

  if (preflight.lockedButAlone) {
    process.stderr.write(
      `[eplan-mcp] ${basename(elkPath)} 的 .lck 被占着，但本机只有一个 EPLAN；照常尝试打开。\n`,
    )
  }

  return invoke('project_open', { name: args.name, path: args.path, dir: args.dir })
}

const NOTES_FILE = join(KNOWLEDGE_DIR, 'notes.jsonl')

// 旧版本把经验放在 %TEMP% 下，而临时目录会被磁盘清理扫掉 —— 搬过来，旧文件不删。
function migrateNotes() {
  try {
    if (existsSync(NOTES_FILE)) return
    const legacy = join(tmpdir(), 'eplan-mcp', 'knowledge', 'notes.jsonl')
    if (!existsSync(legacy)) return
    writeFileSync(NOTES_FILE, readFileSync(legacy))
  } catch {
    // 迁移是尽力而为，失败也只是少了几条旧记录，不该让工具调用报错。
  }
}
migrateNotes()

// 只读尾部：经验库只增不减，读全量迟早会把一次 status 拖慢。
const NOTES_SCAN_LIMIT = 500

function readNotes() {
  let text
  try {
    if (!existsSync(NOTES_FILE)) return { entries: [], truncated: false }
    text = readFileSync(NOTES_FILE, 'utf8')
  } catch {
    return { entries: [], truncated: false }
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  const truncated = lines.length > NOTES_SCAN_LIMIT
  const slice = truncated ? lines.slice(-NOTES_SCAN_LIMIT) : lines
  const entries = []
  for (const line of slice) {
    try {
      entries.push(JSON.parse(line))
    } catch {
      // 坏行跳过：一行写坏不该让整个经验库读不出来。
    }
  }
  return { entries, truncated }
}

function listNotes({ query, limit } = {}) {
  const { entries, truncated } = readNotes()
  const needle = query && String(query).trim() ? String(query).trim().toLowerCase() : null
  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20

  const matched = []
  for (let i = entries.length - 1; i >= 0 && matched.length < max; i -= 1) {
    const entry = entries[i]
    if (needle) {
      const hay = [
        entry?.text ?? '',
        entry?.kind ?? '',
        ...(Array.isArray(entry?.tags) ? entry.tags : []),
      ]
        .join(' ')
        .toLowerCase()
      if (!hay.includes(needle)) continue
    }
    matched.push(entry)
  }

  return {
    ...(needle ? { query: needle } : {}),
    total: entries.length,
    returned: matched.length,
    newestFirst: true,
    truncated,
    notes: matched,
    file: NOTES_FILE,
    ...(entries.length === 0
      ? { note: '还没有记录。踩到坑、或者验证出一条可行的做法时，用 lesson(action="add") 记一条。' }
      : {}),
  }
}

function addNote({ text, kind, tags, project, page, scope, brief }) {
  const body = typeof text === 'string' ? text.trim() : ''
  if (body.length === 0) {
    throw fail(
      'BAD_ARGUMENT',
      'text 不能为空。',
      '写一句具体的话，比如「page_open 会抢焦点，自动出图不要用它」。',
    )
  }

  const entry = {
    id: `n${Date.now()}${Math.floor(Math.random() * 1000)}`,
    at: new Date().toISOString(),
    text: body,
    kind: kind || 'pitfall',
  }
  if (Array.isArray(tags)) {
    const clean = tags.map((tag) => String(tag).trim()).filter((tag) => tag.length > 0)
    if (clean.length > 0) entry.tags = clean
  }
  // scope 决定这条经验跟着谁走：general 对所有项目生效，project 只对 project 有用，
  // preference 是要进用户偏好表的（旧文件里没有这个字段，读的时候按 general 兜底）。
  const scopeValue = ['general', 'project', 'preference'].includes(scope) ? scope : project ? 'project' : 'general'
  entry.scope = scopeValue
  const briefText = typeof brief === 'string' ? brief.trim() : ''
  entry.brief = (briefText || body).slice(0, 60)
  if (project) entry.project = project
  if (page) entry.page = page

  try {
    appendFileSync(NOTES_FILE, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (error) {
    // 静默失败最坏：模型以为记下来了，下次会话什么也读不到。
    throw fail(
      'NOTES_WRITE_FAILED',
      `经验没有写进文件：${error.message}`,
      `目标文件是 ${NOTES_FILE}。检查目录权限，或者这个位置是不是只读的。`,
    )
  }

  return { saved: true, entry, file: NOTES_FILE }
}

// status 只带最近几条，够模型一眼看到前人的教训，又不至于把上下文顶掉。
// 只回 brief（≤60 字）：经验越来越多，把全文塞进每次 status 是拿上下文换安慰。
function lessonsForStatus() {
  const { total, notes, file } = listNotes({ limit: 5 })
  return {
    total,
    recent: notes.map((entry) => ({
      at: entry?.at ?? null,
      kind: entry?.kind ?? 'pitfall',
      scope: entry?.scope ?? 'general',
      brief: entry?.brief || String(entry?.text ?? '').slice(0, 60),
    })),
    file,
  }
}

// ---------------------------------------------------------------------------
// 用户偏好：和「经验」分开存。
//
// 经验是「这条路走过，通/不通」；偏好是「这个人要什么」—— 窄版优先、画完必须
// 呈现、标注颜色怎么区分。两者混在 notes.jsonl 里，模型检索到的永远是最近 5 条
// 踩坑记录，偏好被埋掉。所以单独一份 JSON，每次 status 都带在前 10 条。
// ---------------------------------------------------------------------------
const PREFS_FILE = join(KNOWLEDGE_DIR, 'preferences.json')
const PREFS_MAX = 40

function readPreferences() {
  try {
    if (!existsSync(PREFS_FILE)) return []
    const parsed = JSON.parse(readFileSync(PREFS_FILE, 'utf8'))
    return Array.isArray(parsed?.entries) ? parsed.entries : []
  } catch {
    // 文件写坏就当没有：偏好读不出来不该让 status 失败。
    return []
  }
}

function writePreferences(entries) {
  const body = {
    version: 1,
    updatedAt: new Date().toISOString(),
    file: PREFS_FILE,
    entries,
  }
  try {
    writeFileSync(PREFS_FILE, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  } catch (error) {
    throw fail(
      'PREFS_WRITE_FAILED',
      `偏好没有写进文件：${error.message}`,
      `目标文件是 ${PREFS_FILE}。检查目录权限或磁盘状态。`,
    )
  }
  return entries
}

function addPreference({ text, source, weight, tags }) {
  const body = typeof text === 'string' ? text.trim() : ''
  if (body.length === 0) {
    throw fail('BAD_ARGUMENT', 'preference 的 text 不能为空。', '写一句用户明确表达过的偏好，例如「做完一定要切到界面给我看」。')
  }
  const entries = readPreferences()
  const index = entries.findIndex((entry) => String(entry?.text ?? '').trim() === body)
  const entry = {
    id: index >= 0 ? entries[index].id : `p${Date.now()}${Math.floor(Math.random() * 1000)}`,
    text: body,
    source: source || 'user',
    weight: Number.isInteger(weight) && weight >= 1 && weight <= 10 ? weight : 5,
    at: new Date().toISOString(),
  }
  if (Array.isArray(tags)) {
    const clean = tags.map((tag) => String(tag).trim()).filter((tag) => tag.length > 0)
    if (clean.length > 0) entry.tags = clean
  }
  if (index >= 0) entries[index] = entry
  else entries.push(entry)
  const kept = entries.slice(-PREFS_MAX)
  writePreferences(kept)
  return { saved: true, entry, total: kept.length, file: PREFS_FILE }
}

function preferencesForStatus(limit = 10) {
  const entries = readPreferences()
  return {
    total: entries.length,
    // 高权重在前，同权重新的在前。
    entries: [...entries]
      .sort((a, b) => (b?.weight ?? 5) - (a?.weight ?? 5) || String(b?.at ?? '').localeCompare(String(a?.at ?? '')))
      .slice(0, limit),
    file: PREFS_FILE,
    ...(entries.length === 0
      ? { note: '还没有记录用户偏好。用户表达过明确的做事要求时，用 lesson(action="prefer") 记一条。' }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// 项目台账：多页 / 多会话并行时，先记「谁负责哪页」，再来画。
//
// 为什么放在本地文件而不是 EPLAN 里：台账要在 EPLAN 卡死、项目没开的时候也能读；
// 而且 EPLAN 的桥已经用命名 mutex 把调用串行了，这里只解决「谁负责哪页、画到哪」。
// ---------------------------------------------------------------------------
const PROJECTS_DIR = join(KNOWLEDGE_DIR, '..', 'projects')

function projectDir(project) {
  const name = String(project ?? '').trim()
  if (name.length === 0) {
    throw fail('BAD_ARGUMENT', '台账动作需要 project。', '传项目名，例如 "test"。')
  }
  // 项目名会变成目录名：把 Windows 不允许的字符换掉，防止路径穿越。
  return join(PROJECTS_DIR, name.replace(/[\\/:*?"<>|]/g, '_'))
}

function readPlan(project) {
  const file = join(projectDir(project), 'plan.jsonl')
  try {
    if (!existsSync(file)) return { entries: [], file }
    const entries = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
      } catch {
        // 坏行跳过：一行写坏不该让整个台账读不出来。
      }
    }
    return { entries, file }
  } catch {
    return { entries: [], file }
  }
}

function writePlan(project, items) {
  const dir = projectDir(project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'plan.jsonl')
  const now = new Date().toISOString()
  const entries = items.map((item, index) => {
    const row = item && typeof item === 'object' ? { ...item } : { page: String(item) }
    return {
      index,
      page: row.page ?? row.name ?? `#${index + 1}`,
      title: row.title ?? '',
      status: row.status ?? 'todo',
      owner: row.owner ?? '',
      note: row.note ?? '',
      updatedAt: now,
    }
  })
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
  return { saved: true, count: entries.length, file, entries }
}

function readLocks(project) {
  const file = join(projectDir(project), 'lock.json')
  try {
    if (!existsSync(file)) return { pages: {}, file }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { pages: parsed?.pages ?? {}, file }
  } catch {
    return { pages: {}, file }
  }
}

function writeLocks(project, pages) {
  const dir = projectDir(project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'lock.json')
  writeFileSync(file, `${JSON.stringify({ updatedAt: new Date().toISOString(), pages }, null, 2)}\n`, 'utf8')
  return file
}

/** 占位的有效期：会话崩了或被遗忘时，六小时后自动失效，不让人永久卡死。 */
const LOCK_TTL_MS = 6 * 3600 * 1000

const lockAge = (holder) => {
  const at = Date.parse(holder?.at ?? '')
  return Number.isFinite(at) ? Date.now() - at : Infinity
}

function claimPage({ project, page, owner }) {
  if (!page) throw fail('BAD_ARGUMENT', 'claim 需要 page。', '传页名，例如 "=MI/12"。')
  const locks = readLocks(project)
  const holder = locks.pages[page]
  // 过期的占位不算占：否则一次崩掉的会话会把这一页永久锁住。
  const stale = holder !== undefined && lockAge(holder) > LOCK_TTL_MS
  if (holder && holder.owner && owner && holder.owner !== owner && !stale) {
    throw fail(
      'PAGE_LOCKED',
      `页「${page}」正被 ${holder.owner} 占着（${holder.at}）。`,
      '换一页，或等对方 release；不要两个会话同时改同一页。',
    )
  }
  locks.pages[page] = { owner: owner || 'unknown', at: new Date().toISOString() }
  const file = writeLocks(project, locks.pages)
  return { claimed: true, page, owner: locks.pages[page].owner, file, ...(stale ? { tookOverStale: page } : {}) }
}

function releasePage({ project, page }) {
  if (!page) throw fail('BAD_ARGUMENT', 'release 需要 page。', '传页名，例如 "=MI/12"。')
  const locks = readLocks(project)
  const existed = Boolean(locks.pages[page])
  delete locks.pages[page]
  const file = writeLocks(project, locks.pages)
  return { released: existed, page, file }
}

/** 只返回没过期的占位，brief 用。 */
function activeLocks(project) {
  const locks = readLocks(project)
  const live = {}
  for (const [page, holder] of Object.entries(locks.pages ?? {})) {
    if (lockAge(holder) > LOCK_TTL_MS) continue
    live[page] = holder
  }
  return live
}

/**
 * 改页/删页的占用门。
 *
 * 比 page_create 的 6 小时 TTL 短得多：建页撞车会让两边的整页定义互相覆盖，
 * 而改页撞车的代价小（重画一次就行），所以只挡「20 分钟内还活着」的占位，
 * 一个已经关掉的会话留下的旧占位不该把这一页锁半天。
 * 传给 page_edit / page_delete 的 force=true 可以明确接手。
 */
const CLAIM_GUARD_MS = 20 * 60 * 1000

function claimGuard(project, page, { force = false } = {}) {
  if (!project || !page) return null
  const locks = readLocks(project)
  const holder = locks.pages[page]
  const mine = holder?.owner === ownerTag()
  if (holder && !mine && !force && lockAge(holder) < CLAIM_GUARD_MS) {
    const minutes = Math.max(1, Math.round(lockAge(holder) / 60000))
    throw fail(
      'CLAIMED',
      `页「${page}」正被 ${holder.owner} 占着（${minutes} 分钟前）。`,
      '改别的页，或确认那个会话已经结束后传 force=true 接手；不要两个会话同时改同一页。',
    )
  }
  writeLocks(project, { ...locks.pages, [page]: { owner: ownerTag(), at: new Date().toISOString() } })
  return { claimed: true, page, ...(holder && !mine ? { tookOverFrom: holder.owner } : {}) }
}

// ---------------------------------------------------------------------------
// 桥接器进程：常驻一个子进程，按行收发 JSON。
// EPLAN 崩了或桥接器自己重启，下一次调用会重新拉起。
// ---------------------------------------------------------------------------

let bridge = null
let bridgeBuffer = ''
const pending = new Map()

function fail(code, message, detail) {
  const error = new Error(message)
  error.code = code
  if (detail !== undefined) error.detail = detail
  return error
}

function stopBridge(reason) {
  if (!bridge) return
  const child = bridge
  bridge = null
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(fail('BRIDGE_EXITED', `桥接器已退出（${reason}），本次调用中断`))
  }
  pending.clear()
  try {
    child.kill()
  } catch {
    // 已经死了，忽略。
  }
}

function startBridge() {
  if (bridge) return bridge
  if (!existsSync(config.bridgeExe)) {
    throw fail(
      'BRIDGE_MISSING',
      `找不到桥接器：${config.bridgeExe}。请先运行 bridge\\build.ps1 编译。`,
    )
  }

  const child = spawn(config.bridgeExe, [], {
    cwd: dirname(config.bridgeExe),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  bridge = child
  bridgeBuffer = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    bridgeBuffer += chunk
    let index
    while ((index = bridgeBuffer.indexOf('\n')) >= 0) {
      const line = bridgeBuffer.slice(0, index).trim()
      bridgeBuffer = bridgeBuffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        process.stderr.write(`[eplan-mcp] 桥接器输出了非 JSON 行: ${line.slice(0, 400)}\n`)
        continue
      }
      const entry = pending.get(message.id)
      if (!entry) continue
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message.result)
      else {
        const { code = 'EPLAN_ERROR', message: text = 'EPLAN 返回失败', detail } = message.error ?? {}
        entry.reject(fail(code, text, detail))
      }
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => process.stderr.write(`[eplan-bridge] ${chunk}`))
  child.on('exit', (code, signal) => stopBridge(signal ?? `exit ${code}`))
  child.on('error', (error) => stopBridge(`spawn 失败: ${error.message}`))

  return child
}

function callBridge(op, args, options = {}) {
  const child = startBridge()
  const id = randomUUID()
  const timeoutMs = options.timeoutMs ?? config.requestTimeoutMs
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(
        fail(
          'EPLAN_TIMEOUT',
          `调用 ${op} 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回。EPLAN 可能弹出了对话框或被占用，请切到 EPLAN 窗口检查后重试。`,
        ),
      )
    }, timeoutMs)

    pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
    child.stdin.write(`${JSON.stringify({ id, op, args })}\n`, (error) => {
      if (!error) return
      pending.delete(id)
      clearTimeout(timer)
      rejectPromise(fail('BRIDGE_WRITE_FAILED', `无法写入桥接器: ${error.message}`))
    })
  })
}

// ---------------------------------------------------------------------------
// 工具结果的统一形状：文本块里放 JSON，失败走 MCP 的 isError。
// ---------------------------------------------------------------------------

function ok(result) {
  // 紧凑序列化而不是 2 空格缩进：一页 inspect 的缩进部分实测占 56%
  // （80,924 → 35,865 字符），对模型没有任何信息增益。
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
}

function failed(op, error, note = null) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        // 紧凑序列化：错误体要能一眼读完，缩进在这里只有坏处。
        text: JSON.stringify({
          ok: false,
          op,
          code: error.code ?? 'UNKNOWN',
          message: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
          ...(note ?? {}),
        }),
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// 同参数同错误第二次就明说「别再试了，换这个做法」。
//
// 2026-11-24 session-400917a2：同一个不存在的符号连撞 8 次，每次 300 ms、外加一整轮
// 重新规划。重试本身不贵，贵的是它每次都以为「这次也许行」。这段不改错误、不加限制，
// 只是把「你已经在这条死路上」说出来，并给出下一步该做什么。
// ---------------------------------------------------------------------------
const REPEAT_WINDOW_MS = 5 * 60 * 1000
const repeatTally = new Map()

const REPEAT_ADVICE = {
  OBJECT_NOT_FOUND:
    '对象不在了或标识变了：先 page_inspect{format:"structure", view:"list"} 取当前的 objectId / deviceTag 再动。'
    + '整页删掉重建过之后，旧标识一定失效。',
  SYMBOL_NOT_FOUND:
    '这个名字在库里不存在，重试同一个名字不会有不同结果：改用错误里给的 candidates，'
    + '或 symbol_catalog{action:"visual"} 把候选画出来用眼睛认。',
  PAGE_EXISTS: '页已经存在：换一个页号，或直接在这页上 page_edit —— 不要再 create 同一个名字。',
  EPLAN_BLOCKED_BY_DIALOG:
    '框还压着 EPLAN，所有调用都会被挡回来：让用户切过去关掉（或按 Esc），回一句再继续。不要自己重试。',
  BAD_ARGUMENT: '参数形状不对，照错误里给的例子重写一次，不要在原参数上小改后再试。',
  PLACEMENT_NOT_FOUND: '页面上没有这个对象：先 page_inspect view="list"，别凭记忆写 id。',
  UNKNOWN_OP: '宿主不认识这个操作：EPLAN 里加载的是旧宿主，只能等 EPLAN 重启后再用。',
}

function repeatNote(op, args, error) {
  const code = error.code ?? 'UNKNOWN'
  let key
  try {
    key = `${op}|${JSON.stringify(args ?? null)}`
  } catch {
    key = `${op}|?`
  }
  const now = Date.now()
  const prev = repeatTally.get(key)
  const same = prev && prev.code === code && now - prev.at < REPEAT_WINDOW_MS
  const count = same ? prev.count + 1 : 1
  repeatTally.set(key, { code, count, at: now })
  if (repeatTally.size > 200) {
    for (const [oldKey, row] of repeatTally) {
      if (now - row.at > REPEAT_WINDOW_MS) repeatTally.delete(oldKey)
    }
  }
  if (count < 2) return null
  return {
    repeat: count,
    stopRetrying: true,
    nextStep: REPEAT_ADVICE[code] ?? '换个做法：先用 page_inspect / status 看清现场，再决定改哪一步。',
  }
}

async function invoke(op, args) {
  try {
    return ok(await callBridge(op, args))
  } catch (error) {
    return failed(op, error, repeatNote(op, args, error))
  }
}

// status 的特殊之处：EPLAN 没开时它不该整条失败。
//
// 「先看一眼环境」是每次开工的第一步，如果 EPLAN 恰好没运行就只回一个错误，
// 模型连这台机器之前踩过什么坑都看不到 —— 而经验库本来就不依赖 EPLAN。
// 所以这里把不可达也当成一种可回答的状态，附带经验一起返回。
/**
 * EPLAN 没通时的一段「照着做就行」。
 *
 * 为什么值得单独写：2026-11-23 session-a18a4a7f 里 EPLAN 起不来，模型对着
 * status / brief 连调了 5 次、8 次（重复调用提醒都触发了两次），又自己去翻
 * EPLAN 安装目录、杀进程、重新 spawn，前后烧掉 25 次调用才把环境弄起来。
 * 根因不是它笨，是 status 只说「ready:false」—— 没说下一步该做什么、也没说
 * 「别重复调我」。
 */
function notReadyFields({ message, code, processes }) {
  const steps = []
  steps.push(
    'workspace{action:"launch"} —— 用正确的工作目录拉起 EPLAN 并等 Remoting 挂起（最多 60 秒）。' +
      '不要自己 spawn EPLAN.exe：工作目录不对它会 30~90 秒后静默退出，带 .elk 参数也不会加载项目。',
  )
  steps.push(
    processes.length > 0
      ? `本机已经有 ${processes.length} 个 EPLAN（pid ${processes.join('、')}）。如果只是想连现成的那个，等 30 秒再 status 一次；启动慢是常态。`
      : '起完等 30~60 秒再 status 一次。',
  )
  steps.push('EPLAN 只有**加载了项目**才会让 API 返回 ready：不行就 workspace{action:"open_project", name:"<项目名>"}。')
  steps.push('这三步都做过还不通，就别再调 status 了：用 workspace{action:"brief"} 看本机事实，或直接问用户 EPLAN 窗口上的报错。')
  return {
    ready: false,
    blocked: true,
    doNotRetry:
      'readiness 不会因为再调一次 status 而改变。按 nextSteps 一步一来，期间不要重复调用 status / brief。',
    nextSteps: steps,
    ...(code ? { eplanCode: code } : {}),
    ...(message ? { message } : {}),
  }
}

async function statusResult() {
  let lessons
  try {
    lessons = lessonsForStatus()
  } catch {
    lessons = undefined
  }
  let preferences
  try {
    preferences = preferencesForStatus()
  } catch {
    preferences = undefined
  }

  try {
    const result = await callBridge('status', {})
    if (lessons) result.lessons = lessons
    if (preferences) result.preferences = preferences
    decorateInstances(result)
    // 桥接通了但项目没加载也是 ready:false —— 这种最容易被当成「没事」继续往下调，
    // 然后每一步都报 EPLAN_NOT_RUNNING。这里把话说透。
    if (result.ready !== true) {
      Object.assign(
        result,
        notReadyFields({
          message:
            (result.currentProject ?? null) === null
              ? 'EPLAN 连着，但没有加载任何项目（API 只在项目加载后可用）。'
              : 'EPLAN 连着，但还没就绪。',
          code: result.eplanCode,
          processes: eplanProcessIds(),
        }),
      )
      if (lessons) result.lessons = lessons
      if (preferences) result.preferences = preferences
    }
    return ok(result)
  } catch (error) {
    const payload = {
      ...notReadyFields({
        message: error.message,
        code: error.code ?? 'UNKNOWN',
        processes: eplanProcessIds(),
      }),
      eplan: {
        reachable: false,
        code: error.code ?? 'UNKNOWN',
        message: error.message,
      },
      ...(lessons ? { lessons } : {}),
      ...(preferences ? { preferences } : {}),
      hint: '经验库不依赖 EPLAN，仍然可以读写（lesson / symbol_catalog 的 lookup）。',
    }
    decorateInstances(payload)
    return ok(payload)
  }
}

/**
 * 把「本机有几个 EPLAN 在跑」告诉模型。
 *
 * 两个实例本身不是错，但同一个项目被其中一个用「专有」模式打开时，另一个再开它
 * 就会弹多用户冲突框、把调用卡到超时。这个信息放在 status 里，模型第一步就能看见，
 * 不用等到开项目失败了才知道机器上有两个窗口。
 */
function decorateInstances(result) {
  const ids = eplanProcessIds()
  if (ids.length === 0) return result
  result.eplanProcesses = ids
  if (ids.length > 1) {
    result.instancesHint =
      `本机有 ${ids.length} 个 EPLAN 实例在跑（pid ${ids.join('、')}）。同一个项目只能被其中一个用「专有」模式独占；` +
      '如果某个项目正在另一个实例里开着，在这个实例里再开它会弹「多用户冲突」并把调用卡住 —— ' +
      '要么在那个窗口里继续，要么只留一个实例，要么在打开项目时把编辑模式选「默认」。'
  }
  return result
}

/**
 * look 和别的工具不同：它把渲染出来的图**直接作为图片内容返回**。
 *
 * 为什么这样设计：模型看到的是图，不是「图片路径」。返回路径的话，
 * 每次都得再叫一次 read_image，多一轮往返，而且很容易忘了看就直接宣布画好了。
 * 一次调用同时拿到图和结构化数据，才不会出现「没看图就交活」。
 */
/**
 * 写操作 + 展示，合成一次调用。
 *
 * reveal=true 时，写完之后由服务端接着 look 出图，把渲染结果一并返回。
 *
 * 跟随（2026-11-23 用户要求「动手时自动在 EPLAN 打开并定位到当前绘图页」）：
 *   每次写成功后把那一页在 EPLAN 界面里打开（page_open），结果里带 follow 字段。
 *   以前故意不做，是因为会抢用户正在看的页；用户现在明确要这个行为，所以默认开，
 *   但**不抢窗口焦点**（focus=false），也不会因为跟随失败让这次写入失败。
 *   同一页在 2.5 秒内重复写只跟随一次；对话框挡着就记 blocked，不重试。
 */
const followOpts = { enabled: true, focus: false, throttleMs: 2500 }
let lastFollow = { page: null, at: 0 }

/** 把一页在 EPLAN 界面里打开；任何失败都只记下来，不抛。 */
async function openInEplan(page, project) {
  try {
    const shown = await callBridge('page_open', { page, project, focus: followOpts.focus === true }, { timeoutMs: 20000 })
    return { page, visibleInTitle: shown?.visibleInTitle !== false, at: new Date().toISOString() }
  } catch (error) {
    const code = String(error?.code ?? '')
    return { page, error: code === 'EPLAN_BLOCKED_BY_DIALOG' ? 'blocked-by-dialog' : String(error?.message ?? error) }
  }
}

/** 写入后跟随：只跟随本次真正碰过的那一页。 */
async function followWrite(op, args, result) {
  if (!followOpts.enabled || args?.dryRun === true || op === 'page_delete') return null
  const candidates = [
    typeof args?.page === 'string' ? args.page : null,
    typeof args?.name === 'string' ? args.name : null,
    typeof result?.page?.name === 'string' ? result.page.name : null,
    typeof result?.page === 'string' ? result.page : null,
  ]
  const page = candidates.find((value) => typeof value === 'string' && value.length > 0)
  if (!page) return null
  const now = Date.now()
  if (page === lastFollow.page && now - lastFollow.at < followOpts.throttleMs) return null
  const followed = await openInEplan(page, args?.project)
  lastFollow = { page, at: Date.now() }
  if (result && typeof result === 'object') result.follow = followed
  return followed
}

async function invokeWrite(op, args) {
  try {
    const result = await callBridge(op, args)
    await followWrite(op, args, result)
    if (!args.reveal || args.dryRun) return ok(result)

    const page = args.page ?? args.name ?? result?.page?.name ?? result?.page
    if (typeof page !== 'string' || page.length === 0) return ok(result)

    const detail = {}

    let shot = null
    try {
      shot = await callBridge('look', {
        page,
        project: args.project,
        width: args.width,
        theme: args.theme ?? config.renderTheme,
      })
      detail.imagePath = shot.imagePath
      detail.counts = shot.counts
    } catch (error) {
      detail.lookError = error.message
    }

    const merged = { ...result, reveal: detail }
    const blocks = [{ type: 'text', text: JSON.stringify(merged, null, 2) }]
    if (shot?.imagePath && existsSync(shot.imagePath)) {
      blocks.push({
        type: 'image',
        data: readFileSync(shot.imagePath).toString('base64'),
        mimeType: 'image/png',
      })
    }
    return { content: blocks }
  } catch (error) {
    return failed(op, error, repeatNote(op, args, error))
  }
}

/**
 * 渲染一页并把图直接给模型。
 *
 * 文字部分只留「这页是什么 + 图在哪 + 下一步」，不再把整份 functions 列表塞进来：
 * 实测一页 32 个对象时那条文字有 8.8 KB，其中 90% 是 `name:"=+"` 的连接定义点和
 * 每一极重复的坐标 —— 模型要的只是图，列表想看再用 format=structure view=list 要
 * （2026-11-23 session-a18a4a7f 实测，一趟绘图里这条被发了 6 次）。
 */
async function invokeLook(args) {
  try {
    const result = await callBridge('look', { ...args, theme: args.theme ?? config.renderTheme })
    // 渲染图落在临时目录、文件名是页名换成下划线：给一份可读路径，
    // 用户和模型都能直接打开，不用去翻 temp（2026-11-16 反馈）。
    const visiblePath = keepVisible(result.imagePath)
    const detailed = args.detail === true || args.view === 'full'
    const summary = detailed
      ? { ...result, visiblePath }
      : {
          page: result.page,
          project: result.project,
          pageType: result.pageType,
          pageSize: result.pageSize,
          theme: result.theme,
          imagePath: result.imagePath,
          visiblePath,
          imageBytes: result.imageBytes,
          renderMs: result.renderMs,
          counts: result.counts,
          ...(result.graphicalConnections ? { connections: result.graphicalConnections.count ?? 0 } : {}),
          hint:
            '图就是这页现在的样子，直接看。要每个对象的坐标用 page_inspect{format:"structure",view:"list"}；'
            + '要引脚相对坐标用 view:"full"；要完整原始字段给 detail:true。',
        }
    const blocks = [{ type: 'text', text: JSON.stringify(summary) }]
    const imagePath = result.imagePath
    if (args.image !== false && imagePath && existsSync(imagePath)) {
      blocks.push({
        type: 'image',
        data: readFileSync(imagePath).toString('base64'),
        mimeType: 'image/png',
      })
    }
    return { content: blocks }
  } catch (error) {
    return failed('look', error)
  }
}

/** 把渲染图抄到 %LOCALAPPDATA%\eplan-mcp\renders\，保留原文件名（已带 .png）。 */
function keepVisible(imagePath) {
  if (!imagePath || !existsSync(imagePath)) return undefined
  try {
    const dir = join(configDir(), 'renders')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, imagePath.split(/[\\/]/).pop())
    copyFileSync(imagePath, target)
    return target
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 工具定义：只留绘图流程真正需要的 8 个。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PDF：把手册的页面渲染成图，交给模型用眼睛读。
//
// 为什么不是抽文字：这本 FR-D700 手册用的是没有 ToUnicode 映射的嵌入字体，
// pdfjs 抽出来的中文全是乱码（实测 `琤慵ᢈ≥挶`）。换 Windows 自带的
// Windows.Data.Pdf 渲染成 PNG，中文清清楚楚 —— 而且电气图本来就是看图更快。
//
// 渲染交给 PowerShell 脚本（server/pdf2png.ps1）：WinRT 在 Node 里用不了，
// 而 Windows 10/11 都自带这个引擎，不需要额外装任何东西。
// ---------------------------------------------------------------------------

const PDF_RENDER_SCRIPT = join(here, 'pdf2png.ps1')
// 一次 render 最多几页：模型线路一条 assistant 消息之后只接受 8 张新图，
// 这里留余量（同样的限制在 preset 的 image-budget.js 里还兜着一层）。
const PDF_MAX_PAGES_PER_CALL = 4

function renderPdfPages(pdfPath, from, to, scale) {
  const outDir = join(tmpdir(), 'eplan-mcp', 'pdf')
  mkdirSync(outDir, { recursive: true })

  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', PDF_RENDER_SCRIPT,
      '-Pdf', pdfPath,
      '-OutDir', outDir,
      '-From', String(from),
      '-To', String(to),
      '-Scale', String(scale),
    ],
    { encoding: 'utf8', timeout: 300000, windowsHide: true },
  )

  const stdout = result.stdout ?? ''
  if (stdout.startsWith('ERROR|')) {
    const [, code, message] = stdout.trim().split('|')
    throw fail(code || 'PDF_ERROR', message || '渲染失败')
  }

  const match = stdout.match(/PAGES\|(\d+)/)
  if (!match) {
    throw fail(
      'PDF_RENDER_FAILED',
      `渲染 PDF 失败：${(result.stderr || stdout || '').slice(0, 400) || '没有输出'}`,
    )
  }

  // 路径自己算，不从 PowerShell 回读：中文路径经过管道会被控制台编码搅乱。
  const base = pdfPath.replace(/\\/g, '/').split('/').pop().replace(/\.pdf$/i, '')
  const numPages = Number(match[1])
  // 再抄一份到用户能直接双击打开的目录：临时目录里的文件名带中文页名，
  // 而且会被下一次 render 覆盖（2026-11-16 用户反馈「预览不来，这是无格式的文件」）。
  const visibleDir = join(configDir(), 'pdf-visible')
  try { mkdirSync(visibleDir, { recursive: true }) } catch {}
  const pages = []
  for (let index = from; index <= Math.min(to, numPages); index += 1) {
    const file = join(outDir, `${base}-p${String(index).padStart(3, '0')}.png`)
    if (!existsSync(file)) continue
    let visible = file
    try {
      visible = join(visibleDir, `${base}-p${String(index).padStart(3, '0')}.png`)
      copyFileSync(file, visible)
    } catch {
      visible = file
    }
    pages.push({ page: index, path: file, visiblePath: visible })
  }
  return { numPages, pages }
}

async function invokePdf(args) {
  try {
    const action = args.action ?? 'outline'
    const pdfPath = args.path

    if (action === 'outline') {
      const { pdfOutline } = await import('./pdf.mjs')
      const outline = await pdfOutline(pdfPath)
      return ok({
        path: outline.path,
        numPages: outline.numPages,
        info: outline.info,
        // 文字抽不出来的页多半是整页扫描图，只能看图。
        pagesWithoutText: outline.scannedPages.slice(0, 60),
        hint:
          '先看 outline 定页范围，再用 action="render" 把关键页画成图看内容。' +
          '如果文字抽出来是乱码，说明 PDF 没写 ToUnicode 映射，直接看渲染图即可。',
      })
    }

    if (action === 'search') {
      const { pdfSearch } = await import('./pdf.mjs')
      const result = await pdfSearch(pdfPath, args.queries)
      if (result.hits.length === 0) {
        return ok({
          ...result,
          hint: '一个都没搜到。可能是这本 PDF 的文字层是乱码（没有 ToUnicode 映射），搜不了；改用 action="render" 逐页看图。',
        })
      }
      return ok(result)
    }

    if (action === 'render') {
      const from = args.from ?? 1
      let to = args.to ?? from
      if (to - from + 1 > PDF_MAX_PAGES_PER_CALL) to = from + PDF_MAX_PAGES_PER_CALL - 1

      const { numPages, pages } = renderPdfPages(pdfPath, from, to, args.scale ?? 2)
      const blocks = [
        {
          type: 'text',
          text: JSON.stringify(
            {
              path: pdfPath,
              numPages,
              rendered: pages.map((page) => page.page),
              imagePaths: pages.map((page) => page.visiblePath ?? page.path),
              tempPaths: pages.map((page) => page.path),
              note:
                `一次最多渲染 ${PDF_MAX_PAGES_PER_CALL} 页；要看更多就再调一次，换 from/to。` +
                'imagePaths 是带 .png 后缀、可直接双击打开的副本；tempPaths 是临时文件，会被下次渲染覆盖。',
            },
            null,
            2,
          ),
        },
      ]

      for (const page of pages) {
        blocks.push({
          type: 'image',
          data: readFileSync(page.path).toString('base64'),
          mimeType: 'image/png',
        })
      }
      return { content: blocks }
    }

    throw fail('BAD_ARGUMENT', `不认识的 action：${action}。只支持 outline / search / render。`)
  } catch (error) {
    return failed('pdf', error)
  }
}

const server = new McpServer({ name: 'eplan', version: '0.1.0' })

const point = z.array(z.number()).length(2).describe('页面坐标 [x, y]，单位 mm')

// 每个工具都带这个参数：避免误写到用户正在画的那个项目上。
// 宿主侧的 Context.Resolve 只认「已打开」的项目，名字对不上直接报错，不会猜。
const project = z
  .string()
  .optional()
  .describe('目标项目名（如 test）或 .elk 完整路径。省略则用 EPLAN 当前激活的项目。写操作建议显式指定。')

// 写完立刻出图。默认关闭，因为纯数据操作不需要图。
// 注意它**只出图、不切页**：切页会把用户正看着的界面换掉，那属于 open_page 的职责。
const reveal = z
  .boolean()
  .optional()
  .describe('写完后把这一页渲染成图一并返回（不切换 EPLAN 里当前显示的页）。默认 false；想看图时设 true')

const width = z
  .number()
  .int()
  .min(400)
  .max(8000)
  .optional()
  .describe('reveal 出图的像素宽度，默认 2000')

// ---------------------------------------------------------------------------
// 十二个工具。分四类：看（workspace / symbol_catalog / page_inspect）、
// 画（page_create / page_edit / page_delete）、验收与交付（validate / export）、
// 文档与历史（manual / operation_history / operation_rollback）。
//
// 为什么是 11 不是 16：同类功能给一个入口，模型少记一套名字。合并只发生在这一层，
// 底下调用的宿主 op 一个都没改名 —— 那些是真机验证过的行为，动它没有收益只有风险。
//
// 每个带 action/format 的工具用「扁平 schema + handler 内校验」而不是
// discriminatedUnion：MCP 客户端的 schema 投影对联合类型支持不一致，
// 扁平结构在任何客户端都能正确显示参数，缺字段时报错信息还能教下一步。
// ---------------------------------------------------------------------------

/** 必填项检查：缺了就抛一个教下一步的错误。 */
function need(args, fields, action, example) {
  const missing = fields.filter((field) => args[field] === undefined || args[field] === null || args[field] === '')
  if (missing.length > 0) {
    throw fail(
      'BAD_ARGUMENT',
      `action="${action}" 缺少必填参数：${missing.join('、')}。`,
      `这个 action 需要 ${fields.join('、')}。${example ? `照这个写：${example}` : '完整参数见工具描述。'}`,
    )
  }
}

/**
 * page_edit 的参数归一化在 server/edit-args.mjs（纯函数，单独测）。
 * 这里只留一句调用，别再往本文件里堆同义词判断。
 */

// ---------------------------------------------------------------------------
// 工具面收口 + 「一次拿全」。
//
// 12 个工具常驻的 schema 实测 17,379 字符，而一次会话通常只做四类活之一：
// 画页、改页、验收、查库。模型手里攥着「改页」用不到的工具说明，既占提示词，
// 也容易让它绕远路（比如为了看状态去翻 server.mjs）。所以按模式 enable/disable，
// 切换时发 tools/list 变更通知——这是 SDK 注册句柄的真实停用，不是文字游戏：
// 停用的工具会从 tools/list 消失，也不再进 PTC 的 SDK 声明。
//
// 顺带解决另一个实测问题：技能文件在会话 cwd 下读不到。这里返回的一律是绝对路径。
// ---------------------------------------------------------------------------

const toolHandles = new Map()

function regTool(name, definition, handler) {
  // 把抛出来的错误统一成 {ok:false, code, message, detail}。
  // 不包这一层，SDK 只把 message 文本带出去，code（CLAIMED / BAD_ARGUMENT）
  // 就丢了，模型也没法照着 detail 改参数。
  const wrapped = async (...callArgs) => {
    try {
      return await handler(...callArgs)
    } catch (error) {
      return failed(name, error)
    }
  }
  const handle = server.registerTool(name, definition, wrapped)
  if (handle !== undefined && handle !== null) toolHandles.set(name, handle)
  return handle
}

const SKILL_ROOT = join(root, 'skills')

/** 页名 → 页面尺寸（mm）。validate 的越界检查要用，从 pages 顺手缓存。 */
const pageSizeCache = new Map()

// 同页单飞 + 幂等：实测一次会话里同一页被 page_create 建了 6 次、其中三次
// 输出字节级相同（4748/10826/10612/1056），纯粹是重复劳动。
const createInflight = new Map()
const createMemo = new Map()
const CREATE_IDEMPOTENT_MS = 3 * 60 * 1000

const ownerTag = () => `mcp:${process.pid}`

// ---------------------------------------------------------------------------
// 常驻元件热表
//
// 为什么要有：PTC 每次 run_code 都是新进程，上一步查到的引脚坐标不会自动变成
// 下一步可用的记忆；一页十几个符号就是十几次 symbol_catalog 往返。这里把本机
// 实测过的引脚几何放进提示词常驻区：基线 8 条永远在，其余按使用频率动态进表。
// 引脚写成 0 基下标：`0:(0,4)↑` = 第 0 个连接点位于 (0,4) mm、朝上。
// ---------------------------------------------------------------------------
const SYMBOL_USAGE_FILE = join(KNOWLEDGE_DIR, 'symbol-usage.json')

/** 基线：接线图里几乎每页都要用的节点与中断点（本机 SPECIAL / GB_symbol 实测）。 */
const COMMON_SYMBOLS = [
  { s: 'BP', lib: 'SPECIAL', v: '1/3/5/7', p: '0:(0,-1)↑ 1:(0,-1)↓', use: '中断点（竖排）' },
  { s: 'CO', lib: 'SPECIAL', v: '0', p: '0:(0,0)→ 1:(0,0)↓', use: '连接点' },
  { s: 'TLRU', lib: 'SPECIAL', v: '0/2', p: '0:(0,0)↓ 1:(0,0)← 2:(2,0)→', use: 'T 节点（左→右，下引）' },
  { s: 'TOUR', lib: 'SPECIAL', v: '0/2', p: '0:(0,0)↓ 1:(0,0)↑ 2:(2,0)→', use: 'T 节点（上下通，右引）' },
  { s: 'TLRO', lib: 'SPECIAL', v: '0/2', p: '0:(0,0)↑ 1:(0,0)← 2:(2,0)→', use: 'T 节点（左→右，上引）' },
  { s: 'TOUL', lib: 'SPECIAL', v: '0/2', p: '0:(0,0)↓ 1:(0,0)↑ 2:(-2,0)←', use: 'T 节点（上下通，左引）' },
  { s: 'CDPST', lib: 'SPECIAL', v: '0', p: '0:(0,4)↑ 1:(0,-4)↓', use: '电源引入点（上下各 4 mm）' },
  {
    s: 'FA3', lib: 'GB_symbol', v: '0',
    p: '0:(0,4)↑ 1:(0,-4)↓ 2:(8,4)↑ 3:(8,-4)↓ 4:(16,4)↑ 5:(16,-4)↓',
    use: '三极空开/断路器（极距 8 mm）',
  },
]

/** 常用 action 的必填参数（实测报错里拿到的），放在 focus 返回里省掉试错。 */
const ACTION_PARAMS = {
  page: [
    'workspace.focus{mode} brief{} status{}',
    'workspace.create_project{name} open_project{name|path} open_page{page} launch{project}',
    'page_create{page,nodes[]} page_inspect{page} validate{page}',
    'page_edit.box{page,from,to} insert_symbol{page,insert{symbol,at}} relabel{page,deviceTag}',
    'symbol_catalog.search{filter} pins{symbols[]} visual{symbols[]}',
  ],
  edit: [
    'workspace.focus{mode} brief{}',
    'page_edit.box{page,from,to} insert_symbol{page,insert{symbol,at}}',
    'page_edit.relabel{page,select{deviceTag},to} relocate{page,select{objectId},at}',
    'page_edit.delete_placement{page,deviceTag} draw_graphics{page,draw[]}',
  ],
  check: ['validate{page} page_inspect{page} export{pages|page,kind}'],
  lib: ['symbol_catalog.search{filter} visual{symbols[]} pins{symbols[]} lookup{symbol} annotate{symbol,concept}'],
}

function readSymbolUsage() {
  try {
    return JSON.parse(readFileSync(SYMBOL_USAGE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

let usageCache = null
function symbolUsage() {
  if (usageCache) return usageCache
  usageCache = readSymbolUsage()
  return usageCache
}

/** 记一次符号使用：pins 查过、或成功插入过都算。频率决定热表里的位置。 */
function recordSymbolUse(names, library) {
  if (!Array.isArray(names) || names.length === 0) return
  const usage = symbolUsage()
  const now = Date.now()
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) continue
    const key = `${library ?? ''}|${name}`
    const row = usage[key] ?? { name, library: library ?? null, count: 0, lastAt: 0 }
    row.count += 1
    row.lastAt = now
    usage[key] = row
  }
  try {
    writeFileSync(SYMBOL_USAGE_FILE, JSON.stringify(usage, null, 1), 'utf8')
  } catch (error) {
    process.stderr.write(`[eplan-mcp] 元件热表写不进去: ${error.message}\n`)
  }
}

/**
 * 热表 = 基线 8 条 + 用过的符号里出现最多的若干条。
 * 每行压到「名 库 变体 引脚 用途」五个字段，免得把提示词撑爆。
 */
function warmSymbols(limit = 12) {
  const usage = symbolUsage()
  const seen = new Set(COMMON_SYMBOLS.map((item) => item.s))
  const used = Object.values(usage)
    .filter((row) => row && !seen.has(row.name))
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, Math.max(0, limit - COMMON_SYMBOLS.length))
    .map((row) => ({ s: row.name, lib: row.library ?? '?', v: '-', p: '已查过 pins，见 knowledge/symbol-usage.json', use: `用过 ${row.count} 次` }))
  return [...COMMON_SYMBOLS, ...used].map(
    (item) => `${item.s} | ${item.lib} | v${item.v} | ${item.p} | ${item.use}`,
  )
}

/**
 * 符号图鉴：knowledge/symbols/<名>.png，由 script/build-symbol-gallery.mjs 用 EPLAN
 * 真画一遍再逐张裁出来（不是拼图 —— 用户明确要求逐张发）。
 * 模型看着形状配引脚，比只看名字靠谱。
 */
const SYMBOL_GALLERY_DIR = (() => {
  // 图鉴随包走（script/build-symbol-gallery.mjs 生成到包内 knowledge/symbols），
  // 装到别的机器也能直接用；本地生成过就用本地那份覆盖。
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const shipped = join(packageRoot, 'knowledge', 'symbols')
  const local = join(KNOWLEDGE_DIR, 'symbols')
  return existsSync(local) ? local : shipped
})()
const GALLERY_CACHE = new Map()

function galleryPath(key) {
  if (!key) return null
  const file = join(SYMBOL_GALLERY_DIR, `${key}.png`)
  if (existsSync(file)) return file
  const shipped = join(dirname(dirname(fileURLToPath(import.meta.url))), 'knowledge', 'symbols', `${key}.png`)
  return existsSync(shipped) ? shipped : null
}

/** 按给定符号名返回图片块（逐张，最多 limit 张）。 */
function galleryBlocks(keys, limit = 4) {
  const blocks = []
  for (const key of keys ?? []) {
    if (blocks.length >= limit) break
    const file = galleryPath(key)
    if (!file) continue
    let data = GALLERY_CACHE.get(file)
    if (!data) {
      try {
        data = readFileSync(file).toString('base64')
        GALLERY_CACHE.set(file, data)
      } catch {
        continue
      }
    }
    blocks.push({ type: 'image', data, mimeType: 'image/png' })
  }
  return blocks
}

/** 热表里排在前面的、有图的符号名。 */
function galleryKeys(limit = 4) {
  const keys = []
  for (const item of COMMON_SYMBOLS) {
    if (keys.length >= limit) break
    if (galleryPath(item.s)) keys.push(item.s)
  }
  return keys
}

/** 把一张工具结果换成「文字 + 逐张图」。 */
function withImages(result, keys, limit = 4) {
  const images = galleryBlocks(keys, limit)
  if (images.length === 0) return result
  return { ...result, content: [...(result.content ?? []), ...images] }
}

/** 四种任务模式：工具子集、该读的技能、硬规则、调用预算。 */
const TOOL_MODES = {
  page: {
    title: '画一页',
    tools: ['page_create', 'page_edit', 'page_inspect', 'validate', 'symbol_catalog'],
    skills: ['eplan-drawing', 'eplan-symbols'],
    budget: '6~10 次调用：建页骨架 1 次 → 按单元插（同类一批）→ validate → 出图核对 → 局部修，不要整页重画。',
    rules: [
      '先把参考拆成单元表：一行一个器件（位号 / 符号 / 引脚 / 接到哪），同类合并成一批再动手。',
      '一次提交一个单元或一批同类，插完立刻确认引脚同轴、有红线；不要整页画完再回头改。',
      'focus 已给常用元件引脚；只有表里没有的符号才 symbol_catalog action="pins"。',
    ],
  },
  edit: {
    title: '改一页',
    tools: ['page_edit', 'page_inspect', 'validate', 'symbol_catalog'],
    skills: ['eplan-drawing', 'eplan-annotations'],
    budget: '2~3 次调用：page_edit → validate →（有问题再 page_edit）。改一处不要重建整页。',
    rules: [
      '只改需要改的对象；page_edit 的 relocate / relabel 比 delete+create 便宜，也不会丢别的对象。',
      '改完必须 validate 一次，把 problems 逐条处理完再交付。',
      '设备标识用 relabel，不要为了改一个标签重建整页。',
    ],
  },
  check: {
    title: '验收交付',
    tools: ['validate', 'page_inspect', 'export'],
    skills: ['eplan-review', 'eplan-troubleshooting'],
    budget: '2 次调用：validate（看 problems）→ page_inspect format=image（看图核对）→ 必要时 export。',
    rules: [
      '交付前必须有两样证据：validate 的 problems 清单，和一张渲染图。只有其中一样不算验收。',
      'problems 里的 label_overlap 只影响可读性，可以不改；其余每条都要处理或明确说明为什么不改。',
      'export 一律 theme="light"，深色底只用于自己看。',
    ],
  },
  lib: {
    title: '查符号与手册',
    tools: ['symbol_catalog', 'manual'],
    skills: ['eplan-symbols'],
    budget: '1~3 次调用：search 定位 → pins 看引脚 / visual 看形状（一次一张样子表）。',
    rules: [
      '符号名只能来自 symbol_catalog 的返回，不要根据经验拼。',
      'search 一次最多 200 条，结果会带 truncated 和 matchedCount；要更窄就加 filter。',
      '中文概念搜不到是正常的（库里只有英文名）：要么换成英文缩写，要么 visual 一次把候选画出来用眼睛认，别翻全表。',
      '手册里的端子定义可以用 manual action="render" 看原图，比抽文字可靠。',
    ],
  },
}

let currentMode = 'all'

/** 生效当前模式：返回真正被启用/停用的工具名，以及该读的技能绝对路径。 */
function applyFocus(mode) {
  const spec = mode === 'all' ? null : TOOL_MODES[mode]
  if (mode !== 'all' && spec === undefined) {
    throw fail(
      'BAD_ARGUMENT',
      `workspace 不认识 mode="${mode}"。`,
      `可选：${['all', ...Object.keys(TOOL_MODES)].join(' / ')}`,
    )
  }

  // 工具面**不再随模式增删**（2026-11-24 session-400917a2 的教训）。
  //
  // 原来这里按模式 disable 工具并发 tools/list_changed：切一次模式，run_code 的 SDK
  // 声明就变一次 —— ① 系统提示的前缀变了，整段缓存从顶到底作废；② 已经在写的程序
  // 里 tools.mcp__eplan__workspace 变成 unknown tool / is not a function 半路夭折
  // （那次白烧 1.5 分钟 + 一轮返工）。全开的代价只是提示词多 2 KB（19.5→21.5 KB），
  // 换来的是一段全程不变的稳定前缀。
  //
  // 模式仍然有用：它决定推荐用哪几个、给哪些必填参数和规则。只是不再限制可达性。
  const all = [...toolHandles.keys()]
  for (const [, handle] of toolHandles) handle.enable?.()
  const recommended = spec === null ? all : ['workspace', ...spec.tools]
  currentMode = mode

  const payload = {
    mode,
    title: spec === null ? '全部工具' : spec.title,
    active: all,
    recommended,
    disabled: [],
    alwaysAvailable: true,
  }
  if (spec !== null) {
    payload.skills = spec.skills.map((name) => join(SKILL_ROOT, name, 'SKILL.md'))
    payload.budget = spec.budget
    payload.rules = spec.rules
    payload.params = ACTION_PARAMS[mode] ?? ACTION_PARAMS.page
  }
  // 常驻热表：引脚几何直接给出来，省掉「先 pins 再插」的往返。
  payload.symbols = warmSymbols()
  // 图鉴：紧跟这段文字逐张发常用符号的样子（不是拼图）。
  // 4 张：一步最多 8 张新图，视频摘要在同一步里还要占 4 张。
  const gallery = galleryKeys(4)
  if (gallery.length > 0) {
    payload.gallery = gallery
    payload.galleryNote = '后面按 gallery 的顺序逐张给图（EPLAN 真渲染，暗色主题，红色是自动连接线）。'
  }
  payload.note =
    '工具面固定在 12 个（disabled 永远为空，run_code 的 SDK 声明也不再随模式变化）：' +
    'recommended 是这个模式最该先用的几个，其余照样能调，不用为了「换个模式」去切 focus。' +
    '换模式用 workspace action="focus" mode=page|edit|check|lib|all。'
  return payload
}

const planStatusOf = (entries) => {
  const counts = {}
  for (const entry of entries ?? []) {
    const status = entry?.status ?? 'todo'
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

/**
 * brief：一次调用拿到「开工需要的全部环境事实」。
 *
 * 替代以前的开局三连（status + list_pages + plan_get，实测各 1.6~2.4 KB），
 * 压到 1.5 KB 以内，并且带上「当前工具面模式」——模型不用猜自己能干什么。
 */
async function briefResult(args = {}) {
  const out = { mode: currentMode }

  let status = null
  try {
    status = await callBridge('status', {})
  } catch (error) {
    out.ready = false
    out.eplan = { reachable: false, code: error.code ?? 'UNKNOWN', message: error.message }
  }

  if (status) {
    const project = status.currentProject ?? null
    out.ready = status.ready === true
    out.project = project?.name ?? null
    out.projectPath = project?.path ?? null
    out.pageCount = project?.pageCount ?? null
    out.locked = project?.isLocked === true
    out.readOnly = project?.isReadOnly === true
    out.visiblePage = status.visiblePage ?? null
    out.openProjects = (status.openProjects ?? []).map((item) => item?.name).filter(Boolean)
    out.symbolLibraries = status.symbolLibraries ?? []
  }

  const project = args.project ?? out.project ?? null
  if (project) {
    try {
      const listing = await callBridge('pages', { project, limit: 500 })
      const list = Array.isArray(listing) ? listing : (listing?.pages ?? [])
      out.pages = list.map((page) => page?.name).filter(Boolean)
      for (const page of list) {
        if (page?.name && Array.isArray(page.size)) pageSizeCache.set(`${project}|${page.name}`, page.size)
      }
    } catch (error) {
      out.pagesError = error.message
    }
    try {
      const plan = readPlan(project)
      out.plan = { count: plan.entries.length, byStatus: planStatusOf(plan.entries) }
      out.locks = readLocks(project).pages
    } catch {
      // 台账是桥本地的，读不到就不给，不影响开工。
    }
  }

  const ids = eplanProcessIds()
  if (ids.length > 0) out.eplanProcesses = ids
  // 两个 EPLAN 实例时，另一个窗口里的页不会跟着更新；开工第一步就要看得见这件事。
  decorateInstances(out)

  if (out.ready !== true) {
    // brief 是最容易「看到 ready:false 就再 brief 一次」的地方，指引跟前一步一样。
    Object.assign(
      out,
      notReadyFields({ message: out.eplan?.message, code: out.eplan?.code, processes: ids }),
    )
  } else {
    out.hint =
      '开工顺序：focus 选模式 → brief 看环境 → 按 mode 的 budget 干活。' +
      '页面上已标注 locks 的页别动（别人占着）。'
  }
  return out
}

// ---------------------------------------------------------------------------
// 长操作 job 化：present（切页+出图）与 export（导出）。
//
// 为什么要 job：PTC 的 run_code 有 120 秒硬上限，present/export 一旦撞上 EPLAN
// 模态框或大页渲图就会把整段程序杀掉，前面的调用全部作废（审计里两次 120 s
// 超时都是 present）。所以这两个动作支持 wait:false：立刻回 jobId，结果用
// workspace/operation_history 的 action="wait" 取。同一个 key 同时只跑一个任务，
// 重复提交拿回同一个 jobId，不会排成两条。
// ---------------------------------------------------------------------------
const JOB_KEEP_MS = 15 * 60 * 1000
// 同一个页最近一次「被对话框挡住 / 主线程没回话」的时刻。
// 90 秒内不再重发同一个 present：连撞三次的代价是 80 秒 + 三圈模型回合。
const STUCK_COOLDOWN_MS = 90 * 1000
const recentStuck = new Map()
const jobs = new Map()
let jobSeq = 0

function markStuck(key) {
  if (key) recentStuck.set(key, Date.now())
}

function stuckRecently(key) {
  const at = recentStuck.get(key)
  if (!at) return false
  if (Date.now() - at > STUCK_COOLDOWN_MS) {
    recentStuck.delete(key)
    return false
  }
  return true
}

function gcJobs(now = Date.now()) {
  for (const [id, job] of jobs) {
    const endedAt = job.finishedAt ?? job.startedAt
    if (now - endedAt > JOB_KEEP_MS) jobs.delete(id)
  }
  for (const [key, at] of recentStuck) {
    if (now - at > STUCK_COOLDOWN_MS) recentStuck.delete(key)
  }
}

function thatJob(jobId) {
  gcJobs()
  return jobs.get(jobId)
}

/** 起一个长任务；同 kind+key 已在跑就复用那个 job。 */
function startJob({ kind, key, page, project, run }) {
  gcJobs()
  for (const job of jobs.values()) {
    if (job.state === 'running' && job.kind === kind && job.key === key) return { job, reused: true }
  }
  const job = {
    id: `${kind}-${++jobSeq}`,
    kind,
    key,
    page: page ?? null,
    project: project ?? null,
    state: 'running',
    startedAt: Date.now(),
  }
  jobs.set(job.id, job)
  run().then(
    (result) => {
      job.state = 'done'
      job.result = result
      job.finishedAt = Date.now()
    },
    (error) => {
      job.state = 'failed'
      job.error = { code: error.code ?? 'UNKNOWN', message: error.message, ...(error.detail ? { detail: error.detail } : {}) }
      job.finishedAt = Date.now()
    },
  )
  return { job, reused: false }
}

async function presentOnce({ page, project, width, theme }) {
  // 关键差别是**不重试**：连发 5 次 open_page 会被同一个对话框全部挡回去，
  // 每次白烧一轮。被挡就把「让用户按 Esc」原样带回，图照样给。
  let opened
  try {
    opened = await callBridge('page_open', { page, project, focus: true })
  } catch (error) {
    opened = {
      ok: false,
      code: error.code ?? 'UNKNOWN',
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
    }
  }
  let shot = null
  try {
    shot = await callBridge('look', { page, project, width, theme })
  } catch (error) {
    shot = null
    opened = { ...opened, lookError: error.message }
  }
  const blocked = opened && opened.ok === false && opened.code === 'EPLAN_BLOCKED_BY_DIALOG'
  if (blocked) markStuck(`${project ?? ''}|${page}`)
  return {
    page,
    project,
    opened,
    visible: opened?.visibleInTitle === true || opened?.focusRequested === true,
    ...(shot ? { imagePath: shot.imagePath, counts: shot.counts, theme, renderMs: shot.renderMs } : {}),
    ...(blocked ? { blocked: true } : {}),
    ...(blocked
      ? {
          hint: 'EPLAN 正停在模态框或交互命令里，这次切页没有生效。让用户按 Esc 关掉后再说一声；不要连续重试 open_page。图已经渲好，可以先看图确认内容。',
        }
      : {}),
  }
}

function startPresent({ page, project, width, theme }) {
  const key = `${project ?? ''}|${page}`
  // 熔断：刚被挡过就别再发。返回一个「已失败」的 job，形状和其他 job 一样，
  // 模型看到的是同一套字段 + 一句「先让用户关框」，不会以为这是新任务。
  if (stuckRecently(key)) {
    const now = Date.now()
    const job = {
      id: `present-${++jobSeq}`,
      kind: 'present',
      key,
      page: page ?? null,
      project: project ?? null,
      state: 'failed',
      startedAt: now,
      finishedAt: now,
      blocked: true,
      error: {
        code: 'EPLAN_BLOCKED_BY_DIALOG',
        message: `上一次给「${page}」切页时被 EPLAN 的对话框挡住了，${Math.round(STUCK_COOLDOWN_MS / 1000)} 秒内不再重发。`,
        detail: '这次什么都没做。让用户切到 EPLAN 把框关掉（或按 Esc），回一句后再继续；不要换个参数绕过。',
      },
    }
    jobs.set(job.id, job)
    return { job, reused: true }
  }
  return startJob({
    kind: 'present',
    key,
    page,
    project,
    run: () => presentOnce({ page, project, width, theme }),
  })
}

function startExport(args) {
  return startJob({
    kind: 'export',
    key: `${args.project ?? ''}|${(args.pages ?? []).join(',')}|${args.kind ?? ''}`,
    project: args.project,
    run: () => callBridge('export', { ...args, theme: args.theme ?? config.renderTheme }),
  })
}

/** job 的一行摘要：running / done / failed 三种，字段按状态裁剪。 */
function jobPayload(job, extra = {}) {
  const base = {
    jobId: job.id,
    kind: job.kind,
    state: job.state,
    ...(job.page ? { page: job.page } : {}),
    ...(job.project ? { project: job.project } : {}),
    elapsedMs: Math.max(0, (job.finishedAt ?? Date.now()) - job.startedAt),
    ...extra,
  }
  if (job.state === 'failed') {
    return { ...base, error: job.error, hint: '这一任务失败了。EPLAN 被对话框挡住时先让用户按 Esc，不要连续重试。' }
  }
  if (job.state === 'running') {
    if (job.unresponsive) {
      return {
        ...base,
        epanUnresponsive: true,
        hint:
          'EPLAN 主线程没回话（2 秒探针超时）：几乎可以断定正压着一个模态框。'
          + '别再 wait、也别重发同一个任务 —— 让用户切到 EPLAN 按 Esc 或点掉那个框，回一句后再继续。'
          + '这一步没有任何东西被改坏，页面内容以最近一次渲染图为准。',
      }
    }
    return {
      ...base,
      hint: `还在跑（${Math.round(base.elapsedMs / 1000)} 秒）。稍后用 workspace({action:"wait", jobId:"${job.id}"}) 取结果；等的期间可以干别的，别重复提交同一个任务。`,
    }
  }
  return { ...base, ...job.result }
}

/** 完成时把图作为 image 块一起给出（模型才能真的看图）；export 没有图，只回文件清单。 */
function jobBlocks(job, extra) {
  const blocks = [{ type: 'text', text: JSON.stringify(jobPayload(job, extra)) }]
  const imagePath = job.result?.imagePath
  if (job.kind === 'present' && job.state === 'done' && imagePath && existsSync(imagePath)) {
    blocks.push({ type: 'image', data: readFileSync(imagePath).toString('base64'), mimeType: 'image/png' })
  }
  return { content: blocks }
}

/**
 * EPLAN 主线程还答不答话。
 *
 * 模态框（含 EPLAN 自己的「硬件错误/存储器访问受阻」）会占住主线程，这时候连 status
 * 都回不来。用 2 秒的探针，不是用来杀任务，只用来**提前收摊**：
 * 2026-11-24 session-400917a2 里 present 卡在对话框后面，模型连 wait 三次，
 * 每次干等 25 秒（t4/5→t4/7 白烧 80 秒）。探针把「是不是卡住了」变成 2 秒内可知。
 */
async function eplanUnresponsive() {
  try {
    await callBridge('status', {}, { timeoutMs: 2000 })
    return false
  } catch {
    return true
  }
}

async function settleJob(job, timeoutMs) {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  let probed = false
  while (job.state === 'running' && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    // 10 秒还没完就先探一次：跑得慢和卡死了是两件事，不能都让调用方干等。
    // （一次正常渲染是 1~3 秒；10 秒还在跑，多半是撞上了模态框。）
    if (!probed && Date.now() - startedAt > 10000 && job.state === 'running') {
      probed = true
      if (await eplanUnresponsive()) {
        job.unresponsive = true
        if (job.kind === 'present') markStuck(job.key)
        break
      }
    }
  }
  return job
}

/**
 * 把一句备注并进已经序列化好的结果文本（不改变主结构）。
 * 解析不了就原样返回 —— 备注的价值不该用「弄坏正常结果」来换。
 */
function withNote(result, note) {
  if (!note || result?.isError) return result
  try {
    const block = result.content?.find?.((item) => item.type === 'text')
    const parsed = JSON.parse(block.text)
    if (!parsed || typeof parsed !== 'object') return result
    block.text = JSON.stringify({ ...parsed, ...note })
  } catch {
    // 不是 JSON 就保持原样。
  }
  return result
}

/**
 * 宿主还是旧版时，把 UNKNOWN_OP 翻成能照着做的话。
 *
 * 新增的 op 只有 EPLAN 重启后才会加载；在那之前调用不该只回一句
 * 「宿主不认识的操作」——模型会以为参数写错了，反复重试。
 */
function hostOutdated(result, op, fallback) {
  if (result?.isError !== true) return result
  try {
    const block = result.content?.find?.((item) => item.type === 'text')
    const parsed = JSON.parse(block.text)
    if (parsed?.code !== 'UNKNOWN_OP') return result
    parsed.code = 'HOST_OUTDATED'
    parsed.message = `EPLAN 里加载的还是旧宿主，不认识 ${op}。`
    parsed.detail = `新宿主已经编译好在 host\\bin，但只有 EPLAN 重新启动后才会加载。现在可以：${fallback}`
    block.text = JSON.stringify(parsed)
  } catch {
    // 解析不了就原样返回。
  }
  return result
}

regTool(
  'workspace',
  {
    title: '环境与项目',
    description:
      '环境与项目。开工先 focus 选模式，再 brief 一次拿全环境（项目、页清单、当前页、锁定、台账）。\n' +
      'status 详细状态；list_pages 列页；launch 把 EPLAN 拉起来（工作目录/独占/等 Remoting 都处理好了，别自己 spawn EPLAN.exe）；\n' +
      'open/create_project 开建项目；\n' +
      'open_page 切页（focus=true 才提窗口）；present 切页+提窗口+出图（wait:false 先回 jobId，再用 wait 取）；\n' +
      'follow 跟随：写入后自动在 EPLAN 打开那一页（默认开，throttleMs 节流）；\n' +
      'plan_get/plan_put 读写页台账；claim/release 占位防两个会话改同一页。',
    inputSchema: z.object({
      action: z
        .enum([
          'brief',
          'focus',
          'status',
          'list_pages',
          'launch',
          'open_project',
          'create_project',
          'open_page',
          'present',
          'wait',
          'plan_get',
          'plan_put',
          'claim',
          'release',
          'follow',
        ])
        .describe('要做什么'),
      mode: z
        .enum(['page', 'edit', 'check', 'lib', 'all'])
        .optional()
        .describe('focus 的模式：page 画页（默认）/ edit 改页 / check 验收 / lib 查库 / all 全开'),
      project,
      page: z.string().optional().describe('页名，例如 "=MI/13"（present / claim 等用）'),
      jobId: z.string().optional().describe('wait 要等的 jobId（present/export wait:false 返回）'),
      owner: z.string().optional().describe('claim 的负责人；省略记为当前进程'),
      dryRun: z.boolean().optional().describe('create_project 只回报会建在哪、用哪个模板，不真的创建'),
      list: z
        .object({
          filter: z.string().optional().describe('页名子串'),
          limit: z.number().int().min(1).max(500).optional().describe('最多返回多少页，默认 100'),
          includePlacements: z.boolean().optional().describe('是否附带每页的放置统计，默认 false'),
        })
        .optional()
        .describe('list_pages 的选项'),
      open: z
        .object({
          name: z.string().optional().describe('项目名，例如 test'),
          path: z.string().optional().describe('.elk 完整路径，优先于 name'),
          dir: z.string().optional().describe('项目目录，省略用默认'),
          focus: z
            .boolean()
            .optional()
            .describe('把窗口提到最前，默认 false；只有用户说「打开给我看」才传 true'),
        })
        .optional()
        .describe('open_project / open_page 选项'),
      create: z
        .object({
          name: z.string().describe('新项目名'),
          template: z.string().optional().describe('.ept 模板路径；省略用 GB_tpl001.ept'),
          creator: z.string().optional().describe('写进 PROJ_CREATORLONGNAME'),
          dir: z.string().optional().describe('建在哪个目录'),
          dryRun: z.boolean().optional().describe('只回报会建在哪，不创建'),
        })
        .optional()
        .describe('create_project 选项'),
      force: z
        .boolean()
        .optional()
        .describe('launch 用：EPLAN 已经就绪时仍然再起一个实例（默认不，避免多实例抢项目锁）'),
      present: z
        .object({
          width: z.number().int().min(400).max(4000).optional().describe('渲图宽度，默认 2000'),
          theme: z.enum(['dark', 'light']).optional().describe('渲图配色，默认按配置（深色）'),
          wait: z
            .boolean()
            .optional()
            .describe('是否等出图，默认 true；false 立刻回 jobId，用 action="wait" 取'),
          waitMs: z
            .number()
            .int()
            .min(1000)
            .max(110000)
            .optional()
            .describe('最多等多少毫秒，默认 30000；等不到回 jobId 而不是报错'),
        })
        .optional()
        .describe('present 选项'),
      plan: z
        .array(
          z.object({
            page: z.string().optional(),
            title: z.string().optional(),
            status: z.enum(['todo', 'drawing', 'review', 'done']).optional(),
            owner: z.string().optional(),
            note: z.string().optional(),
          }),
        )
        .optional()
        .describe('plan_put 的页清单；传了就整体覆盖'),
    }).passthrough(),
  },
  async (args) => {
    // 兼容老的平铺写法：filter / limit / name / path / dir / template / items / width / theme 直接在顶层时照样认。
    const listOpts = args.list ?? {}
    const openOpts = args.open ?? {}
    const createOpts = args.create ?? {}
    const presentOpts = args.present ?? {}
    const planItems = args.plan ?? args.items

    switch (args.action) {
      case 'brief':
        return ok(await briefResult({ project: args.project }))
      case 'focus': {
        const focused = applyFocus(args.mode ?? 'page')
        return withImages(ok(focused), focused.gallery ?? [], 4)
      }
      case 'status':
        return statusResult()
      case 'list_pages':
        return invoke('pages', {
          project: args.project,
          filter: listOpts.filter ?? args.filter,
          limit: listOpts.limit ?? args.limit,
          includePlacements: listOpts.includePlacements ?? args.includePlacements,
        })
      case 'open_project': {
        const name = openOpts.name ?? args.name
        const path = openOpts.path ?? args.path
        if (!name && !path) need({ name }, ['name'], 'open_project')
        return openProject({ ...args, name, path, dir: openOpts.dir ?? args.dir })
      }
      case 'create_project': {
        const name = createOpts.name ?? args.name
        const template = createOpts.template ?? args.template
        const creator = createOpts.creator ?? args.creator
        const dir = createOpts.dir ?? args.dir
        const dryRun = createOpts.dryRun ?? args.dryRun
        if (!name) need({ name }, ['name'], 'create_project')
        return invoke('project_create', {
          name,
          directory: dir,
          template,
          // 宿主按 AnyPropertyId 标识名收属性，创建者就是 PROJ_CREATORLONGNAME。
          ...(creator ? { properties: { PROJ_CREATORLONGNAME: creator } } : {}),
          dryRun: dryRun === true,
        })
      }
      case 'launch': {
        // 自己 spawn EPLAN.exe 的坑：工作目录不对会在 30~90 秒后静默退出，带 .elk 参数
        // 启动也不会加载项目；而「进程起来了」不等于「API 通了」。
        // 桥接器里的 launch 已经把这些都处理对了（ShellExecute 起独立进程 + 轮询 Remoting
        // 最多 60 秒），这里只是把它暴露成一个 action。
        // 2026-11-23 session-a18a4a7f：模型不知道有这个，自己杀了又起起了又杀，花了 25 次调用。
        //
        // 先看是不是已经能用了：已经 ready 还去 launch，只会多开一个实例，然后就是
        // 「多用户冲突 / 数据库被另一用户单独锁定」那条老路。要真的重开必须 force:true。
        let current = null
        try {
          current = await callBridge('status', {}, { timeoutMs: 20000 })
        } catch {
          current = null
        }
        if (current?.ready === true && (openOpts.force ?? args.force) !== true) {
          return ok({
            alreadyRunning: true,
            ready: true,
            project: current.currentProject?.name ?? null,
            visiblePage: current.visiblePage ?? null,
            hint:
              'EPLAN 已经在跑而且 API 已经通了，不用 launch —— 直接干活就行（brief / open_page / page_create）。' +
              '确实要再起一个实例才传 force:true。',
          })
        }
        const elk = args.project || args.name ? projectElkPath({ name: args.name ?? args.project, path: args.path, dir: args.dir }) : null
        let launched
        try {
          launched = await callBridge(
            'launch',
            {
              ...(args.path ? { path: args.path } : {}),
              ...(args.variant ? { variant: args.variant } : {}),
              ...(elk ? { project: elk } : {}),
            },
            { timeoutMs: 90000 },
          )
        } catch (error) {
          return failed('launch', error)
        }
        // 起完再看一眼状态：launch 已经等过 Remoting，这里只是把「通没通」说清楚。
        let ready = null
        try {
          const status = await callBridge('status', {}, { timeoutMs: 20000 })
          ready = status?.ready === true
        } catch {
          ready = false
        }
        return ok({
          launch: launched,
          projectPath: elk,
          ready,
          nextSteps: ready
            ? ['已经能用了：接着 workspace{action:"brief"} 或直接干活。']
            : [
                'Remoting 还没挂起来：EPLAN 启动慢是常态，等 30~60 秒再 workspace{action:"status"} 一次，别连着重试。',
                elk ? `项目 ${basename(elk)} 没自动加载就 workspace{action:"open_project", name:"${basename(elk).replace(/\.elk$/i, '')}"}。` : '知道项目名的话用 workspace{action:"open_project", name:"<项目名>"} 打开。',
              ],
        })
      }
      case 'open_page':
        need(args, ['page'], 'open_page')
        return invoke('page_open', {
          page: args.page,
          project: args.project,
          focus: (openOpts.focus ?? args.focus) === true,
        })
      case 'follow': {
        // 跟随开关：写成功后自动在 EPLAN 打开那一页。enabled=false 就完全不动界面。
        if (typeof args.enabled === 'boolean') followOpts.enabled = args.enabled
        if (typeof args.focus === 'boolean') followOpts.focus = args.focus
        if (Number.isFinite(Number(args.throttleMs))) {
          followOpts.throttleMs = Math.min(Math.max(Number(args.throttleMs), 0), 30000)
        }
        // 立刻定位一次当前页（不带参数时用 status 里的 visiblePage），方便确认跟随生效。
        let moved = null
        if (args.page) moved = await openInEplan(args.page, args.project)
        return ok({ follow: { ...followOpts, lastPage: lastFollow.page, lastAt: lastFollow.at || null }, moved })
      }
      case 'present': {
        need(args, ['page'], 'present')
        const width = presentOpts.width ?? args.width ?? 2000
        const theme = presentOpts.theme ?? args.theme ?? config.renderTheme
        const { job, reused } = startPresent({ page: args.page, project: args.project, width, theme })
        // wait:false 立刻返回，绕开 run_code 的 120 秒硬砍；默认等 30 秒，等不到
        // 也返回 jobId 而不是报错，程序可以接着用 operation_history 取。
        if ((presentOpts.wait ?? args.wait) === false) {
          return ok(jobPayload(job, reused ? { reused: true } : {}))
        }
        const waitMs = Math.min(Math.max(Number(presentOpts.waitMs ?? args.waitMs ?? 30000), 1000), 110000)
        await settleJob(job, waitMs)
        return jobBlocks(job, reused ? { reused: true } : {})
      }
      case 'wait': {
        need(args, ['jobId'], 'wait')
        gcJobs()
        const job = thatJob(args.jobId)
        if (!job) {
          return ok({
            jobId: args.jobId,
            state: 'unknown',
            hint: '找不到这个 job：可能已完成并过了 15 分钟保留期，或 id 写错。jobId 来自 present/export 的返回。',
          })
        }
        const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 25000), 1000), 110000)
        await settleJob(job, timeoutMs)
        return job.state === 'done' && job.result?.imagePath
          ? jobBlocks(job, { waitedMs: timeoutMs })
          : ok(jobPayload(job, { waitedMs: timeoutMs }))
      }
      case 'plan_get': {
        need(args, ['project'], 'plan_get')
        const plan = readPlan(args.project)
        const locks = readLocks(args.project)
        return ok({
          project: args.project,
          file: plan.file,
          count: plan.entries.length,
          entries: plan.entries,
          locks: locks.pages,
        })
      }
      case 'plan_put': {
        need(args, ['project'], 'plan_put')
        if (!Array.isArray(planItems)) {
          throw fail('BAD_ARGUMENT', 'plan_put 需要 plan 数组。', '每项至少给 page（或 title），可带 status/owner/note。')
        }
        return ok(writePlan(args.project, planItems))
      }
      case 'claim':
        need(args, ['project', 'page'], 'claim')
        return ok(claimPage({ project: args.project, page: args.page, owner: args.owner }))
      case 'release':
        need(args, ['project', 'page'], 'release')
        return ok(releasePage({ project: args.project, page: args.page }))
      default:
        throw fail(
          'BAD_ARGUMENT',
          `workspace 不认识 action="${args.action}"。`,
          '只支持 brief / focus / status / list_pages / launch / open_project / create_project / open_page / present / wait / plan_get / plan_put / claim / release / follow。',
        )
    }
  },
)

// 中文概念 → 已知符号名。只收「本机符号库里亲手确认过」的组合（来自 COMMON_SYMBOLS
// 的用途说明和 annotate 进知识库的记录），不凭经验编。
// 目的：2026-11-23 session-a18a4a7f 里模型用「按钮」搜不到任何东西，只好翻 1000 多
// 个符号名、再建 4 张试画页用眼睛认 —— 18 次调用全花在这上面。
const SYMBOL_CONCEPTS = [
  { match: ['中断点', '断点', '跳转'], symbols: ['BP'], note: 'SPECIAL，竖排；v1/3/5/7 是四个方向' },
  { match: ['连接点', '节点'], symbols: ['CO', 'TLRU', 'TOUR', 'TLRO', 'TOUL'], note: 'CO 是单点，TLRU/TOUR/TLRO/TOUL 是 T 形分支' },
  { match: ['电源', '引入点', '进线'], symbols: ['CDPST'], note: 'SPECIAL，上下各 4 mm' },
  { match: ['空开', '断路器', '微型断路器', '三极'], symbols: ['FA3'], note: 'GB_symbol，三极，极距 8 mm' },
  { match: ['端子', '端子排'], symbols: ['DCP', 'X2'], note: 'DCP 是端子连接点；X2 是端子排本体' },
  { match: ['接地', 'PE'], symbols: ['ERDE'], note: '保护接地' },
]

function conceptHits(keyword) {
  const text = String(keyword ?? '').trim()
  if (text.length === 0) return []
  return SYMBOL_CONCEPTS.filter((entry) => entry.match.some((word) => text.includes(word) || word.includes(text)))
}

/** 挑一个没被占用的临时页名：=TMP/90 起，往后找到空号为止。 */
async function pickScratchPage(project) {
  let taken = new Set()
  try {
    const listing = await callBridge('pages', { project, limit: 500 })
    const list = Array.isArray(listing) ? listing : (listing?.pages ?? [])
    taken = new Set(list.map((page) => String(page?.name ?? page)))
  } catch {
    // 列不出页就按顺序试，撞名会由 page_create 报出来（下面有兜底提示）。
  }
  for (let number = 90; number <= 99; number += 1) {
    const candidate = `=TMP/${number}`
    if (!taken.has(candidate)) return candidate
  }
  throw fail(
    'SCRATCH_PAGE_EXHAUSTED',
    '=TMP/90~99 都被占了，没有空号建样子表。',
    '删掉几张没用的 =TMP 临时页再试（page_delete），或者直接用 page_inspect 看已有的页。',
  )
}

/**
 * 一张「符号样子表」：把若干符号按网格画到一张临时页上、每个上面标名字，渲一张图。
 *
 * 为什么值得做成一个 action：模型自己摸索出来的办法就是这个（建 =TMP 页 → 摆 28 个
 * 符号 → 渲图 → 用 ffmpeg 裁 6 张放大看），一次画图花了 18 次调用。这里把它压成 1 次，
 * 而且渲的是 EPLAN 自己画的图形，不是拼图。页用完就删（失败也删）。
 */
async function symbolVisualSheet({ project, symbols, library, cols = 6, width = 2400 }) {
  const list = (Array.isArray(symbols) ? symbols : []).filter((item) => typeof item === 'string' && item.length > 0)
  if (list.length === 0) {
    throw fail('BAD_ARGUMENT', 'visual 需要 symbols 数组。', '照这个写：symbol_catalog{action:"visual", symbols:["SON","SSA","KM2"]}。')
  }
  const capped = list.slice(0, 36)
  const perRow = Math.min(Math.max(cols, 2), 8)
  const dx = 34
  const dy = 48
  // 页名必须符合 =高层/页号（页号是数字），而且不能撞上已有的页 —— 先看现在有哪些页，
  // 挑一个空号；90~99 是留给这种临时页的（实测 =TMP/V1 会被 BAD_PAGE_NAME 拒绝）。
  const page = await pickScratchPage(project)
  const nodes = []
  const texts = []
  capped.forEach((symbol, index) => {
    const x = 30 + (index % perRow) * dx
    const y = 250 - Math.floor(index / perRow) * dy
    nodes.push({ symbol, ...(library ? { library } : {}), at: [x, y] })
    texts.push({ at: [x - 15, y + 14], text: symbol, height: 2.5 })
  })

  let created = false
  try {
    // 整页渲一次再裁到元件所在的那块：420 mm 宽的页按 2400 px 出图只有 5.7 px/mm，
    // 一个 4 mm 的符号只有 23 px，认不出形状。按 4200 px（10 px/mm）渲、裁到布局区域，
    // 图既清楚又不把整页空白塞进上下文。
    const renderWidth = Math.max(4200, width)
    await callBridge('page_create', { project, name: page, type: 'Schematic', grid: 2, nodes, texts })
    created = true
    const shot = await callBridge('look', { project, page, width: renderWidth, theme: config.renderTheme })
    const render = shot ?? {}
    const full = render.imagePath
    if (!full || !existsSync(full)) {
      throw fail('RENDER_FAILED', '样子表渲不出图。', '可能这一页建出来了但渲染失败，试试 page_inspect format=image 直接看它。')
    }

    // 布局 → 裁剪框（mm）。EPLAN 的 y 向上，图片 y 向下，所以按页高翻转。
    const rows = Math.ceil(capped.length / perRow)
    const pageW = Number(render.pageSize?.[0] ?? 420)
    const pageH = Number(render.pageSize?.[1] ?? 297)
    const x0 = 30 - 15 - 6
    const x1 = 30 + (perRow - 1) * dx + 15 + 6
    const yTop = 250 + 14 + 10
    const yBottom = 250 - Math.max(0, rows - 1) * dy - 12
    const perMm = renderWidth / pageW
    const crop = {
      x: Math.max(0, Math.round(x0 * perMm)),
      y: Math.max(0, Math.round((pageH - yTop) * perMm)),
      w: Math.round((x1 - x0) * perMm),
      h: Math.round((yTop - yBottom) * perMm),
    }
    const cropped = await cropImage(full, crop, `vis-${page.replace(/[^0-9]/g, '') || 'x'}-${Date.now()}.png`)
    const imagePath = cropped.path ?? full

    const meta = {
      page,
      cols: perRow,
      symbols: capped,
      missing: list.slice(capped.length),
      layout: `每行 ${perRow} 个，从左到右、从上到下，名字在该符号上方`,
      note: '这是 EPLAN 真渲染的临时页（已裁到元件区域），看完即删；按顺序对应 symbols 里的名字。',
      imagePath,
      ...(cropped.error ? { cropError: cropped.error } : {}),
      render: { width: renderWidth, pageSize: render.pageSize, counts: render.counts },
    }
    const blocks = [{ type: 'text', text: JSON.stringify(meta) }]
    if (imagePath && existsSync(imagePath)) {
      blocks.push({ type: 'image', data: readFileSync(imagePath).toString('base64'), mimeType: 'image/png' })
    }
    return { content: blocks }
  } finally {
    if (created) {
      try {
        await callBridge('page_delete', { project, page })
      } catch {
        // 删不掉只留一页垃圾，不影响这次调用的结果；别让它把结果变成失败。
      }
    }
  }
}

/**
 * 裁一张 PNG 到 box（像素）。失败就返回原图 —— 图在，只是没那么清楚，比整轮失败好。
 * ffmpeg 的位置复用 video.mjs 的查找逻辑（本机装在 Program Files 下，不在 PATH 里）。
 */
async function cropImage(source, box, name) {
  try {
    const { findBinary } = await import('./video.mjs')
    const ffmpeg = findBinary('ffmpeg')
    const outDir = join(tmpdir(), 'eplan-mcp', 'visual')
    mkdirSync(outDir, { recursive: true })
    const target = join(outDir, name)
    const result = spawnSync(
      ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', source,
        '-vf', `crop=${Math.max(2, box.w)}:${Math.max(2, box.h)}:${Math.max(0, box.x)}:${Math.max(0, box.y)}`,
        target,
      ],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    )
    if (result.status === 0 && existsSync(target) && statSync(target).size > 0) return { path: target }
    return { path: source, error: String(result.stderr ?? '').trim().slice(0, 200) || 'crop 失败' }
  } catch (error) {
    return { path: source, error: String(error?.message ?? error).slice(0, 200) }
  }
}



regTool(
  'symbol_catalog',
  {
    title: '符号与元件',
    description:
      '查符号库与元件的工程含义。插任何元件之前先确认它存在、引脚在哪。\n' +
      'search 按名字查（query/filter/name/keyword 同义；offset 分页，一次最多 200 条）；\n' +
      'pins 查引脚坐标与朝向；visual 把几个符号真画到临时页上渲一张图，用眼睛认形状（1 次调用，用完即删）；\n' +
      'lookup 查已记录的语义；annotate 把你确认过的含义写回知识库。',
    inputSchema: z.object({
      action: z.enum(['search', 'pins', 'lookup', 'annotate', 'visual']).describe('要做什么'),
      project,
      library: z.string().optional().describe(`符号库名，默认 ${DEFAULTS.symbolLibrary}`),
      filter: z.string().optional().describe('search 的符号名子串；中文概念也行（按钮/空开/接地）'),
      query: z.string().optional().describe('filter 的别名'),
      name: z.string().optional().describe('filter 的别名'),
      keyword: z.string().optional().describe('filter 的别名'),
      limit: z.number().int().min(1).max(200).optional().describe('search 每页条数，默认 50，上限 200'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('search 的起始位置，默认 0；返回里带 nextOffset，到不了时会明说被 200 条上限挡住'),
      refresh: z.boolean().optional().describe('同参数且结果没变时默认回 unchanged；要强制重发传 true'),
      symbols: z.array(z.string()).optional().describe('pins 的符号名数组，例如 ["FA3","TLRU"]；也接受单个 symbol。visual 用它指定要看哪些'),
      symbol: z.string().optional().describe('pins 的单个符号名（等价于 symbols:[name]）；lookup / annotate 也用这个'),
      cols: z.number().int().min(2).max(8).optional().describe('visual 每行摆几个，默认 6'),
      width: z.number().int().min(600).max(6000).optional().describe('visual 出图宽度，默认 2400'),
      concept: z.string().optional().describe('annotate 的工程概念，例如 两极断路器'),
      usage: z.string().optional().describe('annotate 的用途说明'),
    }),
  },
  async (args) => {
    // 搜索关键词的四种写法收敛成一个（实测模型先试 query、再试 filter、再试 name）。
    const keyword = args.filter ?? args.query ?? args.name ?? args.keyword
    switch (args.action) {
      case 'search': {
        const want = Number.isFinite(args.limit) ? args.limit : 50
        const offset = Number.isFinite(args.offset) ? Math.max(0, args.offset) : 0
        // 中文概念先查本机的对应表：宿主的 filter 只认符号名子串，"按钮" 永远查不到东西。
        const concepts = conceptHits(keyword)
        const cjk = /[\u4e00-\u9fff]/.test(String(keyword ?? ''))
        if (cjk && concepts.length === 0) {
          return ok({
            library: args.library ?? DEFAULTS.symbolLibrary,
            matchedCount: 0,
            returned: 0,
            symbols: [],
            hint:
              `符号库里没有中文名，"${keyword}" 查不到东西是正常的。两条路：\n` +
              '① 用英文/缩写子串再查（例如 SON、KM2、FA）；\n' +
              '② 直接 symbol_catalog{action:"visual", symbols:[...]} 把它们画出来用眼睛认（1 次调用）。',
          })
        }
        // 中文命中就直接给对应关系，不再去问宿主 —— 宿主的 filter 只认符号名子串，
        // 传中文进来它会当成「无过滤」，把 823 个符号全吐出来（实测第一批就是这么来的）。
        if (concepts.length > 0) {
          return ok({
            library: args.library ?? DEFAULTS.symbolLibrary,
            filter: keyword,
            matchedCount: concepts.reduce((sum, entry) => sum + entry.symbols.length, 0),
            concepts: concepts.map((entry) => ({ concept: entry.match[0], symbols: entry.symbols, note: entry.note })),
            hint:
              'concepts 是本机确认过的中文对应关系，直接用。要引脚用 pins，要形状用 visual；' +
              '没列到的概念就 visual 画出来看，别翻全表。',
          })
        }
        // 宿主的 SymbolsTool 只认 limit、不认 offset（每次都从第一个开始吐），
        // 所以这里按 offset+want 去取再本地切片；取不满就明说取不满，
        // 而不是像以前那样「换个 offset 还是同一批 200 个」。
        const fetchLimit = Math.min(200, Math.max(want, offset + want))
        let result
        try {
          result = await callBridge('symbols', {
            project: args.project,
            library: args.library,
            filter: keyword,
            limit: fetchLimit,
          })
        } catch (error) {
          return failed('symbols', error)
        }

        const all = Array.isArray(result.symbols) ? result.symbols : []
        const matched = Number.isFinite(result.matchedCount) ? result.matchedCount : all.length
        const slice = all.slice(offset, offset + want)
        const reachable = offset + slice.length
        const nextOffset = reachable < matched ? reachable : null
        const blocked = nextOffset !== null && slice.length === 0

        const key = `search|${args.project ?? ''}|${args.library ?? ''}|${keyword ?? ''}|${want}|${offset}`
        const { repeat, digest: stamp } = symbolMemo.check(key, slice)

        const payload = {
          library: result.library ?? args.library ?? null,
          totalSymbols: result.totalSymbols ?? null,
          ...(keyword ? { filter: keyword } : {}),
          matchedCount: matched,
          offset,
          limit: want,
          returned: slice.length,
          nextOffset,
          symbols: slice,
          digest: stamp,
        }
        if (blocked) {
          payload.paginationBlocked = true
          payload.hint =
            `宿主一次最多只吐 200 条，第 ${offset} 条之后取不到。要么用 filter 收窄（例如 filter="F1"），` +
            '要么直接 symbol_catalog action="pins" 查已知符号名。'
        } else if (repeat && args.refresh !== true) {
          payload.unchanged = true
          payload.hint = '这一页/这一批和上次完全一样，没有再发一遍内容。要强制重发传 refresh=true。'
          payload.symbols = []
        }
        return ok(payload)
      }
      case 'pins': {
        // 两个名字都收：老调用用 symbol（单个），批量用 symbols（数组）。
        // 原先只认 symbols，模型写 symbol 会连撞两次 BAD_ARGUMENT（2026-11-16 s1096 实测）。
        const list = args.symbols?.length ? args.symbols : args.symbol ? [args.symbol] : null
        if (!list) need(args, ['symbols'], 'pins')
        const pinned = await invoke('symbol_info', { project: args.project, library: args.library, symbols: list })
        // 查过就进热表：下次开工这几条直接常驻，不用再查（PTC 新进程没有上一步的记忆）。
        if (!pinned?.isError) recordSymbolUse(list, args.library)
        // 有图鉴的直接给样子：逐张（最多 4 张），配着引脚看比只读名字准。
        return withImages(pinned, list, 4)
      }
      case 'visual':
        return symbolVisualSheet({
          project: args.project,
          symbols: args.symbols?.length ? args.symbols : args.symbol ? [args.symbol] : [],
          library: args.library,
          cols: args.cols,
          width: args.width,
        })
      case 'lookup':
        return invoke('knowledge_get', {
          project: args.project,
          library: args.library,
          symbol: args.symbol,
          query: args.query ?? keyword,
        })
      case 'annotate':
        need(args, ['symbol'], 'annotate')
        return invoke('knowledge_annotate', {
          symbol: args.symbol,
          library: args.library,
          concept: args.concept,
          usage: args.usage,
        })
      default:
        throw fail(
          'BAD_ARGUMENT',
          `symbol_catalog 不认识 action="${args.action}"。`,
          '只支持 search / pins / visual / lookup / annotate。',
        )
    }
  },
)

regTool(
  'page_create',
  {
    title: '新建页面（按单元摆元件）',
    description:
      '新建一页并摆元件与文字。先建页骨架，再按单元提交：一个器件或一批同类（12 个中断点、三极开关）各一次。\n' +
      '用 layout 声明行列，at 写 "列/行" 引用；改尺寸只改 layout 一处。\n' +
      'reveal=true 会渲一张图一并返回，但不切换当前页。页名用结构标识，例如 "=EB3+ET1/1"。',
    inputSchema: z.object({
      project,
      // name 和 page 二选一：其余工具都用 page，只有这里历史上叫 name。
      // 与其让模型写错一次再重试，不如两个都收。
      name: z.string().optional().describe('完整页名，例如 "=EB3+ET1/1"'),
      page: z.string().optional().describe('页名别名，等价于 name'),
      type: z
        .enum(['Schematic', 'Overview', 'Panel', 'SingleLine', 'Fluid'])
        .optional()
        .describe('页类型，默认 Schematic'),
      append: z
        .boolean()
        .optional()
        .describe('页已存在时接着往上画，而不是报 PAGE_EXISTS。默认 false'),
      nodes: z
        .array(
          z.object({
            symbol: z.string().describe('符号名，如 F1 / TLRU / CDPST'),
            library: z.string().optional().describe('符号库，默认 GB_symbol'),
            variant: z.number().int().optional().describe('变体号，默认 0；换方向是换变体，不是转角度'),
            at: z
              .union([point, z.string()])
              .describe('原点 [x, y]；配合 layout 可写 "列/行"，如 "0/bus"'),
            deviceTag: z.string().optional().describe('设备标识，如 -F4。会画成图上文字'),
            showDeviceTag: z.boolean().optional().describe('是否把设备标识画出来，默认 true'),
          }),
        )
        .optional()
        .describe('要摆的元件；按顺序插入，单个失败不影响其它，失败项见 nodesFailed'),
      texts: z
        .array(
          z.object({
            at: z
              .union([point, z.string()])
              .describe('文字包围盒左下角 [x, y]；配合 layout 可写 "列/行"'),
            text: z.string().describe('文字内容'),
            height: z.number().optional().describe('字高 mm，默认 2.5'),
          }),
        )
        .optional()
        .describe('要写的文字标注'),
      grid: z
        .number()
        .optional()
        .describe('栅格间距 mm，默认 4；吸附结果在 snapped 里报回'),
      layout: z
        .object({
          columns: z.array(z.number()).describe('列的 x 坐标，按下标引用'),
          rows: z
            .union([z.array(z.number()), z.record(z.string(), z.number())])
            .describe('行的 y 坐标：数组按下标，对象按名字'),
        })
        .optional()
        .describe('声明式布局：给了之后 at 可写 "列/行" 代替绝对坐标，如 "0/bus"；改尺寸只改 layout'),
      reveal,
      width,
      template: z.string().optional().describe('页面模板（宏文件）绝对路径'),
      dryRun: z.boolean().optional().describe('只校验并报告将创建什么，不写'),
      force: z
        .boolean()
        .optional()
        .describe('同定义重复提交默认不重建；要重建传 true'),
      theme: z.enum(['dark', 'light']).optional().describe('reveal 出图的配色，默认 dark'),
    }),
  },
  async (args) => {
    const name = args.name ?? args.page
    if (!name) throw fail('BAD_ARGUMENT', 'page_create 需要页名。', '用 name 或 page 传，例如 "=EB3+ET1/1"。')

    const flightKey = `${args.project ?? ''}|${name}`
    const running = createInflight.get(flightKey)
    if (running !== undefined) {
      return ok({
        page: name,
        project: args.project ?? null,
        busy: true,
        code: 'PAGE_IN_PROGRESS',
        startedAt: running.startedAt,
        hint: '同一页已经有一次 page_create 在跑。等它返回；不要重复提交，也不要换个页名重来。',
      })
    }

    // 幂等：完全相同的定义在短时间内重复提交，直接说「已经是这一版」，不再重建。
    const signature = digest({
      project: args.project ?? null,
      name,
      type: args.type ?? null,
      grid: args.grid ?? null,
      layout: args.layout ?? null,
      nodes: args.nodes ?? [],
      texts: args.texts ?? [],
    })
    const previous = createMemo.get(flightKey)
    if (args.force !== true && previous !== undefined && previous.signature === signature) {
      const ageSeconds = Math.round((Date.now() - previous.at) / 1000)
      if (ageSeconds < CREATE_IDEMPOTENT_MS / 1000) {
        return ok({
          page: name,
          project: args.project ?? null,
          unchanged: true,
          digest: signature,
          ageSeconds,
          hint: `这一页 ${ageSeconds} 秒前刚用完全相同的定义建过，没有重建。要强制重建传 force=true。`,
        })
      }
    }

    createInflight.set(flightKey, { startedAt: new Date().toISOString() })
    try {
      const result = await invokeWrite('page_create', { ...args, name })
      if (result.isError !== true) {
        createMemo.set(flightKey, { signature, at: Date.now() })
        // 自动占位：两个会话同时画同一页时，后来者会被 claim 挡住。
        let claim = null
        try {
          claim = claimPage({ project: args.project, page: name, owner: ownerTag() })
        } catch (error) {
          claim = { claimed: false, code: error.code ?? 'UNKNOWN', message: error.message }
        }
        if (claim?.claimed === false) {
          // 页面已经建好，但占位失败：必须让模型知道，否则另一个会话会覆盖。
          try {
            const text = result.content?.find?.((block) => block.type === 'text')?.text
            const parsed = text ? JSON.parse(text) : null
            if (parsed && typeof parsed === 'object') {
              parsed.claim = claim
              parsed.hint = `这一页已建好，但占位失败：${claim.message}。交付前先确认没有另一个会话在改同一页。`
              return ok(parsed)
            }
          } catch {
            // 解析不了就原样返回，不要把成功结果弄坏。
          }
        }
      }
      return result
    } finally {
      createInflight.delete(flightKey)
    }
  },
)

// ---------------------------------------------------------------------------
// 符号名写错时给候选。
//
// 2026-11-24 session-400917a2：模型认定「DCP」是电抗器，连撞 8 次 SYMBOL_NOT_FOUND，
// 每次 260~370 ms，外加一整轮重新规划。错的不是重试次数，是错误信息只说「没有」，
// 不说「库里有这些」。给候选 = 把一次失败变成一次可用的纠正。
// ---------------------------------------------------------------------------
const symbolNameCache = new Map()

/** 符号库全量名字（带缓存）。取不满就不缓存 —— 截断的名单会给出误导性的候选。 */
async function symbolNameIndex(project, library) {
  const key = `${project ?? ''}|${library ?? ''}`
  const hit = symbolNameCache.get(key)
  if (hit) return hit
  try {
    const res = await callBridge('symbols', { project, library, limit: 2000 })
    const names = (Array.isArray(res?.symbols) ? res.symbols : []).map((item) => item?.name).filter(Boolean)
    const total = Number.isFinite(res?.totalSymbols) ? res.totalSymbols : null
    if (names.length > 0 && (total === null || names.length >= Math.min(total, 2000))) {
      symbolNameCache.set(key, names)
    }
    return names
  } catch {
    return []
  }
}

/** 把「库里没有 X」补成「库里没有 X，最接近的是 A / B」。 */
async function symbolHint(result, symbol, library, project) {
  if (result?.isError !== true) return result
  try {
    const block = result.content?.find?.((item) => item.type === 'text')
    if (!block) return result
    const payload = JSON.parse(block.text)
    if (payload?.code !== 'SYMBOL_NOT_FOUND') return result
    const names = await symbolNameIndex(project, library)
    const candidates = closestSymbolNames(symbol, names)
    payload.candidates = candidates
    if (candidates.length > 0) {
      payload.message = `${payload.message} 库里有相近的名字：${candidates.join(' / ')}。改用其中之一，或先 pins 确认引脚。`
      payload.detail = '这些是编辑距离最近的几个，不是语义匹配 —— 形状对不对还要看 pins 或 visual。'
      payload.hint = '先 symbol_catalog{action:"pins",symbols:[候选]} 核引脚，再插；不要重复提交同一个不存在的名字。'
    } else if (names.length > 0) {
      payload.message = `${payload.message}（库里 ${names.length} 个符号里没有名字相近的。）`
      payload.detail =
        `「${symbol}」可能压根不叫这个名字，或属于别的符号库。`
        + '下一步：symbol_catalog{action:"search", filter:"<英文缩写>"} 找名字，'
        + '或 action:"visual" 把候选画出来用眼睛认（一次调用）。'
      payload.hint = '不要原样重试这一个名字。'
    }
    block.text = JSON.stringify(payload)
  } catch {
    // 结构对不上就原样返回，别用「弄坏错误信息」换候选。
  }
  return result
}

regTool(
  'page_edit',
  {
    title: '修改页面',
    description:
      '改已有页。各 action 语义不同，别混用：\n' +
      'insert_symbol 补一两个元件（整页请用 page_create，快一个数量级）；\n' +
      'set_properties 读写对象属性；\n' +
      'relocate 挪对象 / relabel 改标识 / delete_placement 删对象——都只动一个对象，不要重建整页；\n' +
      'draw_graphics 只画普通图形（标注框、说明文字、表格），**不参与连接**，别用它补线；\n' +
      'box 画黑箱（变频器/PLC 那种框）：黄框 + 边缘连接点一次完成。\n' +
      '参数形状：选对象用 select{objectId|deviceTag|index}（objectId 来自 page_inspect view="list"）；\n' +
      'relocate 写 at:[x,y] 或 offset:[dx,dy]；relabel 写 to:"-K2"；draw_graphics 写 draw:[{kind,from,to}]。',
    inputSchema: z.object({
      action: z
        .enum(['insert_symbol', 'set_properties', 'relocate', 'relabel', 'delete_placement', 'draw_graphics', 'box'])
        .describe('插入 / 改属性 / 挪 / 改名 / 删 / 画图形 / 画黑箱'),
      project,
      page: z.string().optional().describe('目标页名（四个 action 都要）'),
      dryRun: z.boolean().optional().describe('只校验并返回将做什么，不写入'),
      force: z
        .boolean()
        .optional()
        .describe('这一页被另一个会话占着时仍要改：传 true 接手占位。默认 false，会被 CLAIMED 挡回'),
      // insert_symbol
      insert: z
        .object({
          symbol: z.string().describe('符号名，例如 FA3'),
          library: z.string().optional().describe(`符号库，默认 ${DEFAULTS.symbolLibrary}`),
          variant: z.number().int().min(0).optional().describe('变体号，默认 0；换方向是换变体，不是转角度'),
          at: point.describe('插入位置 [x, y]，mm'),
          deviceTag: z.string().optional().describe('设备标识，例如 -K1'),
          props: z.record(z.string(), z.string()).optional().describe('额外属性，键为 EPLAN 属性名'),
        })
        .optional()
        .describe('insert_symbol 用'),
      // set_properties / relocate / relabel / delete_placement
      select: z
        .object({
          objectId: z.string().optional().describe('按对象标识定位（page_inspect view="list" 返回）'),
          deviceTag: z.string().optional().describe('按设备标识定位'),
          index: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('按 AllPlacements 下标（无名字的文字/图形）'),
        })
        .optional()
        .describe('定位条件，至少给一项（也可落在 page / project 上）'),
      at: point.optional().describe('relocate 的目标坐标 [x, y]，绝对'),
      offset: point.optional().describe('relocate 的相对位移 [dx, dy]，与 at 二选一'),
      // `to` 在 relabel 里是字符串（新标识），在 box 里是坐标。
      // 2026-11-24 实测：同一个键两种类型，模型写对了一种就必然错另一种，
      // 一次 schema 校验失败白丢一个回合。所以这里收 union，按 action 分派。
      to: z
        .union([z.string(), point])
        .optional()
        .describe('relabel 的新设备标识（字符串，例如 "-K2"）；box 的右下角坐标也可以直接写在这里（[x,y]）'),
      get: z.array(z.string()).optional().describe('set_properties 要读的属性名'),
      set: z.record(z.string(), z.string()).optional().describe('set_properties 要写的属性名与值'),
      // draw_graphics
      draw: z
        .array(
          z.object({
            kind: z.enum(['line', 'rect', 'text', 'polyline']).describe('图元类型'),
            from: point.optional().describe('line / rect 起点'),
            to: point.optional().describe('line / rect 终点'),
            at: point.optional().describe('text 的包围盒左下角'),
            points: z.array(point).min(2).optional().describe('polyline 的顶点'),
            text: z.string().optional().describe('text 的内容，支持换行'),
            height: z.number().optional().describe('text 字高 mm，默认 2.5'),
            width: z.number().optional().describe('线宽 mm，默认 0.2'),
            color: z
              .string()
              .optional()
              .describe('yellow / red / green / cyan / blue / magenta / black / gray，或 1-12'),
          }),
        )
        .optional()
        .describe('draw_graphics 的图元列表；画的是普通图形，不参与连接'),
      // box
      box: z
        .object({
          from: point.describe('左上角 [x, y]，mm'),
          to: point.describe('右下角 [x, y]，mm'),
          color: z.string().optional().describe('框线颜色，默认 yellow'),
          width: z.number().optional().describe('框线宽度 mm，默认 0.35'),
          deviceTag: z.string().optional().describe('黑箱的设备标识，例如 -U1；连接点代号按 -U1:SD 渲染'),
          pins: z
            .array(
              z.object({
                name: z.string().describe('连接点代号，例如 SD / RUN / PE'),
                side: z.enum(['top', 'bottom', 'left', 'right']).describe('挂在框的哪条边上'),
                at: z.number().optional().describe('沿边位置（上/下边是 x，左/右边是 y）；省略则平均分布'),
              }),
            )
            .optional()
            .describe('边缘连接点；要渲染代号必须同时给 deviceTag'),
        })
        .optional()
        .describe('box 用；比 draw_graphics 手画矩形再补端子省一半步骤'),
      // 批量：一次调用提交多步同页操作。
      // 2026-11-24 实测：一页画下来 51 次 page_edit、平均 705 ms，每次还要一个模型回合
      // （≈13 秒生成）。同类操作（三个黑箱、十二个中断点）合成一次提交，省的是回合不是毫秒。
      ops: z
        .array(z.object({
          action: z
            .enum(['insert_symbol', 'set_properties', 'relocate', 'relabel', 'delete_placement', 'draw_graphics', 'box'])
            .describe('这一步做什么，和单次调用的 action 一样'),
        }).passthrough())
        .optional()
        .describe(
          '批量模式：一次提交多步，按数组顺序执行，字段规则与单次调用完全相同（page/project 在顶层写一次即可）。'
          + '中途某步失败就停下并回报全部失败原因 —— 后面几步通常依赖前面插进去的对象。'
          + '典型用法：三个 box + 十二个 insert_symbol 一次提交。',
        ),
    }).passthrough(),
  },
  pageEditEntry,
)

/**
 * page_edit 的入口：批量或单步。
 *
 * 原来这里是一个内联箭头函数，插不进批量分派；拆成具名函数之后单步路径一个字没改，
 * 批量只是把同一套 action 逻辑按顺序喂进去。
 */
async function pageEditEntry(rawArgs) {
  if (Array.isArray(rawArgs?.ops) && rawArgs.ops.length > 0) {
    return runPageEditBatch(rawArgs)
  }
  return runPageEditOnce(rawArgs)
}

/** 批量：按顺序跑，某步失败就停 —— 后面几步通常依赖前面插进去的对象。 */
async function runPageEditBatch(rawArgs) {
  const { ops, ...shared } = rawArgs
  const results = []
  for (let index = 0; index < ops.length; index += 1) {
    const step = { ...shared, ...(ops[index] ?? {}) }
    delete step.ops
    let outcome
    try {
      outcome = await runPageEditOnce(step)
    } catch (error) {
      results.push({
        index,
        action: step.action ?? null,
        ok: false,
        code: error?.code ?? 'UNKNOWN',
        error: error?.message ?? String(error),
      })
      break
    }
    const text = outcome?.content?.find?.((block) => block.type === 'text')?.text
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text ? String(text).slice(0, 200) : null
    }
    const failedStep = outcome?.isError === true || payload?.ok === false
    results.push({
      index,
      action: step.action ?? null,
      ok: !failedStep,
      ...(failedStep ? { code: payload?.code ?? null, error: payload?.message ?? null, detail: payload?.detail ?? null } : {}),
      ...(failedStep ? {} : { summary: summarizeEdit(payload) }),
    })
    if (failedStep) break
  }
  const done = results.filter((item) => item.ok).length
  const stopped = results.length < ops.length
  return ok({
    ok: results.every((item) => item.ok),
    mode: 'batch',
    total: ops.length,
    done,
    stoppedEarly: stopped,
    results,
    ...(stopped
      ? { hint: '停在第一个失败处，后面的步骤没有执行。改掉那一步再提交剩下的（已完成的不要重做）。' }
      : {}),
  })
}

/** 批量结果里每步只留一句能核对的摘要，别把 8 份完整返回全塞回上下文。 */
function summarizeEdit(payload) {
  if (!payload || typeof payload !== 'object') return null
  const keep = ['ok', 'page', 'op', 'symbol', 'library', 'variant', 'deviceTag', 'at', 'from', 'to', 'inserted', 'connections', 'objects']
  const out = {}
  for (const key of keep) {
    if (payload[key] !== undefined) out[key] = payload[key]
  }
  return Object.keys(out).length > 0 ? out : null
}

async function runPageEditOnce(rawArgs) {
    // 先把同义写法收敛（draw/items/rects、type/kind、to/at…），再走后面的分支。
    const args = normalizeEditArgs(rawArgs)
    // 写操作前先过占用门：同一页正被另一个会话改时直接挡回去。
    // dryRun 只探路不写，不该被别人的占位挡住。
    let guard = null
    if (args.dryRun !== true && args.page) {
      guard = claimGuard(args.project, args.page, { force: args.force === true })
    }
    const guardNote = () => (guard?.tookOverFrom ? { claim: { tookOverFrom: guard.tookOverFrom } } : null)

    switch (args.action) {
      case 'insert_symbol': {
        // 兼容老的平铺写法：symbol / library / variant / at 直接在顶层。
        const spec = args.insert ?? {}
        const symbolName = spec.symbol ?? (typeof args.symbol === 'string' ? args.symbol : undefined)
        const at = spec.at ?? args.at
        need({ page: args.page, symbol: symbolName, at }, ['page', 'symbol', 'at'], 'insert_symbol')
        const written = await invokeWrite('symbol_insert', {
          project: args.project,
          page: args.page,
          library: spec.library ?? args.library,
          symbol: symbolName,
          variant: spec.variant ?? args.variant,
          at,
          deviceTag: spec.deviceTag ?? args.deviceTag,
          props: spec.props ?? args.props,
          dryRun: args.dryRun,
        })
        return withNote(
          await symbolHint(written, symbolName, spec.library ?? args.library, args.project),
          guardNote(),
        )
      }
      case 'set_properties': {
        if (!args.get && !args.set) {
          throw fail('BAD_ARGUMENT', 'set_properties 既没给 get 也没给 set。', '给 get 读属性，或给 set 写属性。')
        }
        const selector = {
          page: args.page,
          deviceTag: args.select?.deviceTag ?? args.deviceTag,
          objectId: args.select?.objectId ?? args.objectId,
          project: args.project,
        }
        if (!selector.page && !selector.deviceTag && !selector.objectId && !selector.project) {
          throw fail(
            'BAD_ARGUMENT',
            'set_properties 没有定位条件。',
            'select 里给 objectId 或 deviceTag，或给 page / project。',
          )
        }
        return withNote(
          await invoke('props', { selector, get: args.get, set: args.set, dryRun: args.dryRun }),
          guardNote(),
        )
      }
      case 'relocate':
      case 'relabel':
      case 'delete_placement': {
        const selector = {
          page: args.page,
          project: args.project,
          objectId: args.select?.objectId ?? args.objectId,
          deviceTag: args.select?.deviceTag ?? args.deviceTag,
          index: args.select?.index ?? args.index,
        }
        const hasSelector = Boolean(selector.objectId || selector.deviceTag || selector.index !== undefined)
        if (!hasSelector) {
          throw fail(
            'BAD_ARGUMENT',
            `${args.action} 需要选择对象。`,
            'select 里给 objectId（page_inspect view="list" 有）/ deviceTag / index 之一。',
          )
        }
        if (args.action === 'relabel') {
          need({ to: args.to }, ['to'], 'relabel')
          if (typeof args.to !== 'string') {
            throw fail(
              'BAD_ARGUMENT',
              `relabel 的 to 要的是字符串设备标识，收到的是 ${JSON.stringify(args.to)}。`,
              '写成 to:"-K2"。坐标用 at:[x,y]（relocate）；box 的右下角才写 [x,y]。',
            )
          }
          return withNote(
            hostOutdated(
              await invoke('placement_relabel', { selector, to: args.to, dryRun: args.dryRun }),
              'placement_relabel',
              '用 set_properties 改不了设备标识；先重建这个元件（page_edit action="insert_symbol" 到同一位置会多出一个），或等 EPLAN 重启。',
            ),
            guardNote(),
          )
        }
        if (args.action === 'delete_placement') {
          return withNote(
            hostOutdated(
              await invoke('placement_delete', { selector, dryRun: args.dryRun }),
              'placement_delete',
              '删一个对象现在只能整页重建，或等 EPLAN 重启后再删。',
            ),
            guardNote(),
          )
        }
        const at = args.at ?? args.relocate?.at
        const offset = args.offset ?? args.relocate?.offset
        if (!at && !offset) {
          throw fail(
            'BAD_ARGUMENT',
            'relocate 需要 at [x, y] 或 offset [dx, dy]。',
            '绝对坐标用 at，只平移用 offset。照这个写：{action:"relocate", page:"=EB3+ET1/1", select:{objectId:"2545"}, at:[110,275]}。' +
              'objectId 从 page_inspect{format:"structure",view:"list"} 的 rows[].id 拿。',
          )
        }
        return withNote(
          hostOutdated(
            await invoke('placement_move', { selector, at, offset, dryRun: args.dryRun }),
            'placement_move',
            '现在只能删页重建或重新插入这个元件。',
          ),
          guardNote(),
        )
      }
      case 'draw_graphics': {
        const items = args.draw ?? args.items
        need(
          { page: args.page, draw: items },
          ['page', 'draw'],
          'draw_graphics',
          '{action:"draw_graphics", page:"=EB3+ET1/1", draw:[{kind:"rect", from:[152,110], to:[196,204]}]}；'
            + 'kind 只能是 line / rect / text / polyline（写 type 也认）。',
        )
        return withNote(
          await invokeWrite('draw', {
            project: args.project,
            page: args.page,
            items,
            dryRun: args.dryRun,
          }),
          guardNote(),
        )
      }
      case 'box': {
        // 兼容老的平铺写法：from / to / deviceTag / pins 直接在顶层。
        const spec = args.box ?? args
        need({ page: args.page, from: spec.from, to: spec.to }, ['page', 'from', 'to'], 'box')
        return withNote(
          await invokeWrite('box', {
            project: args.project,
            page: args.page,
            from: spec.from,
            to: spec.to,
            color: spec.color,
            width: spec.width,
            deviceTag: spec.deviceTag,
            pins: spec.pins,
            dryRun: args.dryRun,
          }),
          guardNote(),
        )
      }
      default:
        throw fail(
          'BAD_ARGUMENT',
          `page_edit 不认识 action="${args.action}"。`,
          '可选：insert_symbol / set_properties / relocate / relabel / delete_placement / draw_graphics / box。' +
            '改一个已存在的对象（挪位置 / 改标识 / 删）用 relocate / relabel / delete_placement，别删整页重建。',
        )
    }
}

regTool(
  'page_delete',
  {
    title: '删除页面',
    description:
      '删除一整页。用于清理试画留下的过程页。只删页，不改页里的单个对象；页不存在会报错，不会静默成功。',
    inputSchema: z.object({
      page: z.string().describe('页名，例如 =MCP/7'),
      project,
      dryRun: z.boolean().optional().describe('只报告会删掉什么（页里有多少元件），不真的删。默认 false'),
      force: z
        .boolean()
        .optional()
        .describe('这一页被另一个会话占着时仍要删：传 true 接手占位。默认 false，会被 CLAIMED 挡回'),
    }),
  },
  async (args) => {
    if (args.dryRun !== true && args.page) claimGuard(args.project, args.page, { force: args.force === true })
    const result = await invoke('page_delete', args)
    // 页没了，占位也没有意义：顺手释放，别让一个已删除的页名占着锁。
    if (result.isError !== true && args.dryRun !== true && args.page) {
      try {
        releasePage({ project: args.project, page: args.page })
      } catch {
        // 没有台账文件也无所谓，删除已经成功了。
      }
    }
    return result
  },
)

// 同参数重复读的记忆：一页没改过时，第二次只回一句 unchanged，
// 不再把整份结构重发一遍（实测 341 KB 里的大部分都是这种重复）。
const inspectMemo = new RepeatMemo(64)
const symbolMemo = new RepeatMemo(64)

regTool(
  'page_inspect',
  {
    title: '看页面',
    description:
      '看一页。format=image 出渲染图（与窗口是否可见无关），文字部分只回页名/图路径/计数；format=both 结构+图一起给。\n' +
      'structure 配 view 三档：summary（默认，计数/坐标范围/设备标识/几何问题，约 1~3 KB）、\n' +
      'list（一行一对象带坐标）、full（含引脚相对坐标，最全）。\n' +
      '同参数且页面没变时返回 unchanged，不重复发全量。problems 每条都带 fix。',
    inputSchema: z.object({
      format: z.enum(['structure', 'image', 'both']).describe('要结构、要图，还是都要'),
      project,
      page: z.string().describe('页名，例如 "=EB3+ET1/1"'),
      view: z
        .enum(['summary', 'list', 'full'])
        .optional()
        .describe('structure 的详细程度，默认 summary。要知道坐标用 list，要引脚相对坐标用 full'),
      only: z
        .array(z.enum(['Function', 'InterruptionPoint', 'Text', 'Rectangle']))
        .optional()
        .describe('只返回这些类型的对象，例如 ["Function"]；list/full 生效'),
      limit: z.number().int().min(1).max(500).optional().describe('list/full 最多返回多少个对象，默认 200'),
      refresh: z
        .boolean()
        .optional()
        .describe('同参数且页面没变时默认回 unchanged；要强制重发全量传 true'),
      members: z
        .string()
        .optional()
        .describe('想查某个 EPLAN 类型的成员时填类名，例如 SymbolReference、Connection'),
      render: z
        .object({
          width: z.number().int().min(400).max(8000).optional().describe('图片像素宽度，默认 2000；看细节调到 3000~4000'),
          theme: z.enum(['dark', 'light']).optional().describe('配色，默认 dark；要白底交付图传 light'),
          image: z.boolean().optional().describe('是否真的返回图片，默认 true'),
        })
        .optional()
        .describe('出图选项（format=image / both 时有效）'),
      detail: z
        .boolean()
        .optional()
        .describe('format=image 时默认只给页名/图路径/计数；要连整份 functions 列表一起给就传 true'),
    }).passthrough(),
  },
  async (args) => {
    const view = args.view ?? 'summary'
    const renderOpts = args.render ?? {}
    const inspectArgs = { project: args.project, page: args.page, limit: args.limit, members: args.members }

    const structureResult = async () => {
      const raw = await callBridge('inspect', inspectArgs)
      const compacted = compactInspect(raw, { view, only: args.only, limit: args.limit })
      const key = `${args.project ?? ''}|${args.page}|${view}|${args.limit ?? ''}|${(args.only ?? []).join(',')}`
      const { repeat, digest: stamp } = inspectMemo.check(key, raw)
      if (repeat && args.refresh !== true) {
        return {
          page: args.page,
          view,
          unchanged: true,
          digest: stamp,
          hint: '这页自上次查看后没有变化，所以没有重发内容。要强制重发全量传 refresh=true。',
        }
      }
      return { ...compacted, digest: stamp }
    }

    if (args.format === 'structure') {
      try {
        return ok(await structureResult())
      } catch (error) {
        return failed('inspect', error)
      }
    }
    if (args.format === 'image') {
      return invokeLook({
        project: args.project,
        page: args.page,
        width: renderOpts.width ?? args.width,
        image: renderOpts.image ?? args.image,
        theme: renderOpts.theme ?? args.theme,
        detail: args.detail,
        view: args.view,
      })
    }
    if (args.format === 'both') {
      let structure
      try {
        structure = await structureResult()
      } catch (error) {
        return failed('inspect', error)
      }
      const shot = await invokeLook({
        project: args.project,
        page: args.page,
        width: renderOpts.width ?? args.width,
        image: renderOpts.image ?? args.image,
        theme: renderOpts.theme ?? args.theme,
        detail: args.detail,
        view: args.view,
      })
      return {
        content: [
          { type: 'text', text: JSON.stringify(structure) },
          ...shot.content.filter((block) => block.type !== 'text'),
        ],
      }
    }
    throw fail('BAD_ARGUMENT', `page_inspect 不认识 format="${args.format}"。`, '只支持 structure / image / both。')
  },
)

// 几何门禁的一条问题 → 一行能照着改的话。
const formatGeometry = (problem) => `${problem.where}：${problem.detail}（${problem.fix}）`

regTool(
  'validate',
  {
    title: '工程验收',
    description:
      '检查一页画得规不规范，并给出**能不能交付**的结论。EPLAN 不会因为画错而报错，所以交付前必须跑一次。\n' +
      'verdict 为 "pass" 才能交；"warn" 只有可读性问题（标签压字、设备标识重复）；"fail" 有硬伤，必须改。\n' +
      '检查两部分：EPLAN 自己的（手绘假导线、设备标识重复、不在栅格、孤立引脚、共用连接点）' +
      '和几何的（符号本体重叠、文字压符号、超图框）。两条都过才算过。\n' +
      'appearance 是版面看相：按邻近关系分组，量组间空隙、同列间距、四边余量，' +
      '用户说「散 / 挤 / 丑 / 聚拢一点 / 线修长一点」时照它的 issues 改，不要整页重画（它不进 verdict）。',
    inputSchema: z.object({
      project,
      page: z.string().describe('要检查的页名'),
      grid: z.number().optional().describe('栅格间距 mm，默认 4'),
      pageSize: z
        .array(z.number())
        .optional()
        .describe('页面尺寸 [宽, 高] mm；省略时按页名自动查，查不到就跳过越界检查'),
      expectDevices: z
        .array(z.string())
        .optional()
        .describe(
          '意图清单里的器件标识，例如 ["-F11","-K21","-U4"]。给了就核对页上是否真的都在：' +
            '缺的进 errors，多出来的报在 intent.extraSample。器件清单不要靠看渲染图数。',
        ),
    }),
  },
  async (args) => {
    const grid = Number.isFinite(args.grid) ? args.grid : 4

    let host = null
    let hostError = null
    try {
      host = await callBridge('check', { project: args.project, page: args.page, grid })
    } catch (error) {
      hostError = { code: error.code ?? 'UNKNOWN', message: error.message }
    }

    let raw = null
    try {
      raw = await callBridge('inspect', { project: args.project, page: args.page, limit: 500 })
    } catch {
      raw = null
    }

    // 页面尺寸：先看缓存（brief / list_pages 会顺手填），没有再问一次。
    let pageSize = Array.isArray(args.pageSize) ? args.pageSize : null
    if (pageSize === null) {
      const key = `${args.project ?? ''}|${args.page}`
      pageSize = pageSizeCache.get(key) ?? null
      if (pageSize === null) {
        try {
          const listing = await callBridge('pages', { project: args.project, filter: args.page, limit: 5 })
          const list = Array.isArray(listing) ? listing : (listing?.pages ?? [])
          const hit = list.find((page) => page?.name === args.page && Array.isArray(page.size))
          if (hit) {
            pageSize = hit.size
            pageSizeCache.set(key, pageSize)
          }
        } catch {
          // 查不到就跳过越界检查，不影响其余项。
        }
      }
    }

    // 宿主已经查过的项，几何层不再重复报一遍：同一件事说三遍只会稀释注意力。
    const hostCovers = new Set()
    if ((host?.offGridSample ?? []).length > 0) hostCovers.add('off_grid')
    if ((host?.summary?.sharedPinPoints ?? 0) > 0) hostCovers.add('shared_pin_point')
    if ((host?.duplicateTags ?? []).length > 0) hostCovers.add('duplicate_symbol')

    const geometry =
      raw === null
        ? []
        : geometryProblems(raw, { grid, pageSize }).filter((problem) => !hostCovers.has(problem.kind))
    const geometryErrors = geometry.filter((problem) => problem.kind !== 'label_overlap')
    const geometryWarnings = geometry.filter((problem) => problem.kind === 'label_overlap')

    const errors = [...(host?.problems ?? []), ...geometryErrors.map(formatGeometry)]
    const warnings = [...(host?.warnings ?? []), ...geometryWarnings.map(formatGeometry)]

    // 看相：只给数字和建议，不进 errors/warnings —— 审美不是硬伤，
    // 但用户说「散 / 挤 / 丑」的时候，这里就是唯一能照做的依据。
    const appearance = raw === null ? null : appearanceReport(raw, { pageSize })

    // 意图层：器件清单是不是齐的。这是机器能判的部分，不该让模型靠看渲染图数数。
    let intent = null
    if (Array.isArray(args.expectDevices) && args.expectDevices.length > 0) {
      const expected = [...new Set(args.expectDevices.map((tag) => String(tag).trim()).filter(Boolean))]
      // 器件名在 EPLAN 里带结构前缀（=+-F11），设备标识部分从第一个 "-" 开始。
      const tags = []
      for (const fn of raw?.functions ?? []) {
        const name = typeof fn?.name === 'string' ? fn.name : ''
        const cut = name.indexOf('-')
        if (cut >= 0) tags.push(name.slice(cut))
      }
      const unique = [...new Set(tags)]
      const matched = new Set()
      for (const tag of unique) {
        for (const want of expected) {
          if (tag === want || tag.startsWith(`${want}:`)) matched.add(want)
        }
      }
      const missing = expected.filter((want) => !matched.has(want))
      const extra = unique.filter((tag) => !expected.some((want) => tag === want || tag.startsWith(`${want}:`)))
      intent = {
        expected: expected.length,
        found: matched.size,
        missing,
        extraCount: extra.length,
        extraSample: extra.slice(0, 8),
        ...(raw === null ? { skipped: '读不到页面结构，器件清单没核对' } : {}),
      }
      if (missing.length > 0) errors.push(`意图清单里的器件没找到：${missing.join('、')}`)
    }

    const verdict = errors.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass'

    const summary = host?.summary ?? {}
    return ok({
      page: args.page,
      project: args.project,
      verdict,
      ...(intent === null ? {} : { intent }),
      counts: {
        ...summary,
        offGrid: (host?.offGridSample ?? []).length,
        noTag: (host?.noTagSample ?? []).length,
        duplicateTagGroups: (host?.duplicateTags ?? []).length,
        geometryErrors: geometryErrors.length,
        geometryWarnings: geometryWarnings.length,
      },
      errors,
      warnings,
      info: host?.info ?? [],
      ...(geometry.length > 0 ? { geometry: geometry.slice(0, 20) } : {}),
      ...(appearance && appearance.items > 0
        ? {
            appearance: {
              items: appearance.items,
              groups: appearance.groups,
              gaps: appearance.gaps ?? [],
              pitches: appearance.pitches ?? null,
              ...(appearance.margins ? { margins: appearance.margins } : {}),
              ...(appearance.issues?.length ? { issues: appearance.issues } : { issues: [] }),
              note:
                appearance.issues?.length
                  ? '这些是版面观感问题，不影响能不能交付；用户说「散 / 挤 / 丑」时按 issues 里的 fix 改，别整页重画。'
                  : null,
            },
          }
        : {}),
      ...(host?.offGridSample?.length ? { offGridSample: host.offGridSample.slice(0, 8) } : {}),
      ...(host?.duplicateTags?.length ? { duplicateTags: host.duplicateTags } : {}),
      ...(hostError ? { hostError } : {}),
      ...(raw === null ? { geometrySkipped: '读不到页面结构，几何检查没跑' } : {}),
      hint:
        verdict === 'pass'
          ? '可以交付。交付前再出一张图核对一眼。'
          : verdict === 'warn'
            ? '能交付，但上面 warnings 里每条都值得看一眼：能改就改，改不了就在汇报里说明。'
            : '先修 errors，每条的括号里就是改法；修完重新 validate 一次。',
    })
  },
)

regTool(
  'export',
  {
    title: '导出图纸',
    description:
      '把项目或指定页导出成 PNG / PDF / DXF。PNG 默认深色底；要交付给别人的白底图传 theme="light"。PDF/DXF 不受影响。\n' +
      '大项目或整本 PDF 可能超过 run_code 的 120 秒：传 wait:false 立刻回 jobId，再用 workspace({action:"wait"}) 取文件清单。',
    inputSchema: z.object({
      project,
      kind: z.enum(['png', 'pdf', 'dxf']).describe('导出格式'),
      pages: z.array(z.string()).optional().describe('页名列表；省略表示整个项目'),
      outDir: z.string().optional().describe('输出目录；省略则用项目目录下的 _eplan_export'),
      fileName: z.string().optional().describe('输出文件名（不含扩展名）'),
      theme: z
        .enum(['dark', 'light'])
        .optional()
        .describe('PNG 的配色，默认 dark；交付给别人的图纸一般要 light'),
      wait: z
        .boolean()
        .optional()
        .describe('是否等导出完成再返回，默认 true；false 立刻回 jobId，用 action="wait" 取'),
      waitMs: z
        .number()
        .int()
        .min(1000)
        .max(110000)
        .optional()
        .describe('最多等多少毫秒，默认 30000；等不到回 jobId 而不是报错'),
    }),
  },
  async (args) => {
    const { job, reused } = startExport(args)
    if (args.wait === false) return ok(jobPayload(job, reused ? { reused: true } : {}))
    const waitMs = Math.min(Math.max(Number(args.waitMs ?? 30000), 1000), 110000)
    await settleJob(job, waitMs)
    return jobBlocks(job, reused ? { reused: true } : { waitedMs: waitMs })
  },
)

regTool(
  'manual',
  {
    title: '读手册',
    description:
      '把 PDF 手册的页面渲染成图给你看，用来搞清楚手册里有什么图、端子怎么定义。' +
      '文字层是乱码的 PDF（没有 ToUnicode 映射）也能正常看，因为走的是渲染不是抽文字。\n' +
      'action="outline"：看总页数和目录，定页码范围。\n' +
      'action="search"：搜关键词（文字层可读时才有用）。\n' +
      'action="render"：把指定页画成图，一次最多 4 页（模型一步只收 8 张图，留余量）。',
    inputSchema: z.object({
      path: z.string().describe('PDF 绝对路径'),
      action: z.enum(['outline', 'search', 'render']).optional().describe('outline 看结构（默认）；search 搜关键词；render 渲染成图'),
      from: z.number().int().min(1).optional().describe('render 的起始页，默认 1'),
      to: z.number().int().min(1).optional().describe('render 的结束页。一次最多 4 页'),
      scale: z.number().min(1).max(4).optional().describe('渲染倍率，默认 2。看图细节时可调 3'),
      queries: z.array(z.string()).optional().describe('search 要搜的关键词'),
    }),
  },
  async (args) => invokePdf(args),
)

regTool(
  'operation_history',
  {
    title: '操作历史',
    description:
      '查这个项目上真实发生过的写操作（建页、插元件、改属性、画图、删页），含前后状态与能否回退。' +
      '记录由宿主在写操作落盘后自动追加，不需要你手动记。上下文丢了、想确认自己刚才改过什么、或者要撤回时用它。\n' +
      'action="wait"：等一个 present 任务跑完并取回结果（含渲染图）；present 传了 wait:false 后用它收尾。\n' +
      '记录只写不读、不自动进上下文，所以放心查。',
    inputSchema: z.object({
      action: z
        .enum(['list', 'wait'])
        .optional()
        .describe('list 查历史（默认）；wait 等 present job 的结果'),
      project: z.string().optional().describe('只看某个项目；省略则用当前项目'),
      page: z.string().optional().describe('只看某一页'),
      operation_id: z.string().optional().describe('只看某一次操作，可拿到它完整的前后状态'),
      jobId: z.string().optional().describe('action="wait" 要等的 present jobId'),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(110000)
        .optional()
        .describe('action="wait" 最多等多少毫秒，默认 25000；等不到会返回 state="running"'),
      limit: z.number().int().min(1).max(200).optional().describe('最多返回多少条，默认 30'),
    }),
  },
  async (args) => {
    if (args.action === 'wait') {
      need(args, ['jobId'], 'operation_history(wait)')
      gcJobs()
      const job = thatJob(args.jobId)
      if (!job) {
        return ok({
          jobId: args.jobId,
          state: 'unknown',
          hint: '找不到这个 job：可能已完成并过了保留期（15 分钟），或者 id 写错了。jobId 来自 present 的返回。',
        })
      }
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 25000), 1000), 110000)
      await settleJob(job, timeoutMs)
      // 图片文件在 job 完成时已落盘，这里直接按路径读，不额外占内存。
      if (job.state === 'done' && job.result?.imagePath) {
        return jobBlocks(job, { waitedMs: timeoutMs })
      }
      return ok(jobPayload(job, { waitedMs: timeoutMs }))
    }
    return invoke('op_history', {
      project: args.project,
      page: args.page,
      operation_id: args.operation_id,
      limit: args.limit,
    })
  },
)

regTool(
  'operation_rollback',
  {
    title: '撤回操作',
    description:
      '按 operation_id 撤回一次写操作。能撤的只有：**建页**（删掉这次建的那页）、**插元件**（删掉这个对象）。' +
      '删页、画图元、改属性**撤不了** —— 删页之前没留快照，画图和改属性没有可靠的反向操作。' +
      '这几类会返回 undone:false 和原因，不会假装成功。' +
      '已经撤过的再撤会返回 alreadyUndone:true 但什么都不做。' +
      '**EPLAN API 的改动不进 GUI 撤销栈**，Ctrl+Z 对它们无效，这是唯一的退路。',
    inputSchema: z.object({
      operation_id: z.string().describe('operation_history 返回的操作 id'),
    }),
  },
  async (args) => {
    need(args, ['operation_id'], 'rollback')
    return invoke('op_rollback', { operation_id: args.operation_id })
  },
)

/*
--------------------------------------------------------------------------------
经验文件：跨会话积累「什么路走不通、什么做法验证过」。
--------------------------------------------------------------------------------
和 symbol_catalog(action="annotate") 的区别：
  annotate     记「这个符号是什么」，按符号索引，同一个符号再记会覆盖；
  lesson       记「这个预设该怎么用」，只追加不覆盖，按时间倒序读。

为什么只追加：一条经验最值钱的部分常常是「当时是这么错的」。覆盖掉错误记录，
下一个人还会再错一次。所以宁可留着一堆历史，也不做原地更新。
*/
regTool(
  'lesson',
  {
    title: '经验文件',
    description:
      '跨会话留存的经验：踩到的坑、验证过的做法、被用户纠正过的判断。\n' +
      'action="add"：记一条。写上具体发生了什么、结论是什么，别写「注意 XX 」这种没信息量的话。\n' +
      'action="list"：读回来，可按关键词过滤，最新在前。\n' +
      '**什么时候该记**：用户纠正了你、某个参数/动作名和你以为的不一样、某个做法第一次跑通。' +
      '**什么时候别记**：一次性的坐标、页名、项目名 —— 那些属于操作历史，不叫经验。\n' +
      '最近 5 条会随 workspace(action="status") 一起返回，不用特意去翻。' +
      '这个工具直接读写本地文件，**不需要 EPLAN 在运行**。',
    inputSchema: z.object({
      action: z.enum(['add', 'list', 'prefer']).describe('add 记经验，prefer 记用户偏好，list 读回来'),
      text: z.string().optional().describe('add 的内容。要具体：什么操作、什么现象、什么结论'),
      kind: z
        .enum(['pitfall', 'recipe', 'decision'])
        .optional()
        .describe('add 的分类：pitfall 踩坑 / recipe 验证过的做法 / decision 做过的取舍，默认 pitfall'),
      scope: z
        .enum(['general', 'project', 'preference'])
        .optional()
        .describe('add 的作用域：general 通用 / project 只对本项目 / preference 用户偏好，默认按有无 project 推断'),
      brief: z.string().optional().describe('add / prefer 的一句话摘要（≤60 字），给 status 用'),
      prefer: z
        .object({
          source: z
            .enum(['user', 'inferred'])
            .optional()
            .describe('user 用户明说过 / inferred 从行为推断，默认 user'),
          weight: z.number().int().min(1).max(10).optional().describe('权重 1–10，默认 5'),
        })
        .optional()
        .describe('prefer 的选项'),
      tags: z.array(z.string()).optional().describe('add 的标签，便于以后筛选，例如 ["focus", "page_open"]'),
      query: z.string().optional().describe('list 的关键词过滤'),
      limit: z.number().int().min(1).max(200).optional().describe('list 最多返回多少条，默认 20'),
      project: z.string().optional().describe('add 时可选：这条经验出自哪个项目'),
      page: z.string().optional().describe('add 时可选：出自哪一页'),
    }).passthrough(),
  },
  async (args) => {
    // 本地实现，不走桥接器：EPLAN 没开也要能记、能读。
    if (args.action === 'add') {
      return ok(
        addNote({
          text: args.text,
          kind: args.kind,
          tags: args.tags,
          project: args.project,
          page: args.page,
          scope: args.scope,
          brief: args.brief,
        }),
      )
    }
    if (args.action === 'prefer') {
      return ok(
        addPreference({
          text: args.text,
          source: args.prefer?.source ?? args.source,
          weight: args.prefer?.weight ?? args.weight,
          tags: args.tags,
        }),
      )
    }
    if (args.action === 'list') {
      return ok(listNotes({ query: args.query, limit: args.limit }))
    }
    throw fail('BAD_ARGUMENT', `lesson 不认识 action="${args.action}"。`, '只支持 add / list / prefer。')
  },
)

// ---------------------------------------------------------------------------
// 启动：stdio 是唯一的传输方式；stdout 留给协议，日志一律走 stderr。
// ---------------------------------------------------------------------------

process.on('exit', () => stopBridge('进程退出'))
process.on('SIGINT', () => {
  stopBridge('收到 SIGINT')
  process.exit(0)
})

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write(`[eplan-mcp] 已启动，桥接器: ${config.bridgeExe}\n`)

