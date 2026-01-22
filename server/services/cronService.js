// 定时任务服务 - 每 15 分钟自动执行规则 + 数据同步任务
// 按照 README.md Phase 3 和 TASKS.md 1.4 节的要求实现
import cron from 'node-cron'
import { db } from '../db/drizzle.js'
import { rules } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import pool from '../db/connection.js'
import { RuleEngine } from '../index.js'
import { 
  syncAllAccountsTodayStats,
  syncAllAccountsSlidingWindow,
  archiveAllAccountsDailyStats
} from './ingestorService.js'

// 并发保护：防止重复执行
let isRunning = false
let lastExecutionTime = null
let lastExecutionResult = null

// 分布式锁：防止多实例（或多进程）同时跑 cron
// 使用 MySQL 的 GET_LOCK / RELEASE_LOCK
const CRON_LOCK_NAME = 'fb_ad_brain:cron:execute_rules'

async function tryAcquireDbLock() {
  const [rows] = await pool.execute('SELECT GET_LOCK(?, 0) AS acquired', [CRON_LOCK_NAME])
  return rows?.[0]?.acquired === 1
}

async function releaseDbLock() {
  try {
    await pool.execute('SELECT RELEASE_LOCK(?) AS released', [CRON_LOCK_NAME])
  } catch {
    // ignore
  }
}

/**
 * 执行所有启用的规则
 * 注意：规则按用户隔离，需要为每个用户分别执行
 */
async function executeAllRules() {
  // 并发保护：如果上次执行还没完成，跳过本次执行
  if (isRunning) {
    console.log('⏸️  上次规则执行尚未完成，跳过本次执行')
    return
  }

  isRunning = true
  const startTime = Date.now()
  
  try {
    // 分布式锁：确保只有一个实例在跑（多用户/多人同时使用时尤其重要）
    const acquired = await tryAcquireDbLock()
    if (!acquired) {
      console.log('⏸️  另一个实例正在执行规则任务（DB锁已占用），跳过本次执行')
      return
    }

    console.log('')
    console.log('='.repeat(50))
    console.log('🔄 开始执行定时规则任务（离线查询模式）')
    console.log('⏰ 执行时间:', new Date().toLocaleString('zh-CN'))
    console.log('📊 数据源: 数据库（ad_snapshots + daily_stats）')

    // 1. 从数据库获取所有启用的规则（使用 Drizzle）
    const enabledRules = await db
      .select()
      .from(rules)
      .where(eq(rules.enabled, true))
    
    console.log(`📋 找到 ${enabledRules.length} 条启用的规则`)

    if (enabledRules.length === 0) {
      console.log('✅ 没有启用的规则，任务完成')
      return
    }

    // 2. 按用户分组规则（因为每个用户可能有不同的广告账户）
    const rulesByUser = {}
    for (const rule of enabledRules) {
      const userId = rule.userId
      if (!rulesByUser[userId]) {
        rulesByUser[userId] = []
      }
      rulesByUser[userId].push(rule)
    }

    console.log(`👥 涉及 ${Object.keys(rulesByUser).length} 个用户`)

    // 3. 为每个用户执行规则（离线查询模式）
    // 注意：不再需要 Facebook API 客户端，完全从数据库查询数据
    const ruleEngine = new RuleEngine(null)  // 传入 null，因为新版本不需要 API
    
    let totalMatched = 0      // 匹配的广告数量（新版本返回匹配列表）
    let totalExecuted = 0     // 执行的规则数量（有匹配广告的规则）
    let totalSkipped = 0      // 跳过的规则数量（没有匹配广告的规则）
    let totalErrors = 0       // 错误数量

    for (const [userId, userRules] of Object.entries(rulesByUser)) {
      try {
        // 获取用户的广告账户（需要查询 account_mappings）
        const [userRows] = await pool.execute(
          `SELECT u.id, u.owner_id, o.owner_name 
           FROM users u 
           LEFT JOIN owners o ON u.owner_id = o.id 
           WHERE u.id = ? AND u.status = 'active'`,
          [userId]
        )

        if (userRows.length === 0) {
          console.log(`⚠️  用户 ${userId} 不存在或未激活，跳过`)
          continue
        }

        const user = userRows[0]
        console.log(`\n👤 处理用户: ${user.id} (负责人: ${user.owner_name || '无'})`)

        // 获取用户可见的广告账户
        const [accountRows] = await pool.execute(
          `SELECT fb_account_id FROM account_mappings WHERE owner_id = ? AND is_active = 1`,
          [user.owner_id || 0]
        )

        if (accountRows.length === 0) {
          console.log(`  ⚠️  用户没有分配的广告账户，跳过`)
          totalSkipped += userRules.length
          continue
        }

        // 为每个广告账户执行规则（离线查询模式）
        for (const accountRow of accountRows) {
          const accountId = accountRow.fb_account_id
          console.log(`  📊 处理广告账户: ${accountId}`)

          try {
            // 执行用户的规则（离线查询模式）
            // 新版本 evaluateRule 传入 accountId（字符串），会从数据库查询数据
            for (const rule of userRules) {
              try {
                // 新版本调用：传入 accountId 字符串，返回匹配的广告列表
                const matchedAds = await ruleEngine.evaluateRule(rule, accountId)
                
                // 新版本返回值：Array（匹配的广告列表），而不是 boolean
                if (Array.isArray(matchedAds) && matchedAds.length > 0) {
                  console.log(`    ✅ 规则 "${rule.ruleName}" 匹配 ${matchedAds.length} 个广告`)
                  console.log(`       匹配的广告: ${matchedAds.map(ad => ad.ad_id || ad.ad_name || '未知').join(', ')}`)
                  
                  totalMatched += matchedAds.length
                  totalExecuted++
                  
                  // TODO: 这里可以添加动作执行逻辑（暂停广告、调整预算等）
                  // 当前阶段只记录匹配结果，不执行实际动作
                  // 后续可以在 M4 阶段实现动作执行
                } else {
                  // 没有匹配的广告
                  totalSkipped++
                }
              } catch (error) {
                console.error(`    ❌ 执行规则 "${rule.ruleName}" 失败:`, error.message)
                totalErrors++
              }
            }
          } catch (error) {
            console.error(`    ❌ 处理账户 ${accountId} 失败:`, error.message)
            totalErrors++
          }
        }
      } catch (error) {
        console.error(`❌ 处理用户 ${userId} 失败:`, error.message)
        totalErrors++
      }
    }

    const duration = Date.now() - startTime
    console.log('')
    console.log('='.repeat(50))
    console.log(`✅ 规则执行完成（离线查询模式）`)
    console.log(`📊 统计:`)
    console.log(`   - 匹配广告: ${totalMatched} 个`)
    console.log(`   - 执行规则: ${totalExecuted} 条（有匹配广告）`)
    console.log(`   - 跳过规则: ${totalSkipped} 条（无匹配广告）`)
    console.log(`   - 错误: ${totalErrors} 次`)
    console.log(`⏱️  耗时: ${duration}ms`)
    console.log('='.repeat(50))
    console.log('')

    lastExecutionTime = new Date()
    lastExecutionResult = { 
      totalMatched, 
      totalExecuted, 
      totalSkipped, 
      totalErrors, 
      durationMs: duration 
    }
  } catch (error) {
    console.error('❌ 定时任务执行失败:', error)
    console.error('❌ 错误堆栈:', error.stack)
  } finally {
    await releaseDbLock()
    isRunning = false
  }
}

/**
 * 启动定时任务
 * - 每 15 分钟执行一次规则（cron 表达式：每 15 分钟一次）
 * - 每 10 分钟同步一次 Today 数据（热数据）
 * - 每 10 分钟检查一次冷数据归档（高频检查 + 账户本地 06:00 窗口）
 * - 【过渡期】每天 06:00 执行冷数据落盘（旧版本，稳定后移除）
 */
export function startCronJob() {
  console.log('')
  console.log('='.repeat(50))
  console.log('⏰ 启动定时任务服务')
  console.log('📅 任务列表:')
  console.log('  1. 规则执行: 每 15 分钟 (Cron: */15 * * * *)')
  console.log('  2. 数据同步: 每 10 分钟 (Cron: */10 * * * *)')
  console.log('  3. 滑动窗口同步: 每 30 分钟 (Cron: */30 * * * *) [解决归因延迟]')
  console.log('  4. 冷数据归档检查: 每 10 分钟 (Cron: */10 * * * *) [新版本]')
  console.log('  5. 冷数据落盘: 每天 06:00 (Cron: 0 6 * * *) [过渡期，稳定后移除]')
  console.log('='.repeat(50))
  console.log('')

  // 1. 每 15 分钟执行一次规则
  cron.schedule('*/15 * * * *', () => {
    executeAllRules()
  })

  // 2. 每 10 分钟同步一次 Today 数据（热数据）
  cron.schedule('*/10 * * * *', async () => {
    console.log('')
    console.log('='.repeat(50))
    console.log('🔄 开始定时同步 Today 数据（热数据）')
    console.log('⏰ 执行时间:', new Date().toLocaleString('zh-CN'))
    console.log('='.repeat(50))
    
    try {
      const result = await syncAllAccountsTodayStats()
      console.log(`✅ Today 数据同步完成，共 ${result.totalAccounts} 个账户，同步 ${result.totalSyncedCount} 条记录`)
    } catch (error) {
      console.error('❌ Today 数据同步失败:', error.message)
    }
    
    console.log('='.repeat(50))
    console.log('')
  })

  // 3. 每 30 分钟执行一次滑动窗口同步（Today + Past 7 Days）
  // 解决 Facebook 归因延迟导致的「迟到事件」
  cron.schedule('*/30 * * * *', async () => {
    console.log('')
    console.log('='.repeat(50))
    console.log('🔄 开始定时滑动窗口同步（解决归因延迟）')
    console.log('⏰ 执行时间:', new Date().toLocaleString('zh-CN'))
    console.log('📊 同步范围: Today + Past 7 Days')
    console.log('='.repeat(50))
    
    try {
      const result = await syncAllAccountsSlidingWindow()
      console.log(`✅ 滑动窗口同步完成，共 ${result.totalAccounts} 个账户`)
      console.log(`   - Today 数据: ${result.totalTodayCount || 0} 条（ad_snapshots）`)
      console.log(`   - 按日数据: ${result.totalDailyStatsCount || 0} 条（daily_stats）`)
      console.log(`   - 合计: ${(result.totalTodayCount || 0) + (result.totalDailyStatsCount || 0)} 条记录`)
    } catch (error) {
      console.error('❌ 滑动窗口同步失败:', error.message)
    }
    
    console.log('='.repeat(50))
    console.log('')
  })

  // 4. 每 10 分钟检查一次冷数据归档（高频检查 + 账户本地 06:00 窗口）
  // 【新版本】按账户本地时区判断是否到达 06:00-06:09 窗口
  cron.schedule('*/10 * * * *', async () => {
    // 注意：这个任务与 Today 数据同步使用相同的 cron 表达式
    // 但执行逻辑不同，可以合并到同一个任务中，或者分开执行
    // 这里分开执行，便于独立控制和日志追踪
    
    try {
      // 调用新版本的 archiveAllAccountsDailyStats（高频检查模式）
      await archiveAllAccountsDailyStats(null, false)
    } catch (error) {
      console.error('❌ 冷数据归档检查失败:', error.message)
      // 不抛出错误，避免影响其他定时任务
    }
  })

  // 5. 每天 06:00 执行冷数据落盘（旧版本，过渡期保留）
  // 【过渡期】稳定后可以移除这个任务
  // 注意：新版本的高频检查已经覆盖了归档逻辑，这个任务主要是为了：
  // 1. 在过渡期提供双重保障
  // 2. 如果新版本有问题，旧版本可以兜底
  // 3. 稳定运行一段时间后，可以安全移除
  cron.schedule('0 6 * * *', async () => {
    console.log('')
    console.log('='.repeat(50))
    console.log('📦 开始定时冷数据落盘（旧版本，过渡期）')
    console.log('⏰ 执行时间:', new Date().toLocaleString('zh-CN'))
    console.log('⚠️  注意：这是过渡期任务，新版本高频检查已覆盖归档逻辑')
    console.log('='.repeat(50))
    
    try {
      // 使用 forceAll=true 强制归档所有账户（忽略时区窗口）
      // 这样可以确保即使新版本有问题，旧版本也能兜底
      const result = await archiveAllAccountsDailyStats(null, true)
      console.log(`✅ 冷数据落盘完成（旧版本），共 ${result.totalAccounts} 个账户，归档 ${result.totalArchivedCount} 条记录`)
    } catch (error) {
      console.error('❌ 冷数据落盘失败（旧版本）:', error.message)
    }
    
    console.log('='.repeat(50))
    console.log('')
  })

  console.log('✅ 定时任务已启动')
}

/**
 * 停止定时任务（如果需要）
 */
export function stopCronJob() {
  // node-cron 没有直接的停止方法
  // 如果需要停止，可以设置一个标志位
  console.log('⏸️  定时任务已停止')
}

/**
 * 手动触发规则执行（用于测试）
 */
export async function manualExecute() {
  console.log('🔧 手动触发规则执行')
  await executeAllRules()
}

export function getCronStatus() {
  return {
    isRunning,
    lastExecutionTime,
    lastExecutionResult
  }
}

/**
 * 手动触发数据同步任务（用于测试）
 */
export async function manualSyncToday() {
  console.log('🔧 手动触发 Today 数据同步')
  try {
    const result = await syncAllAccountsTodayStats()
    console.log(`✅ 手动同步完成，共 ${result.totalAccounts} 个账户，同步 ${result.totalSyncedCount} 条记录`)
    return result
  } catch (error) {
    console.error('❌ 手动同步失败:', error.message)
    throw error
  }
}

/**
 * 手动触发冷数据落盘（用于测试）
 * 注意：使用强制模式（forceAll=true），绕过时区窗口和跳过检查，确保立即补齐缺失数据
 */
export async function manualArchive() {
  console.log('🔧 手动触发冷数据落盘（强制模式）')
  try {
    // 使用 forceAll=true 强制归档，绕过时区窗口和跳过检查
    // 这样可以确保即使已有部分记录，也会执行完整性检查并补齐缺失
    const result = await archiveAllAccountsDailyStats(null, true)
    console.log(`✅ 手动落盘完成，共 ${result.totalAccounts} 个账户，归档 ${result.totalArchivedCount} 条记录`)
    return result
  } catch (error) {
    console.error('❌ 手动落盘失败:', error.message)
    throw error
  }
}

