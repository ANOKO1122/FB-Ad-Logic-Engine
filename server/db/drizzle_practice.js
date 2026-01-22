// Drizzle ORM 实践练习文件
// 
// ⚠️ 重要说明：
// 1. 这个文件是学习用的，展示 Drizzle 的用法
// 2. 实际开发中，你应该用 Drizzle，不要手写 SQL
// 3. SQL 只是用来理解原理的（在 MySQL 中手动执行，理解数据库操作）
// 4. 业务代码中，所有 CRUD 操作都用 Drizzle
//
// 📚 学习流程：
// 步骤1：在 MySQL 中手动执行 SQL（理解原理）
// 步骤2：运行这个文件，看 Drizzle 如何实现（学习用法）
// 步骤3：在实际项目中，只用 Drizzle，不写 SQL（实际开发）

import { db } from './drizzle.js'
import { rules } from './schema.js'
import { eq, and, like, desc, count } from 'drizzle-orm'

// ============================================
// 练习 1：插入数据（CREATE）
// ============================================
async function practiceInsert() {
  console.log('\n📝 练习 1：插入数据')
  console.log('对应的 SQL: INSERT INTO rules (user_id, rule_name, conditions, actions, enabled) VALUES (...)')
  
  try {
    const newRule = await db.insert(rules).values({
      userId: 1,
      ruleName: '止损规则-测试',
      conditions: [
        { metric: 'ctr', operator: 'lt', value: 0.8 },
        { metric: 'spend', operator: 'gt', value: 20 }
      ],
      actions: [
        { type: 'pause_ad' }
      ],
      enabled: true
    })
    
    console.log('✅ 插入成功！新规则 ID:', newRule[0].insertId)
    return newRule[0].insertId
  } catch (error) {
    console.error('❌ 插入失败:', error.message)
    throw error
  }
}

// ============================================
// 练习 2：查询所有数据（READ - 全部）
// ============================================
async function practiceSelectAll() {
  console.log('\n🔍 练习 2：查询所有规则')
  console.log('对应的 SQL: SELECT * FROM rules')
  
  try {
    const allRules = await db.select().from(rules)
    console.log(`✅ 查询成功！找到 ${allRules.length} 条规则`)
    console.log('规则列表:', JSON.stringify(allRules, null, 2))
    return allRules
  } catch (error) {
    console.error('❌ 查询失败:', error.message)
    throw error
  }
}

// ============================================
// 练习 3：条件查询（READ - WHERE）
// ============================================
async function practiceSelectWhere(userId) {
  console.log('\n🔍 练习 3：条件查询')
  console.log(`对应的 SQL: SELECT * FROM rules WHERE user_id = ${userId}`)
  
  try {
    const userRules = await db
      .select()
      .from(rules)
      .where(eq(rules.userId, userId))
    
    console.log(`✅ 查询成功！用户 ${userId} 有 ${userRules.length} 条规则`)
    return userRules
  } catch (error) {
    console.error('❌ 查询失败:', error.message)
    throw error
  }
}

// ============================================
// 练习 4：多条件查询（READ - AND）
// ============================================
async function practiceSelectMultipleConditions(userId) {
  console.log('\n🔍 练习 4：多条件查询')
  console.log(`对应的 SQL: SELECT * FROM rules WHERE user_id = ${userId} AND enabled = TRUE`)
  
  try {
    const enabledRules = await db
      .select()
      .from(rules)
      .where(
        and(
          eq(rules.userId, userId),
          eq(rules.enabled, true)
        )
      )
    
    console.log(`✅ 查询成功！用户 ${userId} 有 ${enabledRules.length} 条启用的规则`)
    return enabledRules
  } catch (error) {
    console.error('❌ 查询失败:', error.message)
    throw error
  }
}

// ============================================
// 练习 5：模糊搜索（READ - LIKE）
// ============================================
async function practiceSelectLike() {
  console.log('\n🔍 练习 5：模糊搜索')
  console.log("对应的 SQL: SELECT * FROM rules WHERE rule_name LIKE '%止损%'")
  
  try {
    const searchResults = await db
      .select()
      .from(rules)
      .where(like(rules.ruleName, '%止损%'))
    
    console.log(`✅ 搜索成功！找到 ${searchResults.length} 条包含"止损"的规则`)
    return searchResults
  } catch (error) {
    console.error('❌ 搜索失败:', error.message)
    throw error
  }
}

// ============================================
// 练习 6：排序和分页（READ - ORDER BY + LIMIT）
// ============================================
async function practiceSelectOrderBy() {
  console.log('\n🔍 练习 6：排序和分页')
  console.log('对应的 SQL: SELECT * FROM rules ORDER BY created_at DESC LIMIT 5')
  
  try {
    const sortedRules = await db
      .select()
      .from(rules)
      .orderBy(desc(rules.createdAt))
      .limit(5)
    
    console.log(`✅ 查询成功！找到最新的 5 条规则`)
    return sortedRules
  } catch (error) {
    console.error('❌ 查询失败:', error.message)
    throw error
  }
}

// ============================================
// 练习 7：统计数量（READ - COUNT）
// ============================================
async function practiceCount(userId) {
  console.log('\n🔍 练习 7：统计数量')
  console.log(`对应的 SQL: SELECT COUNT(*) as count FROM rules WHERE user_id = ${userId}`)
  
  try {
    const result = await db
      .select({ count: count() })
      .from(rules)
      .where(eq(rules.userId, userId))
    
    const ruleCount = result[0].count
    console.log(`✅ 统计成功！用户 ${userId} 有 ${ruleCount} 条规则`)
    return ruleCount
  } catch (error) {
    console.error('❌ 统计失败:', error.message)
    throw error
  }
}

// ============================================
// 练习 8：更新数据（UPDATE）
// ============================================
async function practiceUpdate(ruleId) {
  console.log('\n✏️ 练习 8：更新数据')
  console.log(`对应的 SQL: UPDATE rules SET rule_name = '新名称', updated_at = NOW() WHERE id = ${ruleId}`)
  
  try {
    const updated = await db
      .update(rules)
      .set({
        ruleName: '更新后的规则名称',
        updatedAt: new Date()
      })
      .where(eq(rules.id, ruleId))
    
    console.log('✅ 更新成功！影响行数:', updated[0].affectedRows)
    return updated
  } catch (error) {
    console.error('❌ 更新失败:', error.message)
    throw error
  }
}

// ============================================
// 练习 9：启用/禁用规则（UPDATE - 软删除）
// ============================================
async function practiceToggle(ruleId, enabled) {
  console.log('\n✏️ 练习 9：启用/禁用规则')
  console.log(`对应的 SQL: UPDATE rules SET enabled = ${enabled} WHERE id = ${ruleId}`)
  
  try {
    const updated = await db
      .update(rules)
      .set({ enabled })
      .where(eq(rules.id, ruleId))
    
    console.log(`✅ ${enabled ? '启用' : '禁用'}成功！影响行数:`, updated[0].affectedRows)
    return updated
  } catch (error) {
    console.error('❌ 操作失败:', error.message)
    throw error
  }
}

// ============================================
// 练习 10：删除数据（DELETE）
// ============================================
async function practiceDelete(ruleId) {
  console.log('\n🗑️ 练习 10：删除数据')
  console.log(`对应的 SQL: DELETE FROM rules WHERE id = ${ruleId}`)
  console.log('⚠️  警告：这会真正删除数据！建议使用软删除（更新 enabled = false）')
  
  try {
    const deleted = await db
      .delete(rules)
      .where(eq(rules.id, ruleId))
    
    console.log('✅ 删除成功！影响行数:', deleted[0].affectedRows)
    return deleted
  } catch (error) {
    console.error('❌ 删除失败:', error.message)
    throw error
  }
}

// ============================================
// 主函数：运行所有练习
// ============================================
async function runAllPractices() {
  console.log('🚀 开始 Drizzle ORM 实践练习')
  console.log('='.repeat(50))
  
  try {
    // 1. 插入数据
    const newRuleId = await practiceInsert()
    
    // 2. 查询所有数据
    await practiceSelectAll()
    
    // 3. 条件查询
    await practiceSelectWhere(1)
    
    // 4. 多条件查询
    await practiceSelectMultipleConditions(1)
    
    // 5. 模糊搜索
    await practiceSelectLike()
    
    // 6. 排序和分页
    await practiceSelectOrderBy()
    
    // 7. 统计数量
    await practiceCount(1)
    
    // 8. 更新数据（如果刚才插入了数据）
    if (newRuleId) {
      await practiceUpdate(newRuleId)
    }
    
    // 9. 启用/禁用（如果刚才插入了数据）
    if (newRuleId) {
      await practiceToggle(newRuleId, false)
      await practiceToggle(newRuleId, true)
    }
    
    // 10. 删除数据（注释掉，避免误删）
    // await practiceDelete(newRuleId)
    
    console.log('\n' + '='.repeat(50))
    console.log('✅ 所有练习完成！')
    
  } catch (error) {
    console.error('\n❌ 练习过程中出错:', error)
    process.exit(1)
  } finally {
    // 关闭数据库连接池
    const { connection } = await import('./drizzle.js')
    await connection.end()
    console.log('✅ 数据库连接已关闭')
    process.exit(0)
  }
}

// 如果直接运行这个文件，执行所有练习
// 注意：这是一个练习文件，直接运行时会执行所有练习

// 直接执行（因为这个文件主要用于练习，通常不会被 import）
runAllPractices().catch(error => {
  console.error('执行练习时出错:', error)
  process.exit(1)
})

// 导出所有函数，方便在其他文件中使用
export {
  practiceInsert,
  practiceSelectAll,
  practiceSelectWhere,
  practiceSelectMultipleConditions,
  practiceSelectLike,
  practiceSelectOrderBy,
  practiceCount,
  practiceUpdate,
  practiceToggle,
  practiceDelete
}

