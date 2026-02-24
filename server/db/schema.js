// Drizzle ORM Schema 定义
// 注意：只定义新表（rules），旧表（users, account_mappings）继续使用原生 SQL
import { 
  mysqlTable, 
  int, 
  varchar, 
  json, 
  boolean, 
  timestamp, 
  mysqlEnum,
  decimal,
  date,
  text
} from 'drizzle-orm/mysql-core'
// 规则表（rules）
// 这是新功能使用的表，使用 Drizzle ORM 操作
// 按照 DEV_PLAN.md M3 的要求，扩展了规则配置层所需的新字段
export const rules = mysqlTable('rules', {
  // 主键：自增 ID
  id: int('id').primaryKey().autoincrement(),
  
  // 用户 ID：关联到 users 表的 owner_id（外键关系，但 Drizzle 不强制外键约束）
  userId: int('user_id').notNull(),
  
  // 广告账户 ID：规则作用的目标账户（限定规则只作用于此账户）
  // ✅ 方案三：必须绑定账户（NOT NULL），防止反向索引退化
  accountId: varchar('account_id', { length: 50 }).notNull(),
  
  // 规则名称
  ruleName: varchar('rule_name', { length: 255 }).notNull(),
  
  // 目标范围（M3 新增）
  targetLevel: varchar('target_level', { length: 20 }).default('ad'),  // 目标层级：ad/adset/campaign
  targetIds: json('target_ids').default([]),                            // 目标ID列表（JSON数组，兼容旧数据）
  targetAccountIds: json('target_account_ids'),                           // 多选账户：规则作用的账户ID列表（JSON数组）
  targetByAccount: json('target_by_account'),                            // 方案B：按账户分组的目标ID { "act_1": ["id1","id2"], "act_2": ["id3"] }
  
  // 规则条件：JSON 格式存储
  // 新格式示例：[{ metric: 'spend', operator: 'gt', value: 20, time_window: 'today' }]
  // 旧格式兼容：[{ metric: 'ctr', operator: 'lt', value: 0.8 }]
  conditions: json('conditions').notNull(),
  
  // 逻辑运算符（M3 新增）
  logicOperator: varchar('logic_operator', { length: 10 }).default('AND'),  // AND/OR
  
  // 时区与执行模式（M3 新增）
  timezoneName: varchar('timezone_name', { length: 50 }).default('UTC'),      // 账户时区
  isSimulation: boolean('is_simulation').default(false),                      // 是否 Dry Run 模式
  
  // 执行操作：JSON 格式存储
  // 示例：[{ type: 'pause_ad' }] 或 [{ type: 'increase_budget', value: 20 }]
  // M4 3.5：max_daily_budget 单位为「分」(int)，前端展示时除以 100
  actions: json('actions').notNull(),
  
  // 是否启用
  enabled: boolean('enabled').notNull().default(true),
  
  // 创建时间
  createdAt: timestamp('created_at').notNull().defaultNow(),
  
  // 更新时间
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  
  // 上次执行时间（用于冷却期机制）
  lastExecutedAt: timestamp('last_executed_at')
})

// ============================================
// 数据架构层（M2）：广告快照与统计表
// ============================================

// ad_snapshots 表（热数据：Today）
// 存储今日广告快照，每 10 分钟更新一次
export const adSnapshots = mysqlTable('ad_snapshots', {
  // 主键
  id: int('id').primaryKey().autoincrement(),
  
  // 基本信息
  accountId: varchar('account_id', { length: 50 }).notNull(),  // Facebook 账户ID（字符串，避免溢出）
  adId: varchar('ad_id', { length: 50 }).notNull(),           // 广告ID（字符串）
  adName: varchar('ad_name', { length: 500 }),                 // 广告名称
  status: varchar('status', { length: 50 }),                   // 广告状态（ACTIVE/PAUSED等）
  ownerId: int('owner_id').notNull(),                          // 负责人ID，关联users表
  
  // 指标数据（今日数据）- 10个核心字段全部入库
  spend: decimal('spend', { precision: 10, scale: 2 }).default('0.00'),      // 花费（美元）
  cpc: decimal('cpc', { precision: 10, scale: 4 }),                          // 单次链接点击费用（直接从 API 获取）
  ucpc: decimal('ucpc', { precision: 10, scale: 4 }),                        // 独立单次链接点击费用（从 cost_per_unique_link_click 获取）
  roas: decimal('roas', { precision: 10, scale: 4 }),                         // 广告支出回报率（优先从 purchase_roas 提取，缺失时计算）
  cpa: decimal('cpa', { precision: 10, scale: 4 }),                          // 单次购买成本（从 cost_per_action_type 提取）
  actions: json('actions'),                                                    // 所有动作数据（JSON格式，用于解析 purchases）
  purchases: int('purchases').default(0),                                     // 购买次数（从 actions 中提取）
  addToCartCost: decimal('add_to_cart_cost', { precision: 10, scale: 4 }),   // 加购费（从 cost_per_action_type 提取）
  checkoutCost: decimal('checkout_cost', { precision: 10, scale: 4 }),       // 结账费（从 cost_per_action_type 提取）
  paymentCost: decimal('payment_cost', { precision: 10, scale: 4 }),         // 支付费（从 cost_per_action_type 提取）
  
  // 元信息
  syncSessionId: varchar('sync_session_id', { length: 100 }).notNull(),      // 同步会话ID
  syncedAt: timestamp('synced_at').notNull(),                                  // 同步时间
  timezoneName: varchar('timezone_name', { length: 50 }).default('UTC'),     // 账户时区
  dataDate: date('data_date').notNull(),                                       // 数据日期（账户本地时区的自然日，用于分层落盘和真空期兜底）
  
  // 自动化相关
  muteUntil: timestamp('mute_until'),                                         // 手动挂起截止时间
  muteReason: varchar('mute_reason', { length: 255 }),                       // 挂起原因
  isSimulation: boolean('is_simulation').default(false)                        // 是否为模拟数据（Dry Run模式）
})

// daily_stats 表（冷数据：历史聚合）
// 存储每日汇总数据，每天 06:00 将昨日数据落盘
export const dailyStats = mysqlTable('daily_stats', {
  // 主键
  id: int('id').primaryKey().autoincrement(),
  
  // 基本信息
  accountId: varchar('account_id', { length: 50 }).notNull(),
  adId: varchar('ad_id', { length: 50 }).notNull(),
  adName: varchar('ad_name', { length: 500 }),
  ownerId: int('owner_id').notNull(),
  
  // 日期（自然日）
  date: date('date').notNull(),                                               // 统计日期（自然日）
  timezoneName: varchar('timezone_name', { length: 50 }).default('UTC'),
  
  // 指标数据（当日汇总）
  spend: decimal('spend', { precision: 10, scale: 2 }).default('0.00'),
  ctr: decimal('ctr', { precision: 5, scale: 4 }).default('0.0000'),
  cpc: decimal('cpc', { precision: 10, scale: 4 }).default('0.0000'),
  cpm: decimal('cpm', { precision: 10, scale: 4 }).default('0.0000'),
  roas: decimal('roas', { precision: 10, scale: 4 }).default('0.0000'),
  purchases: int('purchases').default(0),
  addToCart: int('add_to_cart').default(0),
  actions: json('actions'),
  
  // 元信息
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow()
})

// daily_archive_status 表（归档状态注册表）
// 记录每个账户每个日期的归档状态，支持滑动窗口归档和补跑机制
export const dailyArchiveStatus = mysqlTable('daily_archive_status', {
  // 主键
  id: int('id').primaryKey().autoincrement(),
  
  // 账户和日期（唯一标识）
  accountId: varchar('account_id', { length: 50 }).notNull(),                 // Facebook 账户ID
  targetDate: date('target_date').notNull(),                                   // 目标归档日期（账户本地时区的自然日）
  
  // 状态字段
  status: mysqlEnum('status', ['PENDING', 'ARCHIVED', 'FINALIZED']).notNull().default('PENDING'),  // 归档状态
  
  // 时间戳
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),     // 最后更新时间
  
  // 错误信息（可选）
  lastError: text('last_error')                                                // 最后一次归档失败的错误信息
})

// automation_logs 表（审计日志）
// 记录每次规则执行的详细信息，用于审计和问题排查
// M4：增加 run_id，同一 run 下同一 ad_id 仅一条执行记录（验收用）
export const automationLogs = mysqlTable('automation_logs', {
  // 主键
  id: int('id').primaryKey().autoincrement(),
  
  // M4 运行批次（与 rule_execution_summaries.run_id 一致；验收：同一 run_id + ad_id 最多 1 条）
  runId: varchar('run_id', { length: 100 }),
  
  // 关联信息
  accountId: varchar('account_id', { length: 50 }).notNull(),
  adId: varchar('ad_id', { length: 50 }).notNull(),
  adName: varchar('ad_name', { length: 500 }),                                // 广告名称（快照）
  ruleId: int('rule_id'),                                                     // 规则ID（可为NULL表示手动触发）
  ruleName: varchar('rule_name', { length: 255 }),                            // 规则名称（快照）
  ownerId: int('owner_id').notNull(),
  
  // 触发时的指标快照
  metricsSnapshot: json('metrics_snapshot'),                                  // 指标快照（JSON格式）
  
  // 动作信息
  actionType: varchar('action_type', { length: 50 }).notNull(),               // 动作类型（PAUSE、INCREASE_BUDGET等）
  actionPayload: json('action_payload'),                                       // 动作参数（JSON格式）
  isSimulation: boolean('is_simulation').default(false),                       // 是否为模拟执行（Dry Run模式）
  
  // API 请求/响应（用于调试）
  apiRequest: text('api_request'),                                            // API 请求原文
  apiResponse: text('api_response'),                                           // API 响应原文
  
  // 执行状态
  status: mysqlEnum('status', ['success', 'fail', 'skipped']).notNull().default('success'),
  errorMessage: text('error_message'),                                         // 错误信息（如果失败）
  
  // 时间戳
  triggeredAt: timestamp('triggered_at').notNull(),                           // 触发时间
  createdAt: timestamp('created_at').notNull().defaultNow()                    // 创建时间
})

// 注意：JavaScript 项目不支持 TypeScript 的类型导出
// 如果将来迁移到 TypeScript，可以使用以下类型定义：
// export type Rule = typeof rules.$inferSelect  // 查询时的类型
// export type NewRule = typeof rules.$inferInsert  // 插入时的类型

