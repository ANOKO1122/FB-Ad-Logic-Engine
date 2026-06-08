// Drizzle ORM Schema 定义
// 注意：只定义新表（rules），旧表（users, account_mappings）继续使用原生 SQL
// 规则管理「负责人筛选」方案 B：为联表查询在 Schema 中增加 users、owners 最小只读定义（不迁移表结构）
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
  text,
  primaryKey
} from 'drizzle-orm/mysql-core'

// ============================================
// 旧表只读定义（仅联表用，列名与 MySQL 真实表一致）
// ============================================
/** users 表（旧表）：仅规则列表联表所需列。owner_id 映射到 Drizzle 的 ownerId */
export const users = mysqlTable('users', {
  id: int('id').primaryKey(),
  ownerId: int('owner_id'),  // 映射到 MySQL 列 owner_id，联表时用 users.ownerId
  role: varchar('role', { length: 32 })
})

/** owners 表（旧表）：仅 id、owner_name，供联表带出负责人名称。owner_name 映射到 ownerName */
export const owners = mysqlTable('owners', {
  id: int('id').primaryKey(),
  ownerName: varchar('owner_name', { length: 255 })
})

// 规则表（rules）
// 这是新功能使用的表，使用 Drizzle ORM 操作
// 按照 DEV_PLAN.md M3 的要求，扩展了规则配置层所需的新字段
export const rules = mysqlTable('rules', {
  // 主键：自增 ID
  id: int('id').primaryKey().autoincrement(),
  
  // 用户 ID：关联到 users 表的 owner_id（外键关系，但 Drizzle 不强制外键约束）
  userId: int('user_id').notNull(),

  // 负责人冗余：DB 列 owner_id；JS 属性名 rulesOwnerId，避免与 getUserRules 中联表别名 ownerId（owners.id）混淆
  rulesOwnerId: int('owner_id'),
  
  // 广告账户 ID：NULL 表示未绑定（半成品）；enabled=true 前由 PUT 开闸校验拦截
  accountId: varchar('account_id', { length: 50 }),
  
  // 规则名称
  ruleName: varchar('rule_name', { length: 255 }).notNull(),

  // 来源模板 slug（rule_templates.slug）；与 owner_id 组成 UNIQUE 实现铺底幂等
  sourceTemplateSlug: varchar('source_template_slug', { length: 64 }),
  
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
  
  // 动态筛选（Dynamic Scope）相关字段（M3 扩展，参见「动态筛选执行方案 V3」）
  // use_dynamic_scope=1 时，规则目标对象从 rule_matched_objects 读取；0 时走旧的 targetLevel/targetIds 逻辑
  useDynamicScope: boolean('use_dynamic_scope').notNull().default(false),
  // 监控范围条件：由前端三个监控范围控件序列化而来，示例：
  // { level: 'adset', conditions: [{ field:'effective_status', op:'in', value:['ACTIVE'] }, { field:'created_time', op:'within_hours', value:72 }] }
  scopeFilters: json('scope_filters'),
  // 排除名单：支持混合 campaign/adset/ad，示例：
  // { campaign_ids:['C1'], adset_ids:['AS1'], ad_ids:['A1','A2'] }
  excludeIds: json('exclude_ids'),
  // 动态匹配上限：finalAdIds 超过该值时视为 ERROR_OVERSIZE，本轮不写新快照（保留上一版）
  maxDynamicMatches: int('max_dynamic_matches').notNull().default(1000),
  // 动态筛选刷新状态机：NORMAL / ERROR_OVERSIZE / ERROR_FILTER_INVALID / ERROR_REFRESH_FAILED
  dynamicScopeStatus: varchar('dynamic_scope_status', { length: 32 }).notNull().default('NORMAL'),
  dynamicScopeErrorMsg: varchar('dynamic_scope_error_msg', { length: 255 }),
  dynamicScopeUpdatedAt: timestamp('dynamic_scope_updated_at'),

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
  lastExecutedAt: timestamp('last_executed_at'),
  
  // 执行频率与时间段（文档：执行频率与执行时间 — 适配方案）
  executionIntervalMinutes: int('execution_interval_minutes'),   // 规则×广告执行间隔(分钟)，NULL 按 15
  executionTimeWindows: json('execution_time_windows')           // 允许执行时间段(北京时间)，空/NULL=全天
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
// M5：增加 object_type/object_id/object_name/preflight_mode 通用对象字段（双写兼容）
export const automationLogs = mysqlTable('automation_logs', {
  // 主键
  id: int('id').primaryKey().autoincrement(),
  
  // M4 运行批次（与 rule_execution_summaries.run_id 一致；验收：同一 run_id + ad_id 最多 1 条）
  runId: varchar('run_id', { length: 100 }),
  
  // 关联信息
  accountId: varchar('account_id', { length: 50 }).notNull(),
  adId: varchar('ad_id', { length: 50 }).notNull(),
  adName: varchar('ad_name', { length: 500 }),                                // 广告名称（快照；旧字段，保留兼容）
  ruleId: int('rule_id'),                                                     // 规则ID（可为NULL表示手动触发）
  ruleName: varchar('rule_name', { length: 255 }),                            // 规则名称（快照）
  ownerId: int('owner_id').notNull(),
  
  // M5 通用对象字段（新字段，双写兼容）
  objectType: varchar('object_type', { length: 16 }),                         // 目标对象类型：ad|adset|campaign
  objectId: varchar('object_id', { length: 50 }),                             // 目标对象 ID
  objectName: varchar('object_name', { length: 500 }),                        // 目标对象名称
  preflightMode: varchar('preflight_mode', { length: 32 }),                   // Pre-Flight 模式：preflight|direct_api_fallback
  
  // 触发时的指标快照
  metricsSnapshot: json('metrics_snapshot'),                                  // 指标快照（JSON格式）
  explanation: json('explanation'),                                           // 可解释审计：输入快照 + 聚合推导 + 条件命中链路
  
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

// rule_ad_execution_state：规则×冷却键执行状态（仅调度路径读写，单条执行不参与）
// 迁移 031：主键改为 (rule_id, scope_key)；scope_key 可为 ad:xxx | budget_adset:xxx | budget_campaign:xxx
export const ruleAdExecutionState = mysqlTable('rule_ad_execution_state', {
  ruleId: int('rule_id').notNull(),
  scopeKey: varchar('scope_key', { length: 100 }).notNull(),
  lastExecutedAt: timestamp('last_executed_at').notNull(),
  lastStatus: mysqlEnum('last_status', ['success', 'fail', 'suppressed', 'outside_window']),
  // 保留 ad_id 仅作诊断/兼容，主键与业务逻辑均以 scope_key 为准
  adId: varchar('ad_id', { length: 50 })
}, (t) => ({
  pk: primaryKey({ columns: [t.ruleId, t.scopeKey] })
}))

// rule_matched_objects：动态筛选预计算快照表（M2 升级为 typed snapshot）
// 存储「规则 × 账户 × 目标层级」的目标对象快照
// object_type 真实生效（ad | adset | campaign），唯一键升级为 (rule_id, account_id, object_type, object_id)
// 执行层按 rule_id + account_id + object_type 读取，不再默认只读 ad
export const ruleMatchedObjects = mysqlTable('rule_matched_objects', {
  id: int('id').primaryKey().autoincrement(),
  ruleId: int('rule_id').notNull(),
  accountId: varchar('account_id', { length: 50 }).notNull(),
  objectId: varchar('object_id', { length: 50 }).notNull(),       // 同层对象 ID（ad_id / adset_id / campaign_id）
  objectType: varchar('object_type', { length: 16 }).notNull(),   // 真实业务字段：ad | adset | campaign
  createdAt: timestamp('created_at').notNull().defaultNow()
})

// ============================================
// scheduled_tasks：定时任务表（方案二：独立表）
// 负责存储"什么时间做什么"，由 scheduledTaskService 每分钟扫描执行
// ============================================
export const scheduledTasks = mysqlTable('scheduled_tasks', {
  id: int('id').primaryKey().autoincrement(),
  // 用户归属
  userId: int('user_id').notNull(),
  ownerId: int('owner_id').notNull().default(0),
  // 调度配置
  scheduleType: varchar('schedule_type', { length: 16 }).notNull(),      // once / daily / weekly / interval / cron
  scheduleAt: varchar('schedule_at', { length: 32 }),                    // cron 类型可为 NULL
  scheduleCron: varchar('schedule_cron', { length: 64 }),               // cron 表达式
  scheduleTimezone: varchar('schedule_timezone', { length: 50 }),       // 时区，NULL=跟随账户时区
  nextExecuteAt: timestamp('next_execute_at'),                           // 下次执行时间（UTC）
  // 目标对象（v2 多对象支持：targetId 保留向后兼容，targetIds 为主字段）
  accountId: varchar('account_id', { length: 50 }).notNull(),            // 主账户（向后兼容，新任务配合 target_by_account 使用）
  targetAccountIds: json('target_account_ids'),                           // v3 多选账户ID列表（JSON数组，复用规则管理逻辑）
  targetByAccount: json('target_by_account'),                            // v3 按账户分组的目标ID { "act_1": ["id1"], "act_2": ["id2"] }
  targetLevel: varchar('target_level', { length: 16 }).notNull().default('ad'),
  targetId: varchar('target_id', { length: 50 }),                        // 向后兼容，新任务用 targetIds
  targetIds: json('target_ids'),                                          // 多目标ID列表（JSON数组）
  // 动态筛选（复用规则管理的 scope_filters / exclude_ids 模式）
  useDynamicScope: boolean('use_dynamic_scope').notNull().default(false),
  scopeFilters: json('scope_filters'),                                    // 监控范围条件
  excludeIds: json('exclude_ids'),                                        // 排除名单
  maxDynamicMatches: int('max_dynamic_matches').notNull().default(1000),  // 动态匹配上限
  // 动作配置
  actionType: varchar('action_type', { length: 32 }).notNull(),         // pause_ad / activate_ad / set_budget / increase_budget / decrease_budget
  actionParams: json('action_params').notNull(),                         // 动作参数
  taskName: varchar('task_name', { length: 255 }),                      // 任务名称（用户自定义）
  // 状态控制
  enabled: boolean('enabled').notNull().default(true),
  isSimulation: boolean('is_simulation').notNull().default(false),
  autoDisable: boolean('auto_disable').notNull().default(true),         // once 类型执行后自动禁用
  // 执行追踪
  lastExecutedAt: timestamp('last_executed_at'),
  lastStatus: varchar('last_status', { length: 16 }),                   // success / fail / skipped
  // 重试控制
  retryCount: int('retry_count').notNull().default(0),
  maxRetries: int('max_retries').notNull().default(3),
  // 并发控制（乐观锁）
  version: int('version').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow()
})
