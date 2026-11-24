// launch 的决策：探测不到 ≠ 没在跑。这一条写错的代价是两个 EPLAN 互相弹硬件错误。
//   node test/launch-offline.mjs
import { decideLaunch } from '../server/launch-decision.mjs'

let pass = 0
let fail = 0
const check = (name, got, want) => {
  if (got === want) {
    pass += 1
    console.log(`  ✓ ${name}  → ${got}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}  期望 ${want}，实际 ${got}`)
  }
}

check('已经 ready 就别再起', decideLaunch({ ready: true, processes: [1] }), 'already')
check('没进程、没回话 → 可以起', decideLaunch({ ready: false, answered: false, processes: [] }), 'go')
check('有进程、没回话 → 等，别开第二个', decideLaunch({ ready: false, answered: false, processes: [4242] }), 'wait')
check('有进程、回了 but not ready（启动中）→ 等', decideLaunch({ ready: false, answered: true, processes: [4242] }), 'wait')
check('force 时照起', decideLaunch({ ready: false, processes: [4242], force: true }), 'go')
check('force 且已 ready 也照起（明确要多实例）', decideLaunch({ ready: true, processes: [4242], force: true }), 'go')
check('processes 给 null 不炸', decideLaunch({ ready: false, processes: null }), 'go')
check('空对象不炸', decideLaunch(), 'go')
check('两个实例也算 wait（不是 already）', decideLaunch({ ready: false, processes: [1, 2] }), 'wait')

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass}/${pass + fail}`)
process.exitCode = fail === 0 ? 0 : 1
