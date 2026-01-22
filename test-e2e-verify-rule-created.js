// ============================================
// 端到端验证：验证规则创建（前端 → 后端）
// 目的：验证从前端创建规则到后端存储的完整流程
// ============================================

import pool from './server/db/connection.js'
import { db } from './server/db/drizzle.js'
import { rules } from './server/db/schema.js'
import { eq, like } from 'drizzle-orm'

async function verifyRuleCreated() {
  console.log('')
  console.log('='.repeat(50))
  console.log('端到端验证：验证规则创建（前端 → 后端）')
  console.log('='.repeat(50))
  console.log('')
  
  try {
    // 1. 查找测试规则（通过规则名称）
    const testRuleName = 'E2E测试规则-离线查询'
    
    console.log(`🔍 查找规则: "${testRuleName}"`)
    console.log('')
    
    const foundRules = await db
      .select()
      .from(rules)
      .where(like(rules.ruleName, `%E2E测试%`))
    
    if (foundRules.length === 0) {
      console.log('⚠️  没有找到测试规则')
      console.log('')
      console.log('💡 提示：')
      console.log('   1. 请先在前端创建规则（规则名称包含"E2E测试"）')
      console.log('   2. 规则配置：')
      console.log('      - 条件：花费 > 10')
      console.log('      - 时间窗口：today（重要！）')
      console.log('      - 操作：暂停广告')
      console.log('   3. 保存规则后，重新运行此脚本')
      console.log('')
      return false
    }
    
    const rule = foundRules[0]
    console.log(`✅ 找到规则: "${rule.ruleName}" (ID: ${rule.id})`)
    console.log('')
    
    // 2. 验证规则配置
    console.log('📋 验证规则配置:')
    console.log(`   - 规则ID: ${rule.id}`)
    console.log(`   - 规则名称: ${rule.ruleName}`)
    console.log(`   - 用户ID: ${rule.userId}`)
    console.log(`   - 是否启用: ${rule.enabled ? '✅ 是' : '❌ 否'}`)
    console.log(`   - 时区: ${rule.timezoneName || 'UTC（默认）'}`)
    console.log('')
    
    // 3. 验证 conditions 字段
    const conditions = rule.conditions || []
    console.log('📋 验证条件配置:')
    if (Array.isArray(conditions) && conditions.length > 0) {
      conditions.forEach((cond, index) => {
        console.log(`   条件 ${index + 1}:`)
        console.log(`     - 指标: ${cond.metric || '未知'}`)
        console.log(`     - 操作符: ${cond.operator || '未知'}`)
        console.log(`     - 值: ${cond.value || '未知'}`)
        console.log(`     - 时间窗口: ${cond.time_window || 'today（默认）'}`)
      })
    } else {
      console.log('   ⚠️  条件配置为空')
    }
    console.log('')
    
    // 4. 验证规则关联的账户
    console.log('📋 验证规则关联的账户:')
    const [userRows] = await pool.execute(
      `SELECT owner_id FROM users WHERE id = ? AND status = 'active'`,
      [rule.userId]
    )
    
    if (userRows.length === 0) {
      console.log('   ⚠️  用户不存在或未激活')
      return false
    }
    
    const ownerId = userRows[0].owner_id
    const [accountRows] = await pool.execute(
      `SELECT fb_account_id, timezone_name, is_active
       FROM account_mappings
       WHERE owner_id = ? AND is_active = 1`,
      [ownerId]
    )
    
    if (accountRows.length === 0) {
      console.log('   ⚠️  用户没有关联的活跃账户')
      return false
    }
    
    console.log(`   ✅ 找到 ${accountRows.length} 个关联账户:`)
    accountRows.forEach(account => {
      console.log(`     - ${account.fb_account_id} (时区: ${account.timezone_name || 'UTC'})`)
    })
    console.log('')
    
    // 5. 验证测试账户
    const testAccountId = 'act_927139705822379'
    const hasTestAccount = accountRows.some(acc => acc.fb_account_id === testAccountId)
    
    if (hasTestAccount) {
      console.log(`   ✅ 包含测试账户: ${testAccountId}`)
    } else {
      console.log(`   ⚠️  不包含测试账户: ${testAccountId}`)
      console.log(`   💡 提示：规则将使用其他账户执行`)
    }
    console.log('')
    
    // 6. 总结
    console.log('='.repeat(50))
    console.log('✅ 规则创建验证通过')
    console.log('='.repeat(50))
    console.log('')
    console.log('📋 验证结果:')
    console.log(`   - 规则已创建: ✅`)
    console.log(`   - 规则已启用: ${rule.enabled ? '✅' : '❌'}`)
    console.log(`   - 条件配置: ${conditions.length > 0 ? '✅' : '❌'}`)
    console.log(`   - 时间窗口: ${conditions.some(c => c.time_window) ? '✅' : '⚠️  使用默认值 today'}`)
    console.log(`   - 关联账户: ${accountRows.length > 0 ? `✅ ${accountRows.length} 个` : '❌'}`)
    console.log('')
    console.log('💡 下一步：')
    console.log('   1. 在前端点击"立即运行所有规则"')
    console.log('   2. 运行验证脚本: node test-e2e-verify-offline-query.js')
    console.log('')
    
    return true
  } catch (error) {
    console.error('❌ 验证失败:', error.message)
    console.error('   错误堆栈:', error.stack)
    return false
  } finally {
    await pool.end()
  }
}

// 执行验证
verifyRuleCreated()

