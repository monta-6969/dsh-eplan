/**
 * launch 的决策：什么时候可以真的去起一个 EPLAN.exe。
 *
 * 纯函数，单独成文件是为了能测 —— 这段判断出错的实际代价很大：
 * 2026-11-24 实测，一个会话把「status 超时」当成「EPLAN 没开」，于是多起了一个实例，
 * 两个 EPLAN 抢同一个项目和数据目录，两边轮流弹「硬件错误:存储器访问受阻」，
 * 谁都干不了活，最后只能全部杀掉重来。
 *
 * 输入：
 *   ready      —— status 是否回了 ready:true
 *   answered   —— status 是否有回话（哪怕回的是 not ready）
 *   processes  —— 本机 EPLAN.exe 的进程号
 *   force      —— 调用方是否明确要再起一个
 * 输出：
 *   'already'  —— 已经在跑且 API 通了，不用起
 *   'wait'     —— 有进程但没回话：等它启动 / 等人关框，不要起第二个
 *   'go'       —— 确实没有 EPLAN，可以起
 */
export function decideLaunch({ ready = false, answered = true, processes = [], force = false } = {}) {
  if (force) return 'go'
  if (ready === true) return 'already'
  // 关键的一条：探测失败不等于不存在。只要进程在，就宁可让调用方等。
  if (Array.isArray(processes) && processes.length > 0) return 'wait'
  // status 没回话、也没有进程：可能 EPLAN 刚被杀掉，主线程还在收尾；这种情况允许起。
  return 'go'
}
