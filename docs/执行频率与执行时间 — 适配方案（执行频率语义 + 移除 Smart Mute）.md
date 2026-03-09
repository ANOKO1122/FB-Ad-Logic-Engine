（广告级执行频率 + 执行时间段 + 移除 Smart Mute）
一、目标与术语统一
1.1 目标
为每条规则提供执行频率和允许执行时间段两种控制：
执行频率 = 对「每个广告」来说，同一规则连续两次触发之间的最小间隔。
允许执行时间段 = 每天北京时区内，规则可以对广告下发动作的时段集合。
冷却粒度从「规则级」下沉到「规则 × 广告」级：
一个规则作用 100 个广告，只会对触发过的那几个广告施加间隔，其他广告不受影响。
一个广告命中多条规则，每条规则各自有自己的间隔，互不干扰。
规则执行由「每分钟调度 Cron」统一驱动，不再由「数据同步心跳」顺带触发。
移除 Smart Mute（mute_until）在规则执行链路中的作用，只保留字段和脚本用于历史排查。
1.2 三个核心概念
执行频率（Execution Interval）
维度：(规则, 广告)。
含义：对某条规则 R 和某个广告 A 来说，从「上一次触发 R（无论赢输）」到「下一次触发 R」之间，最少要间隔多少分钟。
字段：rules.execution_interval_minutes（或沿用 check_interval_minutes，语义改为执行间隔）。
上次触发时间（per rule × ad）
表级：rule_ad_execution_state(rule_id, ad_id, last_executed_at, last_status)。
含义：规则 R 在广告 A 上最近一次触发的时间点（UTC）。
触发包括：
R 对 A 成为仲裁赢家并执行动作（success / fail）；
R 对 A 命中但在仲裁中被更高优先级规则压制（suppressed）。
允许执行时间段（Execution Time Windows）
字段：rules.execution_time_windows（JSON）。
含义：以北京时间（Asia/Shanghai）定义的时间段数组，例如：
    [      { "start": "09:00:00", "end": "18:00:00" },      { "start": "21:00:00", "end": "23:30:00" }    ]
当前时间（北京时区）落在任一段内时，才允许下发动作；否则只记「不在执行时间段」的跳过摘要。
二、数据结构与迁移
2.1 规则表：执行间隔与时间段
在 rules 表增加或约定以下字段：
执行间隔（分钟）
字段：execution_interval_minutes（推荐），或沿用 check_interval_minutes。
类型：INT NULL DEFAULT 15。
语义：对每个广告而言，同一条规则的两次触发之间的最小间隔（单位：分钟）。
前端选项映射：
| 前端选项 | 存入字段值（分钟） |
|-----------------|---------------------|
| 15 分钟 | 15 |
| 30 分钟 | 30 |
| 1 小时 | 60 |
| 3 小时 | 180 |
| 6 小时 | 360 |
| 自定义 X 小时 | Math.round(X * 60) |
默认：15 分钟（字段 NULL 时按 15 处理或 DB 默认 15）。
允许执行时间段
字段：execution_time_windows（JSON）。
结构：数组，每个元素为 { "start": "HH:mm:SS", "end": "HH:mm:SS" }。
约定：
所有时间为北京时区当日时刻；
start < end，暂不支持跨日（22:00–02:00 这种后续再扩展）；
空数组或 NULL 表示「全天允许」。
示例迁移：
ALTER TABLE `rules`  ADD COLUMN `execution_interval_minutes` INT NULL DEFAULT 15 COMMENT '执行间隔(分钟)',  ADD COLUMN `execution_time_windows` JSON NULL COMMENT '允许执行时间段(北京时间)';
2.2 冷却状态表：rule_ad_execution_state
新增表 rule_ad_execution_state（名称可调整），存储规则 × 广告的触发信息：
rule_id INT NOT NULL
ad_id VARCHAR(50) NOT NULL
last_executed_at TIMESTAMP NOT NULL COMMENT '最近一次触发时间（UTC）'
last_status ENUM('success','fail','suppressed','outside_window') NULL — 用于诊断（可选）
主键：PRIMARY KEY (rule_id, ad_id)
索引：
INDEX idx_rule (rule_id)
INDEX idx_ad (ad_id)
语义：
类似于「给每个广告打规则标签」：
每条 (rule_id, ad_id) 记录就是「广告 A 在规则 R 下的上次触发标签+时间」。
只在调度执行路径（每分钟 Cron）中读写；
手动「单条规则执行」不读也不写这张表。
三、动作优先级与仲裁（保持现有口径）
3.1 动作优先级表
见 server/utils/actionPriority.js：
export const ACTION_PRIORITY = {  pause_ad: 1,  activate_ad: 2,  decrease_budget: 3,  increase_budget: 4,  set_budget: 5}// 数字越小，优先级越高
3.2 规则内部候选动作
每条规则可以配置多个动作（如同时有 pause_ad 和 decrease_budget）；
仲裁前先通过 pickSingleCandidateAction(actions) 选出这条规则的候选动作：
比较 ACTION_PRIORITY，优先级数字小的胜；
同优先级时，采用配置顺序靠前的动作。
3.3 同一广告上的规则仲裁
对于某个广告 A，本轮可能有多条规则 R1、R2、R3 都命中；
仲裁过程：
每条规则拿到一条候选动作 + 该广告的 matchedAd。
按优先级数字比较候选动作类型：
pause_ad > activate_ad > decrease_budget > increase_budget > set_budget。
如果类型优先级相同：
ruleId 更小者获胜（tie-break）。
结果：
赢家（winnerRule + winnerAction）：真正对广告 A 执行动作；
输掉但命中的规则（suppressedRules）：记入「被压制」，不执行动作，但也视为本轮触发一次。
四、调度流程（每分钟 Cron）
4.1 Cron 任务
定义在 cronService.js 中，表达式 * * * * *（每分钟）。
职责：
找出当前需要执行的账户（基于你已有的 owner 权限与账户活跃状态）。
在受控并发与账户级锁的保护下，对每个账户调用：
     executeRulesForAccount(accountId, { fromScheduler: true })
不在 Cron 里按规则做冷却过滤（因为我们要到广告级别去看）。
4.2 executeRulesForAccount（调度入口）详细步骤
对某个账户 accountId，调度路径的 executeRulesForAccount 内部执行：
加载规则集
查询该账户下所有启用规则（同时通过 ruleAppliesToAccount 和用户权限过滤）。
一次性评估（RuleEngineDispatcher）
调用 collectAllMatchesForAccount(ruleEngine, allRulesForAccount, accountId) 得到：
     matchesPerRule = [       { rule: R1, matchedAds: [adA, adB, ...] },       { rule: R2, matchedAds: [adA, adC, ...] },       ...     ]
此阶段不修改冷却状态。
构造候选 (rule, ad) 集合并查询冷却表
遍历 matchesPerRule，收集所有 pair：(rule.id, ad.ad_id)；
对每条规则的这些广告，从 rule_ad_execution_state 中批量查询：
     SELECT ad_id, last_executed_at     FROM rule_ad_execution_state     WHERE rule_id = ? AND ad_id IN ( ... )
整理为内存 Map：state[ruleId][adId] = last_executed_at。
广告级冷却过滤
对每条规则 r 的 matchedAds，对每个 ad：
计算 intervalMin = r.execution_interval_minutes ?? r.check_interval_minutes ?? 15；
若 state[r.id][ad.ad_id] 不存在 → 视为无冷却，允许本轮触发；
否则计算 diffMin = (nowUTC - lastExec) / 60000：
若 diffMin >= intervalMin → 本轮到期，允许参与仲裁；
否则 → 仍在冷却期，本轮彻底跳过（既不仲裁，也不更新状态）。
过滤后的结构记为 matchesPerRuleDue（只保留广告级到期的匹配对）。
优先级仲裁（仅在到期集合上）
基于 matchesPerRuleDue 调用 arbitrateByAdId：
得到 Map<adId, { winnerRule, winnerAction, matchedAd, suppressedRules }>，其中：
winnerRule、winnerAction、matchedAd：本轮赢家；
suppressedRules：同一广告上被更高优先级动作压制的其它规则（均是到期规则）。
执行时间段检查（按规则）
对每个 adId：
计算当前北京时间 nowBJ = DateTime.utc().setZone('Asia/Shanghai')；
对 winnerRule 调用 isInExecutionWindow(winnerRule, nowBJ)：
若 windows 为空/null → 全天允许；
否则按第五节的算法判断。
推荐口径（简化且控频）：
只要该广告在该规则下「通过了广告级冷却且参与了仲裁」，无论是否在执行时间段内，均计为本轮触发一次；
区别仅在于 winner 是否真正执行动作。
执行动作与写日志
若在执行时间段内：
调用 executeActionsForAd 执行动作（pause/activate/预算）；
对每个结果写 automation_logs（含 run_id、metrics_snapshot 等）；
在摘要表 rule_execution_summaries 中记录 success/fail 统计；
冷却状态表将 winner 视为触发一次（见下一步）。
若不在执行时间段内（outside_window）：
不执行 executeActionsForAd；
在摘要中对 winnerRule 写 skip_reason='outside_execution_window'，skip_details 包含时间段信息；
仍视为一次触发（避免在窗口外每分钟重复尝试同一组合），更新冷却状态表。
对 suppressedRules：
不执行动作，只在摘要里对每个 loser 写 skip_reason='suppressed_by_priority'；
视为一次触发，更新冷却状态表。
更新冷却状态表 rule_ad_execution_state
本轮对广告 ad 触发的规则集合为：
     triggeredRulesForAd = [winnerRule, ...suppressedRules]
对于每个 (ruleId, adId) in triggeredRulesForAd：
     INSERT INTO rule_ad_execution_state(rule_id, ad_id, last_executed_at, last_status)     VALUES (?, ?, UTC_TIMESTAMP(), ?)     ON DUPLICATE KEY UPDATE       last_executed_at = VALUES(last_executed_at),       last_status      = VALUES(last_status);
其中 last_status 可以是 'success' / 'fail' / 'suppressed' / 'outside_window'。
五、允许执行时间段 isInExecutionWindow 逻辑
输入：
rule.execution_time_windows（JSON 数组或 null）；
nowBJ：Luxon 的 DateTime，zone=Asia/Shanghai。
输出： boolean。
算法：
若 windows 为 null、undefined 或非数组，或数组长度为 0：返回 true（全天允许）。
计算 currentSec = hour * 3600 + minute * 60 + second。
对 windows 中每一项 { start, end }：
将 start、end 解析成秒数：startSec、endSec；
若 startSec >= endSec：视为配置错误，忽略该段（或在保存时直接拒绝，后端校验）。
若 startSec <= currentSec <= endSec：返回 true。
所有段都没命中：返回 false。
六、手动「单条规则执行」的行为
6.1 不参与冷却表
单条规则执行入口（例如 POST /api/rules/:id/execute → executeSingleRule）：
不读取 rule_ad_execution_state 表：
无论某广告、某规则是否在冷却中，都可以执行（由操作者自己决策）。
不写入 rule_ad_execution_state 表：
这次手动执行不会改变自动调度的冷却状态，后续 Cron 仍按上一次自动触发时间来判断间隔。
6.2 与执行时间段的关系
推荐：单条执行仍遵守执行时间段（执行时间窗口内才真正下动作），以免半夜误操作；
如有需要，也可以在管理端提供「忽略执行时间段」的高级选项，但默认为遵守即可。
七、「立即运行所有规则」的移除
7.1 前端
在 RuleManager.vue 顶部 header 中移除：
「立即运行所有规则」按钮；
相关的 runRulesNow 方法与调用。
检查是否有其他页面（如 SystemStatus）存在类似按钮；如有，一并移除或改为仅显示状态。
7.2 后端
在 server/routes/rules.js 或 server/routes/system.js 中：
移除或废弃 POST /api/rules/execute-all 一类的路由。
在 cronService.js 中：
删除 manualExecuteAll、executeAllRules 等仅为「运行全部规则」服务的函数；
保留 executeSingleRule 作为单条执行入口。
八、前端配置文案与绑定（广告级语义）
8.1 执行频率配置
表单区块标题：「2. 执行频率与执行时间」。
文案示例：
> 执行频率（针对每个广告）：
> 每个广告在满足条件并被本规则触发一次后，至少间隔 N 分钟，本规则才会再次对该广告触发。
选项：15 分钟、30 分钟、1 小时、3 小时、6 小时、自定义（小时）。
字段绑定（示例）：
  ruleForm: {    // ...    executionIntervalMinutes: 15,    executionIntervalPreset: '15m',       // '15m' | '30m' | '60m' | '180m' | '360m' | 'custom'    executionIntervalHoursCustom: null,   // 自定义小时数，如 0.5, 2    executionTimeWindows: []              // 数组，映射到 execution_time_windows  }
保存时：
非 custom：preset→分钟映射；清空 executionIntervalHoursCustom；
custom：用小时数 X 算 Math.round(X * 60)，校验范围后写入 executionIntervalMinutes。
8.2 执行时间段配置
radio：
「全天」：executionTimeWindows = [] 或 null；
「指定时间段」：显示多行时间段输入。
列表展示：
若空：显示「执行时间：全天」；
若非空：显示「执行时间：09:00–18:00, 21:00–23:30」一类短文案。
九、典型行为验证（回归用例）
规则 R 作用 100 个广告，执行间隔 1 小时：
T0：10 个广告满足条件 → 仲裁后 10 个广告的相应规则触发，并更新冷却表；其余 90 个不触发。
T0 + 30 分钟：
这 10 个广告再满足条件 → 因冷却未过期，不参与仲裁、不更新状态；
其他 90 个中若有新广告满足条件 → 能立即进入仲裁并触发。
广告 A 上的三条规则 R1/R2/R3：
R1 = 1 小时、R2 = 30 分钟、R3 = 2 小时；
T0：三条规则都命中 → 经仲裁，有一条赢家，其余 suppressed；三条 (ruleId, adId) 全部写入冷却表；
T0 + 20 分钟：
对广告 A：R2 冷却已到期，R1/R3 仍在冷却；
T0+20 分的调度：广告 A 只可能在 R2 下被重新触发，R1/R3 这一轮不会参与仲裁。
outside_execution_window 行为：
规则时间段为 09:00–18:00；
某广告在 22:00 满足条件且广告级冷却已过期：
本轮仍会进入仲裁；
winner 不执行动作，摘要记 skip_reason='outside_execution_window'；
冷却表仍更新为「本轮已触发过一次」，避免 22:00–22:59 之间每分钟重复触发。
单条规则执行不参与间隔：
广告 A 在规则 R 下刚刚自动触发过一次，冷却期未过；
此时在 UI 上点「运行此规则」：
这次执行不看冷却表，可以立即执行动作；
这次执行不写冷却表，不改变下一次自动触发的冷却时间。
按这份方案落地，你就可以：
以「规则 × 广告」为粒度精准控制执行频率；
保持现有的动作优先级与仲裁语义；
确保多规则、多广告场景下互不干扰；
干净地移除 Smart Mute 执行路径，同时保留单条手动执行、不保留「运行全部规则」。