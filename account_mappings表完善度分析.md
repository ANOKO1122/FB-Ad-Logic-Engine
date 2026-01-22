# account_mappings 表完善度分析

> 分析日期：2026-01-15  
> 当前表结构：已提供（7个字段）

---

## 📊 当前表结构

```sql
CREATE TABLE account_mappings (
  id              INT PRIMARY KEY AUTO_INCREMENT,
  fb_account_id   VARCHAR(50) UNIQUE NOT NULL,
  fb_account_name VARCHAR(200),
  owner_id        INT NOT NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

---

## ✅ 当前状态：基础功能完善

### 已满足的需求
1. ✅ **账户标识**：`fb_account_id`、`fb_account_name`
2. ✅ **负责人关联**：`owner_id`（关联到 owners 表）
3. ✅ **启用状态**：`is_active`（控制账户是否参与同步）
4. ✅ **时间戳**：`created_at`、`updated_at`（审计追踪）

### 当前功能可以正常使用
- ✅ 数据同步功能（Today + Past 7 Days）
- ✅ 冷数据落盘功能
- ✅ 定时任务功能
- ✅ 多账户负责人隔离

---

## ⚠️ 建议添加的字段（按优先级）

### 优先级 1：时区支持（推荐添加）

**字段**：`timezone_name`  
**类型**：`VARCHAR(50) DEFAULT 'UTC'`  
**用途**：支持不同账户使用不同时区，用于：
- 计算"昨日"数据（冷数据落盘）
- 定时任务按账户时区执行（如每天 06:00）

**SQL 语句**：
```sql
ALTER TABLE account_mappings 
ADD COLUMN timezone_name VARCHAR(50) DEFAULT 'UTC' 
COMMENT '账户时区，如 Asia/Shanghai, America/New_York';
```

**影响**：
- 当前代码已支持时区参数，添加字段后可以真正使用
- 如果不添加，所有账户都使用 UTC 时区（功能正常，但不够灵活）

---

### 优先级 2：执行模式（未来功能）

**字段**：`execution_mode`  
**类型**：`ENUM('SIMULATE', 'REAL') DEFAULT 'SIMULATE'`  
**用途**：控制账户的自动化执行模式
- `SIMULATE`：Dry Run 模式，只记录日志，不执行真实操作
- `REAL`：实战模式，真正执行暂停/加预算等操作

**SQL 语句**：
```sql
ALTER TABLE account_mappings 
ADD COLUMN execution_mode ENUM('SIMULATE', 'REAL') DEFAULT 'SIMULATE' 
COMMENT '执行模式：SIMULATE=模拟，REAL=实战';
```

**影响**：
- 当前代码还没有使用这个字段
- 这是未来功能（M4 动作执行层），可以暂时不添加

---

### 优先级 3：自动化开关（未来功能）

**字段**：`is_active_automation`  
**类型**：`TINYINT(1) DEFAULT 0`  
**用途**：独立控制账户是否允许参与自动化实战
- `is_active = 1`：允许数据同步
- `is_active_automation = 1`：允许自动化执行（需要 `is_active = 1`）

**SQL 语句**：
```sql
ALTER TABLE account_mappings 
ADD COLUMN is_active_automation TINYINT(1) DEFAULT 0 
COMMENT '是否允许自动化执行（需要 is_active=1）';
```

**影响**：
- 当前代码还没有使用这个字段
- 这是未来功能（Phase 4 小范围实测），可以暂时不添加

---

## 📋 总结与建议

### 当前状态：✅ 基础功能完善

你的 `account_mappings` 表**已经可以满足当前所有功能需求**：
- ✅ 数据同步功能正常
- ✅ 定时任务功能正常
- ✅ 多账户负责人隔离正常

### 建议添加的字段（按优先级）

#### 🟡 优先级 1：`timezone_name`（推荐添加）

**为什么推荐**：
- 代码已经支持时区参数，添加字段后可以真正使用
- 不同账户可能在不同时区，需要按账户时区计算"昨日"
- 添加后，冷数据落盘可以按账户时区的 06:00 执行

**添加方式**：
```sql
ALTER TABLE account_mappings 
ADD COLUMN timezone_name VARCHAR(50) DEFAULT 'UTC' 
COMMENT '账户时区，如 Asia/Shanghai, America/New_York';
```

**添加后需要做的**：
- 更新代码，从数据库读取 `timezone_name` 而不是使用默认值
- 为每个账户设置正确的时区值

---

#### 🟢 优先级 2-3：未来功能字段（暂时不需要）

`execution_mode` 和 `is_active_automation` 是未来功能（M4 动作执行层），当前阶段不需要添加。

---

## 🎯 结论

### 当前表结构：✅ 完善（满足当前需求）

你的 `account_mappings` 表已经可以满足：
- ✅ 数据架构层（M2）的所有需求
- ✅ 当前所有功能正常运行

### 建议

1. **如果只是测试和开发**：当前表结构足够，不需要修改
2. **如果要支持多时区**：建议添加 `timezone_name` 字段
3. **如果准备实现动作执行层（M4）**：可以提前添加 `execution_mode` 字段

---

## 📝 快速检查清单

- [x] `fb_account_id` - ✅ 已有
- [x] `fb_account_name` - ✅ 已有
- [x] `owner_id` - ✅ 已有
- [x] `is_active` - ✅ 已有
- [ ] `timezone_name` - ⚠️ 建议添加（支持多时区）
- [ ] `execution_mode` - 🔵 未来功能（M4）
- [ ] `is_active_automation` - 🔵 未来功能（Phase 4）

---

**建议**：如果当前功能都正常，可以暂时不修改表结构。等需要支持多时区或实现动作执行层时，再添加相应字段。

