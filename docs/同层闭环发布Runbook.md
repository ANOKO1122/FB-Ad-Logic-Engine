# 同层闭环发布 Runbook

## 1. 发布目标

- 发布范围：`campaign/adset` 同层闭环执行链改造（对象合同、scopeKey 冷却、手动执行时间窗、预算边界、审计字段、可解释 explanation）
- 发布策略：先迁库、后发版、再灰度开关
- 风险控制：默认保持 `RULE_LEVEL_EXECUTION_V2=0`，验证通过后切到 `1`

## 2. 本地准入门禁

1. 执行 `npm test`，必须全绿。
2. 执行 `npm run build`，必须构建成功。
3. 执行 `npm run perf:gate`，必须全部通过。
4. 检查规则创建/更新接口：
   - `targetLevel=campaign/adset` + 预算动作应被接口拒绝。
   - `targetLevel=campaign/adset` + 状态动作可保存。

## 3. 迁库顺序（云上）

1. 备份关键表：
   - `rule_matched_objects`
   - `rule_ad_execution_state`
   - `automation_logs`
2. 按顺序执行迁移：
   - `server/db/migrations/045_rule_matched_objects_typed_snapshot.sql`
   - `server/db/migrations/046_add_level_aggregation_indexes.sql`
   - `server/db/migrations/047_add_generic_object_fields_to_automation_logs.sql`
   - `server/db/migrations/048_add_explanation_to_automation_logs.sql`

## 4. 云上发版步骤

1. `git pull`
2. 如依赖变更则执行 `npm install`
3. 执行 `npm run build`
4. `systemctl restart fb-ad-logic-engine`
5. 确认服务状态：`systemctl status fb-ad-logic-engine`

## 5. 灰度切换

1. 第一阶段：`RULE_LEVEL_EXECUTION_V2=0`，验证迁库与新代码兼容。
2. 第二阶段：`RULE_LEVEL_EXECUTION_V2=1`，仅放开单 owner / 单账户 / 单 campaign。
3. 验证点：
   - `rule_matched_objects.object_type/object_id` 与目标层级一致。
   - `rule_ad_execution_state.scope_key` 使用 `status_campaign:*` / `status_adset:*`。
   - `automation_logs.object_type/object_id` 与执行对象一致。
   - `automation_logs.explanation.input.children` 包含子 ad 快照。
   - `automation_logs.explanation.conditionTrace` 可回放命中链路。

## 6. 回滚策略

1. 代码回滚：回退 Git 提交并重启服务。
2. 开关回滚：立即设 `RULE_LEVEL_EXECUTION_V2=0`。
3. 性能不达标：禁止开启 `RULE_LEVEL_EXECUTION_V2=1`，先修复 SQL/索引后重测。
4. 数据回滚：不回滚表结构，`automation_logs.explanation` 允许保留，按向前修复策略处理数据问题。
