#!/usr/bin/env node
// 清临时目录。
//
// %TEMP%\eplan-mcp 下三类东西一直是只增不减的：
//   look\  每次渲染一张 PNG；
//   pdf\   手册页面渲染出来的图，单个会话就能攒出几 MB；
//   backups\  旧版本写操作前复制的 .elk —— 那玩意儿只有 30 字节（真正数据在 .edb），
//             从来就不是备份，纯粹是垃圾。新版本已经不再产生它。
//
// ops\ 不动：那是 operation_rollback 的依据，按时间删等于毁掉回退能力。
// knowledge\ 不在临时目录（已迁到 %LOCALAPPDATA%），也不可能被这里扫到。
//
//   node native/script/prune.mjs            按默认策略清
//   node native/script/prune.mjs --dry-run  只报会删什么
//   node native/script/prune.mjs --keep 50  改保留数量
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const keepIndex = args.indexOf('--keep')
const keep = keepIndex >= 0 ? Number(args[keepIndex + 1]) : 200

const root = join(tmpdir(), 'eplan-mcp')
const pruneReport = []

function sizeOf(path) {
  try {
    const stat = statSync(path)
    return stat.isDirectory() ? 0 : stat.size
  } catch {
    return 0
  }
}

// 目录里文件太多时，按修改时间从旧到新删，直到只剩 keep 个。
function trimDir(name) {
  const dir = join(root, name)
  if (!existsSync(dir)) return

  let entries
  try {
    entries = readdirSync(dir)
      .map((entry) => ({ entry, path: join(dir, entry), time: statSync(join(dir, entry)).mtimeMs }))
      .filter((item) => {
        try {
          return statSync(item.path).isFile()
        } catch {
          return false
        }
      })
      .sort((a, b) => a.time - b.time)
  } catch {
    return
  }

  const excess = entries.slice(0, Math.max(0, entries.length - keep))
  let freed = 0
  for (const item of excess) {
    freed += sizeOf(item.path)
    if (!dryRun) {
      try {
        rmSync(item.path, { force: true })
      } catch {
        // 正在被别的进程读着就跳过，下次再说。
      }
    }
  }
  pruneReport.push({
    dir,
    total: entries.length,
    removed: excess.length,
    freedBytes: freed,
    ...(dryRun ? { dryRun: true } : {}),
  })
}

// backups 是历史遗留：整个目录清掉，新版本不会再往里写。
function dropLegacyBackups() {
  const dir = join(root, 'backups')
  if (!existsSync(dir)) return
  let count = 0
  let freed = 0
  try {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      freed += sizeOf(path)
      count += 1
      if (!dryRun) {
        try {
          rmSync(path, { force: true })
        } catch {}
      }
    }
    if (!dryRun && count > 0) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  } catch {
    return
  }
  pruneReport.push({
    dir,
    total: count,
    removed: count,
    freedBytes: freed,
    legacy: true,
    ...(dryRun ? { dryRun: true } : {}),
  })
}

trimDir('look')
trimDir('pdf')
dropLegacyBackups()

const freedTotal = pruneReport.reduce((sum, item) => sum + item.freedBytes, 0)
process.stdout.write(
  `${JSON.stringify(
    {
      root,
      keep,
      dryRun,
      freedBytes: freedTotal,
      details: pruneReport,
      untouched: ['ops（回退依据，不按时间删）'],
    },
    null,
    2,
  )}\n`,
)
