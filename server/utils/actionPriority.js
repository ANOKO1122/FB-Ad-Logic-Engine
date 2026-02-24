/**
 * M4 动作执行层：动作优先级与仲裁约定
 *
 * 【教学：为什么要单独一个文件？】
 * - 仲裁逻辑（谁先执行、同优先级谁赢）是「业务口径」，和「怎么调 API」解耦。
 * - 集中在一个文件里，产品改「暂停优先于激活」时只改这里，不用翻 actionExecutorService。
 * - 面试常问：你们多规则冲突怎么处理？答「按优先级常量 + ruleId 做 tie-break」即可。
 *
 * 【约定来源】TASKS.md 3.0 / DEV_PLAN M4 硬口径：
 * - tie-break 写死：pause_ad 优先于 activate_ad（数字小的优先）。
 * - 同优先级、同动作类型去重时，赢家为 ruleId 最小者（在仲裁层实现）。
 */

/** 动作类型 → 优先级数字（越小越优先，用于仲裁时比较） */
export const ACTION_PRIORITY = {
  pause_ad: 1,
  activate_ad: 2,
  decrease_budget: 3,
  increase_budget: 4,
  set_budget: 5
}

/**
 * 根据动作类型取优先级数字；未知类型返回极大值，排到最后
 * @param {string} actionType - 如 'pause_ad' | 'activate_ad' | 'decrease_budget' | 'increase_budget'
 * @returns {number}
 */
export function getActionPriority(actionType) {
  if (!actionType || typeof actionType !== 'string') return Number.MAX_SAFE_INTEGER
  const p = ACTION_PRIORITY[actionType]
  return p !== undefined ? p : Number.MAX_SAFE_INTEGER
}

/**
 * 从一条规则的 actions 数组中选出「最狠的一条」参与仲裁（M4 约定：每规则每 ad 只出一个候选）
 * 比较规则：优先级数字小的优先；同优先级取数组第一条（配置顺序）
 *
 * @param {Array<{ type: string, value?: number, max_daily_budget?: number }>} actions - rule.actions
 * @returns {{ type: string, value?: number, max_daily_budget?: number } | null} 单条候选动作，无则 null
 */
export function pickSingleCandidateAction(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return null
  let best = actions[0]
  let bestPriority = getActionPriority(best?.type)
  for (let i = 1; i < actions.length; i++) {
    const p = getActionPriority(actions[i]?.type)
    if (p < bestPriority) {
      best = actions[i]
      bestPriority = p
    }
  }
  return best
}
