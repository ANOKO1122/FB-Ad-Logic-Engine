/**
 * M4 3.2 预算幂等 — 纯函数 computeNewBudgetCentsOnce 验证脚本
 * 运行方式（在项目根目录）：node server/tests/verify-budget-once.js
 */

import { computeNewBudgetCentsOnce } from '../services/actionExecutorService.js'

const cases = [
  { name: '1000 分 +10% => 1100', cents: 1000, action: { type: 'increase_budget', value: 10 }, expected: 1100 },
  { name: '1000 分 -10% => 900', cents: 1000, action: { type: 'decrease_budget', value: 10 }, expected: 900 },
  { name: '1000 分 -99% 下限护栏 => 100', cents: 1000, action: { type: 'decrease_budget', value: 99 }, expected: 100 },
  { name: '500 分 上限 300 分 => 300', cents: 500, action: { type: 'increase_budget', value: 50, max_daily_budget: 300 }, expected: 300 },
  { name: '未知 type 走减少分支(默认10%) => 900', cents: 1000, action: { type: 'unknown' }, expected: 900 }
]

let passed = 0
for (let i = 0; i < cases.length; i++) {
  const c = cases[i]
  const actual = computeNewBudgetCentsOnce(c.cents, c.action)
  const ok = actual === c.expected
  if (ok) passed++
  console.log(`[${i + 1}] ${c.name} => 期望 ${c.expected}, 实际 ${actual}  ${ok ? '✓ 通过' : '✗ 失败'}`)
}
console.log(passed === cases.length ? '全部通过' : `通过 ${passed}/${cases.length}`)
process.exit(passed === cases.length ? 0 : 1)
