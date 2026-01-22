// 对比学习文件：手动执行 SQL 后，运行对应的 Drizzle 代码对比结果
// 
// 📚 使用方法：
// 1. 在 MySQL 中手动执行 SQL（理解原理）
// 2. 取消下面某个函数的注释
// 3. 运行：node server/db/对比学习.js
// 4. 对比 SQL 和 Drizzle 的结果是否一致

import { db } from './drizzle.js'
import { rules } from './schema.js'
import { eq, and, like, desc } from 'drizzle-orm'

// ============================================
// 练习 1：插入数据
// ============================================
async function 练习1_插入数据() {
  console.log('\n📝 练习 1：插入数据')
  console.log('='.repeat(50))
  
  // 对应的 SQL：
  // INSERT INTO rules (user_id, rule_name, conditions, actions, enabled)
  // VALUES (1, '手动测试规则', '[{"metric":"ctr","operator":"lt","value":0.8}]', '[{"type":"pause_ad"}]', TRUE);
  
  console.log('对应的 SQL:')
  console.log(`INSERT INTO rules (user_id, rule_name, conditions, actions, enabled)
VALUES (1, '手动测试规则', '[{"metric":"ctr","operator":"lt","value":0.8}]', '[{"type":"pause_ad"}]', TRUE);`)
  
  console.log('\n现在用 Drizzle 实现相同的操作：')
  
  try {
    const result = await db.insert(rules).values({
      userId: 1,
      ruleName: '手动测试规则',
      conditions: [
        { metric: 'ctr', operator: 'lt', value: 0.8 }
      ],
      actions: [
        { type: 'pause_ad' }
      ],
      enabled: true
    })
    
    console.log('✅ Drizzle 插入成功！')
    console.log('新规则 ID:', result[0].insertId)
    console.log('\n💡 对比：')
    console.log('- SQL 需要手动写 JSON 字符串')
    console.log('- Drizzle 直接传入 JavaScript 对象，自动转换')
    
    return result[0].insertId
  } catch (error) {
    console.error('❌ 插入失败:', error.message)
    throw error
  }
}

// ============================================
// 练习 2：查询所有数据
// ============================================
async function 练习2_查询所有数据() {
  console.log('\n🔍 练习 2：查询所有数据')
  console.log('='.repeat(50))
  
  // 对应的 SQL：
  // SELECT * FROM rules;
  
  console.log('对应的 SQL: SELECT * FROM rules;')
  console.log('\n现在用 Drizzle 实现相同的操作：')
  
  try {
    const allRules = await db.select().from(rules)
    
    console.log('✅ Drizzle 查询成功！')
    console.log(`找到 ${allRules.length} 条规则：`)
    console.log(JSON.stringify(allRules, null, 2))
    
    console.log('\n💡 对比：')
    console.log('- SQL: SELECT * FROM rules')
    console.log('- Drizzle: db.select().from(rules)')
    console.log('- 结果：完全一致！')
    
    return allRules
  } catch (error) {
    console.error('❌ 查询失败:', error.message)
    throw error
  }
}

// ============================================
// 练习 3：条件查询
// ============================================
async function 练习3_条件查询() {
  console.log('\n🔍 练习 3：条件查询')
  console.log('='.repeat(50))
  
  // 对应的 SQL：
  // SELECT * FROM rules WHERE user_id = 1;
  
  console.log('对应的 SQL: SELECT * FROM rules WHERE user_id = 1;')
  console.log('\n现在用 Drizzle 实现相同的操作：')
  
  try {
    const userRules = await db
      .select()
      .from(rules)
      .where(eq(rules.userId, 1))
    
    console.log('✅ Drizzle 查询成功！')
    console.log(`用户 1 有 ${userRules.length} 条规则：`)
    console.log(JSON.stringify(userRules, null, 2))
    
    console.log('\n💡 对比：')
    console.log('- SQL: WHERE user_id = 1')
    console.log('- Drizzle: .where(eq(rules.userId, 1))')
    console.log('- 注意：数据库用 user_id，Drizzle 用 userId（自动转换）')
    
    return userRules
  } catch (error) {
    console.error('❌ 查询失败:', error.message)
    throw error
  }
}

// ============================================
// 练习 4：更新数据
// ============================================
async function 练习4_更新数据(ruleId) {
  console.log('\n✏️ 练习 4：更新数据')
  console.log('='.repeat(50))
  
  // 对应的 SQL：
  // UPDATE rules SET rule_name = '手动更新的名称' WHERE id = 1;
  
  console.log(`对应的 SQL: UPDATE rules SET rule_name = '手动更新的名称' WHERE id = ${ruleId};`)
  console.log('\n现在用 Drizzle 实现相同的操作：')
  
  try {
    const result = await db
      .update(rules)
      .set({
        ruleName: '手动更新的名称'
      })
      .where(eq(rules.id, ruleId))
    
    console.log('✅ Drizzle 更新成功！')
    console.log('影响行数:', result[0].affectedRows)
    
    // 查询更新后的数据
    const updated = await db
      .select()
      .from(rules)
      .where(eq(rules.id, ruleId))
      .limit(1)
    
    console.log('更新后的数据:')
    console.log(JSON.stringify(updated[0], null, 2))
    
    console.log('\n💡 对比：')
    console.log('- SQL: UPDATE rules SET rule_name = ? WHERE id = ?')
    console.log('- Drizzle: db.update(rules).set({ruleName: ...}).where(eq(rules.id, ...))')
    console.log('- Drizzle 更安全：自动防止 SQL 注入')
    
    return result
  } catch (error) {
    console.error('❌ 更新失败:', error.message)
    throw error
  }
}

// ============================================
// 主函数：运行指定的练习
// ============================================
async function main() {
  console.log('🚀 Drizzle vs SQL 对比学习')
  console.log('='.repeat(50))
  console.log('📚 使用说明：')
  console.log('1. 在 MySQL 中手动执行 SQL 命令')
  console.log('2. 取消下面某个函数的注释')
  console.log('3. 运行这个文件，看 Drizzle 的结果')
  console.log('4. 对比两者结果是否一致')
  console.log('='.repeat(50))
  
  try {
    // ============================================
    // 🔧 在这里取消注释，运行你想练习的函数
    // ============================================
    
    // 练习 1：插入数据
    // const newId = await 练习1_插入数据()
    
    // 练习 2：查询所有数据
    // await 练习2_查询所有数据()
    
    // 练习 3：条件查询
    // await 练习3_条件查询()
    
    // 练习 4：更新数据（需要先有一个规则 ID）
    // await 练习4_更新数据(1)  // 将 1 改为实际的规则 ID
    
    console.log('\n' + '='.repeat(50))
    console.log('✅ 练习完成！')
    console.log('\n💡 提示：')
    console.log('- 修改上面的注释，运行不同的练习')
    console.log('- 在 MySQL 中执行对应的 SQL，对比结果')
    console.log('- 尝试修改参数，观察变化')
    
  } catch (error) {
    console.error('\n❌ 练习过程中出错:', error)
  } finally {
    // 关闭数据库连接
    const { connection } = await import('./drizzle.js')
    await connection.end()
    console.log('\n✅ 数据库连接已关闭')
    process.exit(0)
  }
}

// 运行主函数
main()


