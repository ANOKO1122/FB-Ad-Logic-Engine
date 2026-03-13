/**
 * 单次执行历史表清理（与每日 04:30 Cron 逻辑一致）
 *
 * 使用：node server/scripts/run-history-cleanup.js
 *
 * 可选环境变量（与 cronService 一致）：
 *   HISTORY_RETENTION_DAYS_MATCHED  默认 30（rule_matched_objects_history）
 *   HISTORY_RETENTION_DAYS_ADS     默认 60（structure_ads_history）
 *   HISTORY_RETENTION_DAYS_RULE    默认 60（rule_history）
 */

import 'dotenv/config'
import { runNightlyHistoryCleanup } from '../services/cronService.js'

const retentionMatched = Number(process.env.HISTORY_RETENTION_DAYS_MATCHED) || 30
const retentionAds = Number(process.env.HISTORY_RETENTION_DAYS_ADS) || 60
const retentionRule = Number(process.env.HISTORY_RETENTION_DAYS_RULE) || 60

console.log('')
console.log('='.repeat(50))
console.log('🔧 单次执行：历史表清理')
console.log('   保留期: rule_matched_objects_history %d 天, structure_ads_history/rule_history %d 天', retentionMatched, retentionAds)
console.log('='.repeat(50))
console.log('')

try {
  const result = await runNightlyHistoryCleanup({
    retentionDaysMatched: retentionMatched,
    retentionDaysAds: retentionAds,
    retentionDaysRule: retentionRule
  })

  console.log('✅ 清理完成')
  console.log('   rule_matched_objects_history:', result.matchedDeleted)
  console.log('   structure_ads_history:      ', result.adsDeleted)
  console.log('   rule_history:              ', result.ruleDeleted)
  console.log('   合计删除:                  ', result.totalDeleted)
  console.log('')
  console.log('='.repeat(50))
  process.exit(0)
} catch (err) {
  console.error('❌ 清理失败:', err?.message ?? err)
  if (err?.stack) console.error(err.stack)
  process.exit(1)
}
