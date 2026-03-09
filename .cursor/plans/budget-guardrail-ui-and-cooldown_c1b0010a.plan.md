---
name: budget-guardrail-ui-and-cooldown
overview: 落地预算动作新语义（上限封顶、下限托底、set_budget只往上补），并按动作类型精简前端上限/下限输入，同时保持“skip 也占冷却”以降低重复执行与数据库压力。
todos:
  - id: backend-budget-logic
    content: 更新 actionExecutorService 预算计算语义（上限封顶/下限托底/set只上调）并保留 new==current 跳过机制
    status: pending
  - id: backend-validator
    content: 扩展 templateValidator：新增 min_daily_budget 校验并限制各动作可用字段
    status: pending
  - id: frontend-rulemanager
    content: RuleManager 按动作类型显示上限/下限输入，新增 onMinBudgetInput，提交 payload 过滤无关字段
    status: pending
  - id: frontend-admintemplates
    content: AdminTemplates 同步 RuleManager 的字段显示与提交规则
    status: pending
  - id: tests-update
    content: 补充 budgetUnitCents 与 templateValidator 单测覆盖新语义与字段约束
    status: pending
  - id: manual-verify
    content: 执行前端交互与运行期验收：skip不调API、审计日志正确、冷却占用生效
    status: pending
isProject: false
---

# 预算动作护栏与前端精简执行方案

## 目标与口径

- **increase_budget（增加预算）**：
- 若 `current > max_daily_budget`：跳过（保持 current，不下发 API）。
- 否则执行并封顶：`new = min(current + step_or_percent_delta, max_daily_budget)`。
- **decrease_budget（减少预算）**：
- 若 `current <= min_daily_budget`：跳过（保持 current，不下发 API）。
- 否则执行并托底：`new = max(current - step_or_percent_delta, min_daily_budget)`。
- **set_budget（设置预算）**：
- 仅在 `current < target` 时执行，`new = target`。
- `current >= target` 时跳过。
- **统一原则**：只要 `new === current`，执行层 Pre-Flight 一律 `skipped`，不调 FB API；调度层仍写冷却状态（按现有机制占用冷却周期）。

## 代码改造分层

### 1) 后端数据与校验层

- 文件：[server/utils/templateValidator.js](d:/projects/FB-Ad-Logic-Engine/server/utils/templateValidator.js)
- 改造点：
- 为预算动作新增 `min_daily_budget` 校验（单位分，整数，`>=100` 或留空）。
- `increase_budget` 仅允许 `max_daily_budget`；`decrease_budget` 仅允许 `min_daily_budget`；`set_budget` 禁止上限/下限字段（或按兼容策略自动忽略并告警，建议先严格校验）。
- 若同一动作误传上下限冲突字段，返回明确报错，避免脏配置落库。

### 2) 后端预算计算层（核心语义）

- 文件：[server/services/actionExecutorService.js](d:/projects/FB-Ad-Logic-Engine/server/services/actionExecutorService.js)
- 改造点（`computeNewBudgetCentsOnce`）：
- 读取 `currentBudgetCents` 后，按动作类型分别处理：
- `increase_budget`：超上限对象不动；未超上限对象执行后封顶。
- `decrease_budget`：在下限或以下对象不动；其余执行后托底。
- `set_budget`：仅上调，不下调（`current>=target` 返回 current）。
- 保持返回整数分值，继续沿用 `MIN_BUDGET_CENTS` 兜底。
- 执行层无需新增分支：现有 Pre-Flight 已在 `currentCents === newBudgetCents` 时 `skipped`，天然满足“与预期一致就跳过”。

### 3) 调度与冷却一致性

- 文件：[server/services/cronService.js](d:/projects/FB-Ad-Logic-Engine/server/services/cronService.js)、[server/services/ruleExecutionStateService.js](d:/projects/FB-Ad-Logic-Engine/server/services/ruleExecutionStateService.js)
- 核查点（无需大改）：
- 当前逻辑已将 `skipped`（只要非 fail）写为冷却成功状态，且写入预算 scopeKey + ad scopeKey 双键。
- 本次仅需补充日志文案区分 skip 原因（`above_max_cap` / `below_min_floor` / `budget_already_at_target`），便于排查。

## 前端 UI 改造（你要求的美观与减噪）

### 4) 规则页动作编辑 UI（必做）

- 文件：[src/views/RuleManager.vue](d:/projects/FB-Ad-Logic-Engine/src/views/RuleManager.vue)
- 改造点：
- `increase_budget`：仅显示“预算上限（美元，可选）”。
- `decrease_budget`：仅显示“预算下限（美元，可选）”。
- `set_budget`：不显示上限/下限输入。
- 保留 `value_unit`（percent/usd）和 `value` 输入逻辑；`set_budget` 固定 `value_unit='usd'`。
- 新增 `onMinBudgetInput`（美元->分），与 `onMaxBudgetInput` 风格一致。
- `onActionTypeChange` 时清理不相关字段，避免旧字段残留：
- 切到 increase：保留/初始化 `max_daily_budget`，清掉 `min_daily_budget`。
- 切到 decrease：保留/初始化 `min_daily_budget`，清掉 `max_daily_budget`。
- 切到 set_budget：清掉 `max_daily_budget/min_daily_budget`。
- `saveRule` 与 `actionsPayload` 映射同步新增/过滤 `min_daily_budget`。

### 5) 管理员模板页 UI（你已确认要同步）

- 文件：[src/views/AdminTemplates.vue](d:/projects/FB-Ad-Logic-Engine/src/views/AdminTemplates.vue)
- 改造点：
- 与 RuleManager 同口径：increase 显示上限，decrease 显示下限，set 不显示。
- 增加 `onMinBudgetInput`，并在 `onActionTypeChange`、`saveTemplate`、payload 映射中同步字段清理与透传。

## 测试与验收

### 6) 后端单测

- 文件：[server/tests/budgetUnitCents.test.js](d:/projects/FB-Ad-Logic-Engine/server/tests/budgetUnitCents.test.js)
- 新增用例：
- increase：`current=6500,max=7000,step=10` -> `7000`（封顶）。
- increase：`current=9000,max=7000` -> `9000`（超上限不动）。
- decrease：`current=3600,min=3000,step=10` -> `3000`（托底）。
- decrease：`current=1000,min=3000` -> `1000`（下限以下不动）。
- set：`current=7000,target=5000` -> `7000`（不下调）；`current=4000,target=5000` -> `5000`。

### 7) 校验层单测

- 文件：[server/tests/templateValidator.test.js](d:/projects/FB-Ad-Logic-Engine/server/tests/templateValidator.test.js)
- 新增用例：
- decrease 允许 `min_daily_budget`；increase 允许 `max_daily_budget`。
- increase 传 `min_daily_budget` / decrease 传 `max_daily_budget` / set 传上下限 -> 校验失败。
- `min_daily_budget < 100` 或非整数 -> 校验失败。

### 8) 前端手动验收（两页）

- RuleManager + AdminTemplates：
- 切换动作时字段显示正确（无多余 UI）。
- 字段切换后旧值不污染 payload。
- 保存后再编辑，字段回显与动作一致。
- 运行期验收：
- 命中规则但 `new===current` 时，审计日志为 skipped；不发 FB 预算更新请求；冷却表时间更新。

## 风险与兼容策略

- 历史规则可能已有“错误字段组合”（例如 decrease 带 max）：
- 建议在前端打开编辑时做一次归一化清理（不展示也不再提交）。
- 后端继续严格校验，阻止新增脏数据。
- 为避免线上突发，先上“校验+计算+UI”一体变更，避免前后端口径不一致。

## 实施顺序（最短闭环）

1. 后端纯函数语义 + 校验器。
2. RuleManager UI 与 payload。
3. AdminTemplates UI 与 payload。
4. 单测补齐。
5. 手动验收（重点看 skipped + 冷却更新）。