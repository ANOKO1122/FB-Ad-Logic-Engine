# Drizzle ORM 学习指南

本指南通过对比 Drizzle 和原生 SQL，帮助你理解 ORM 的工作原理。

## ⚠️ 重要说明

### 学习阶段（现在）
- **SQL**：用来理解数据库操作原理（在 MySQL 中手动执行）
- **Drizzle**：用来学习 ORM 的用法（运行代码）
- **目的**：通过对比理解 Drizzle 的工作原理

### 实际开发（以后）
- ✅ **使用 Drizzle**：所有 CRUD 操作都用 Drizzle
- ❌ **不使用 SQL**：不要在业务代码中手写 SQL 字符串
- **原因**：类型安全、易维护、防注入

### 什么时候用 SQL？
- ✅ 创建表结构（一次性操作，用 SQL 脚本）
- ✅ 数据库维护（备份、优化等）
- ❌ 业务代码（不要用 SQL，用 Drizzle）

**参考文件**：
- `实际开发示例.js`：展示如何在真实项目中使用 Drizzle
- `drizzle_practice.js`：学习用的练习文件

---

## 📋 第一步：创建表

### SQL 方式（手动执行）

```sql
-- 在 MySQL 中执行
CREATE TABLE IF NOT EXISTS `rules` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `rule_name` VARCHAR(255) NOT NULL,
  `conditions` JSON NOT NULL,
  `actions` JSON NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**执行方式**：
```bash
# 方式1：使用 MySQL 命令行
mysql -u fb_ad -p fb_ad_brain < server/db/migrations/001_create_rules_table.sql

# 方式2：在 MySQL Workbench 或 Navicat 中直接执行 SQL
```

### Drizzle 方式（代码定义）

```javascript
// server/db/schema.js
export const rules = mysqlTable('rules', {
  id: int('id').primaryKey().autoincrement(),
  userId: int('user_id').notNull(),
  ruleName: varchar('rule_name', { length: 255 }).notNull(),
  conditions: json('conditions').notNull(),
  actions: json('actions').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow()
})
```

**对比理解**：
- SQL 的 `INT AUTO_INCREMENT PRIMARY KEY` = Drizzle 的 `int('id').primaryKey().autoincrement()`
- SQL 的 `VARCHAR(255) NOT NULL` = Drizzle 的 `varchar('rule_name', { length: 255 }).notNull()`
- SQL 的 `DEFAULT TRUE` = Drizzle 的 `.default(true)`

---

## 📝 第二步：插入数据（CREATE）

### SQL 方式

```sql
-- 插入一条规则
INSERT INTO rules (user_id, rule_name, conditions, actions, enabled)
VALUES (
  1,
  '止损规则',
  '{"conditions": [{"metric": "ctr", "operator": "lt", "value": 0.8}]}',
  '{"actions": [{"type": "pause_ad"}]}',
  TRUE
);

-- 查看插入结果
SELECT * FROM rules WHERE id = LAST_INSERT_ID();
```

### Drizzle 方式

```javascript
// server/db/rules.example.js
import { db } from './drizzle.js'
import { rules } from './schema.js'

// 插入一条规则
const newRule = await db.insert(rules).values({
  userId: 1,
  ruleName: '止损规则',
  conditions: [
    { metric: 'ctr', operator: 'lt', value: 0.8 }
  ],
  actions: [
    { type: 'pause_ad' }
  ],
  enabled: true
})

// 获取插入的 ID（MySQL 返回的 insertId）
console.log('新规则 ID:', newRule[0].insertId)
```

**对比理解**：
- SQL 的 `INSERT INTO rules (...) VALUES (...)` = Drizzle 的 `db.insert(rules).values({...})`
- Drizzle 会自动处理 JSON 序列化（`conditions` 和 `actions` 会自动转为 JSON 字符串）
- Drizzle 返回的结果包含 `insertId`，可以直接获取新插入的 ID

---

## 🔍 第三步：查询数据（READ）

### SQL 方式

```sql
-- 查询用户的所有规则
SELECT * FROM rules WHERE user_id = 1;

-- 查询启用的规则
SELECT * FROM rules WHERE user_id = 1 AND enabled = TRUE;

-- 查询特定规则
SELECT * FROM rules WHERE id = 5;

-- 查询规则数量
SELECT COUNT(*) as count FROM rules WHERE user_id = 1;
```

### Drizzle 方式

```javascript
import { db } from './drizzle.js'
import { rules } from './schema.js'
import { eq, and, count } from 'drizzle-orm'

// 1. 查询用户的所有规则
const userRules = await db
  .select()
  .from(rules)
  .where(eq(rules.userId, 1))

// 2. 查询启用的规则（多个条件）
const enabledRules = await db
  .select()
  .from(rules)
  .where(
    and(
      eq(rules.userId, 1),
      eq(rules.enabled, true)
    )
  )

// 3. 查询特定规则
const rule = await db
  .select()
  .from(rules)
  .where(eq(rules.id, 5))
  .limit(1)  // 只取第一条

// 4. 查询规则数量
const result = await db
  .select({ count: count() })
  .from(rules)
  .where(eq(rules.userId, 1))
const ruleCount = result[0].count
```

**对比理解**：
- SQL 的 `WHERE user_id = 1` = Drizzle 的 `.where(eq(rules.userId, 1))`
- SQL 的 `AND` = Drizzle 的 `and(...)`
- SQL 的 `COUNT(*)` = Drizzle 的 `count()`
- `eq()` 表示"等于"，还有 `gt()`（大于）、`lt()`（小于）、`like()`（模糊匹配）等

---

## ✏️ 第四步：更新数据（UPDATE）

### SQL 方式

```sql
-- 更新规则名称
UPDATE rules 
SET rule_name = '新规则名称', updated_at = NOW()
WHERE id = 5;

-- 启用/禁用规则
UPDATE rules 
SET enabled = FALSE, updated_at = NOW()
WHERE id = 5;

-- 批量更新（禁用用户的所有规则）
UPDATE rules 
SET enabled = FALSE, updated_at = NOW()
WHERE user_id = 1;
```

### Drizzle 方式

```javascript
import { db } from './drizzle.js'
import { rules } from './schema.js'
import { eq } from 'drizzle-orm'

// 1. 更新规则名称
await db
  .update(rules)
  .set({
    ruleName: '新规则名称',
    updatedAt: new Date()  // Drizzle 会自动处理时间戳
  })
  .where(eq(rules.id, 5))

// 2. 启用/禁用规则
await db
  .update(rules)
  .set({ enabled: false })
  .where(eq(rules.id, 5))

// 3. 批量更新（禁用用户的所有规则）
await db
  .update(rules)
  .set({ enabled: false })
  .where(eq(rules.userId, 1))
```

**对比理解**：
- SQL 的 `UPDATE rules SET ... WHERE ...` = Drizzle 的 `db.update(rules).set({...}).where(...)`
- Drizzle 的 `set()` 方法接收一个对象，只更新指定的字段
- `updatedAt` 字段在 schema 中设置了 `onUpdateNow()`，所以可以省略

---

## 🗑️ 第五步：删除数据（DELETE）

### SQL 方式

```sql
-- 删除特定规则
DELETE FROM rules WHERE id = 5;

-- 删除用户的所有规则
DELETE FROM rules WHERE user_id = 1;

-- 软删除（标记为已删除，不真正删除）
UPDATE rules 
SET enabled = FALSE 
WHERE id = 5;
```

### Drizzle 方式

```javascript
import { db } from './drizzle.js'
import { rules } from './schema.js'
import { eq } from 'drizzle-orm'

// 1. 删除特定规则
await db
  .delete(rules)
  .where(eq(rules.id, 5))

// 2. 删除用户的所有规则
await db
  .delete(rules)
  .where(eq(rules.userId, 1))

// 3. 软删除（推荐方式，保留数据）
await db
  .update(rules)
  .set({ enabled: false })
  .where(eq(rules.id, 5))
```

**对比理解**：
- SQL 的 `DELETE FROM rules WHERE ...` = Drizzle 的 `db.delete(rules).where(...)`
- 实际项目中，通常使用"软删除"（更新状态字段），而不是真正删除数据

---

## 🔗 第六步：高级查询

### SQL 方式

```sql
-- 排序（按创建时间倒序）
SELECT * FROM rules 
WHERE user_id = 1 
ORDER BY created_at DESC;

-- 分页（LIMIT + OFFSET）
SELECT * FROM rules 
WHERE user_id = 1 
ORDER BY created_at DESC 
LIMIT 10 OFFSET 0;

-- 模糊搜索
SELECT * FROM rules 
WHERE user_id = 1 
AND rule_name LIKE '%止损%';

-- 范围查询
SELECT * FROM rules 
WHERE user_id = 1 
AND created_at >= '2024-01-01' 
AND created_at <= '2024-12-31';
```

### Drizzle 方式

```javascript
import { db } from './drizzle.js'
import { rules } from './schema.js'
import { eq, desc, like, gte, lte } from 'drizzle-orm'

// 1. 排序（按创建时间倒序）
const sortedRules = await db
  .select()
  .from(rules)
  .where(eq(rules.userId, 1))
  .orderBy(desc(rules.createdAt))

// 2. 分页（LIMIT + OFFSET）
const pagedRules = await db
  .select()
  .from(rules)
  .where(eq(rules.userId, 1))
  .orderBy(desc(rules.createdAt))
  .limit(10)
  .offset(0)

// 3. 模糊搜索
const searchRules = await db
  .select()
  .from(rules)
  .where(
    and(
      eq(rules.userId, 1),
      like(rules.ruleName, '%止损%')
    )
  )

// 4. 范围查询
const rangeRules = await db
  .select()
  .from(rules)
  .where(
    and(
      eq(rules.userId, 1),
      gte(rules.createdAt, new Date('2024-01-01')),
      lte(rules.createdAt, new Date('2024-12-31'))
    )
  )
```

**对比理解**：
- SQL 的 `ORDER BY created_at DESC` = Drizzle 的 `.orderBy(desc(rules.createdAt))`
- SQL 的 `LIMIT 10 OFFSET 0` = Drizzle 的 `.limit(10).offset(0)`
- SQL 的 `LIKE '%止损%'` = Drizzle 的 `like(rules.ruleName, '%止损%')`
- SQL 的 `>=` 和 `<=` = Drizzle 的 `gte()` 和 `lte()`

---

## 🎯 常用操作符对照表

| SQL 操作符 | Drizzle 函数 | 说明 |
|-----------|------------|------|
| `=` | `eq()` | 等于 |
| `!=` 或 `<>` | `ne()` | 不等于 |
| `>` | `gt()` | 大于 |
| `>=` | `gte()` | 大于等于 |
| `<` | `lt()` | 小于 |
| `<=` | `lte()` | 小于等于 |
| `LIKE` | `like()` | 模糊匹配 |
| `IN` | `inArray()` | 在数组中 |
| `AND` | `and()` | 且 |
| `OR` | `or()` | 或 |
| `NOT` | `not()` | 非 |

---

## 💡 实践建议

### 1. 先执行 SQL，再写 Drizzle 代码

```bash
# 步骤1：在 MySQL 中手动执行 SQL，验证结果
mysql> SELECT * FROM rules WHERE user_id = 1;

# 步骤2：用 Drizzle 实现相同的查询
const rules = await db.select().from(rules).where(eq(rules.userId, 1))

# 步骤3：对比结果，确保一致
```

### 2. 使用 Drizzle 的调试功能

```javascript
// Drizzle 可以输出生成的 SQL（开发时很有用）
import { drizzle } from 'drizzle-orm/mysql2'
import { sql } from 'drizzle-orm'

// 查看生成的 SQL
const query = db.select().from(rules).where(eq(rules.userId, 1))
console.log(query.toSQL())  // 输出生成的 SQL 语句
```

### 3. 错误处理

```javascript
try {
  const result = await db.insert(rules).values({ ... })
  console.log('插入成功:', result)
} catch (error) {
  console.error('插入失败:', error.message)
  // 常见错误：
  // - 字段不存在
  // - 数据类型不匹配
  // - 外键约束失败
}
```

---

## 📚 下一步学习

1. **事务处理**：如何在一个事务中执行多个操作
2. **关联查询**：如何查询关联表（JOIN）
3. **聚合函数**：SUM、AVG、MAX、MIN 等
4. **子查询**：如何在 Drizzle 中实现复杂的子查询

---

## 🔍 调试技巧

### 查看 Drizzle 生成的 SQL

```javascript
import { sql } from 'drizzle-orm'

// 方式1：使用 toSQL() 方法
const query = db.select().from(rules).where(eq(rules.userId, 1))
console.log(query.toSQL())

// 方式2：使用 sql 模板
const result = await db.execute(
  sql`SELECT * FROM rules WHERE user_id = ${1}`
)
```

---

**提示**：建议你先手动执行 SQL 命令，理解每个操作的结果，然后再用 Drizzle 实现相同的功能。这样对比学习，效果最好！

