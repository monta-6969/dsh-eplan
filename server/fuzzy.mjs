/**
 * 名字相近度：给「库里没有这个符号」的报错配候选。
 *
 * 为什么单独成文件：纯函数，值得单独测，也不想为了测一个编辑距离就把整个 MCP 服务
 * 加载起来（server.mjs 一 import 就连 bridge、注册工具）。
 *
 * 2026-11-24 session-400917a2：模型认定「DCP」是电抗器，连撞 8 次 SYMBOL_NOT_FOUND。
 * 错的不是它重试，是错误只说「没有」不说「库里有这些」。
 */

/** 经典 Levenshtein，两行滚动数组，名字都很短，没必要上更花哨的算法。 */
export function editDistance(a, b) {
  const s = String(a ?? '')
  const t = String(b ?? '')
  if (s === t) return 0
  if (s.length === 0) return t.length
  if (t.length === 0) return s.length
  const prev = new Array(t.length + 1)
  for (let j = 0; j <= t.length; j += 1) prev[j] = j
  for (let i = 1; i <= s.length; i += 1) {
    let diagonal = prev[0]
    prev[0] = i
    for (let j = 1; j <= t.length; j += 1) {
      const saved = prev[j]
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (s[i - 1] === t[j - 1] ? 0 : 1),
      )
      diagonal = saved
    }
  }
  return prev[t.length]
}

/**
 * 名字相近的候选：先比编辑距离，再比前缀，够不着就返回空。
 *
 * 预算按名字长度放宽，但三字以内的短名只收一位之差：
 * 三个字母的名字差两个字母已经是「另一个词」了，把 SSA 推荐给写 LSW 的人只是噪声。
 * 返回空数组是有意义的结论：「库里没有相近的」，调用方据此换策略而不是原样重试。
 */
export function closestSymbolNames(target, names, limit = 5) {
  const want = String(target ?? '').toUpperCase().trim()
  if (!want || !Array.isArray(names)) return []
  const budget = want.length <= 3 ? 1 : Math.ceil(want.length / 2)
  const scored = []
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) continue
    const upper = name.toUpperCase()
    let distance = editDistance(want, upper)
    if (upper.startsWith(want) || want.startsWith(upper)) distance -= 1
    if (distance <= budget) scored.push({ name, distance })
  }
  scored.sort((a, b) => a.distance - b.distance || a.name.length - b.name.length)
  return [...new Set(scored.slice(0, limit).map((item) => item.name))]
}
