# FB-Ad-Logic-Engine 云端项目开发过程总结（2026-05-12）

## 1. 文档元信息

- **日期**：`2026-05-12`
- **环境**：云上服务器（示例主机名 `vital-gigs-11`）、工作目录 `/root/work/FB-Ad-Logic-Engine`
- **关联执行方案**：
  - Cursor 计划 `time-window-upgrade_050328ee.plan.md`（时间窗口升级、`lifetime` 口径、前后端枚举对齐）
  - Cursor 计划 `dynamic-budget-plan_3f4c4998.plan.md`（多天购买次数平均数、`set_dynamic_budget`、调度/仲裁/冷却与预算节点一致）
- **文档目的**：记录本轮**项目目标**、**方案落地情况**、**遇到的问题与解决方法**，含时间窗口与 `lifetime` 展示修复、**动态预算与手动范围安全**、**云上部署与端口/进程排障**，便于后续运维与新人对齐。

---

## 2. 项目背景与本轮目标

### 2.1 项目背景（简述）

**FB-Ad-Logic-Engine / FB 智投** 面向 Facebook 广告投放的监控与自动化规则：规则按时间窗口取数 → 多天聚合 → 条件判断 → 执行动作。本轮在**不推翻**「先聚合、再判条件」模型的前提下，扩展**时间窗口语义**、**「至今为止」取数口径**，并新增**多天购买次数平均数**条件与**设置动态预算值**动作，同时收紧**手动目标范围**与**预算节点路由**，避免误伤全账户或误调预算节点。

### 2.2 时间窗口与 lifetime 业务目标

1. 在保留「近 3 天含今天」等既有窗口的前提下，新增 **近 3/5/7 天（含今天 / 不含今天）** 等枚举，与产品文案对齐。
2. 将原「累计」语义调整为 **「至今为止」**（`lifetime`）：指标范围从 **对象 `created_time` 对应自然日** 起算，**含今天**，至当前数据时区「今日结束」。
3. 前端规则配置下拉、模板、审计文案与后端校验**共用同一套枚举**，避免「前端能选、保存被拒」或执行与展示不一致。

### 2.3 动态预算与条件扩展业务目标

1. **条件**：新增内部指标 `purchases_avg_after_create`（展示名「多天购买次数平均数」），**仅** `targetLevel=ad` 可用；创建日排除、有效自然日分母、`null` 不触发等口径与计划 `dynamic-budget-plan_3f4c4998.plan.md` 一致。
2. **动作**：新增 `set_dynamic_budget`（指标 × 倍率 + 上下限美分），`ad` / `adset` / `campaign` 规则层均可配置；指标来自当前规则时间窗下命中的 **`matchedObject`**（含同层聚合）。
3. **预算节点**：实际调用 Facebook 的仍是 **广告组或广告系列** 日预算；须与既有 **ABO/CBO 智能路由** 一致；`campaign` 层在 **ABO 多广告组均有预算** 时**不得**强行选一个组改预算（**跳过**并写明原因）。
4. **调度一致性**：冷却键、仲裁 `scopeKey` 与执行层解析出的**真实预算节点**一致，避免「仲裁按 A、执行按 B」导致重复下发或错误压制。

### 2.4 本轮技术目标（汇总）

1. `server/utils/timeWindow.js`：各新窗口 **Luxon 自然日边界**（账户/数据时区一致）；`lifetime` 终点等。
2. `server/services/ruleDataService.js`：`queryMultiDayWindow`、`queryRuleDataByLevel` 与 `includeToday`；`lifetime` 查库起点按 `created_time` 收紧；`effective_range` 回传。
3. `GET /api/rule-data`：`meta.range.start` 与真实查库起点对齐（非 epoch 占位误导）。
4. `ruleDataService`：广告层 `purchases_avg_after_create` 及辅助字段；非广告层不开放该指标作条件或动态预算指标。
5. `actionExecutorService`：`computeDynamicBudgetCents`、`resolveBudgetTargetContext`（含 **campaign 层 ABO 多组跳过**）；审计字段完整。
6. `rules.js` / `ruleEngineDispatcher.js`：**手动范围无目标 fail-closed**；`parseDynamicScopePayload` 仅当字段 **`!== undefined`** 视为显式传入，避免默认「关动态」被误判为显式 `false`。
7. `cronService.js`：动态预算纳入仲裁；异步解析 `scopeKey` 与执行层一致；失败回退冷却键时传入正确 `action`。
8. `ruleEnableGateService.js`：`validateActions(actions, targetLevel)`；合并/切换层级后校验 `purchases_avg_after_create` 仅允许 `ad`。
9. `server/index.js`：Facebook 预算更新错误体解析，便于区分 **400 业务错误** 与限流等。

---

## 3. 执行方案完成情况

### 3.1 对照 `time-window-upgrade_050328ee.plan.md`

计划中各 todo 状态均为 **completed**，与仓库当前实现一致，摘要如下：

| 里程碑 | 内容摘要 | 结论 |
|--------|----------|------|
| 统一枚举 | 前端 `RuleManager.vue` / `AdminTemplates.vue`、`ruleAuditNarrative.js`、`templateValidator.js`、`ruleEngineDispatcher`（短别名）等与后端对齐 | **已完成** |
| 日期边界 | `timeWindow.js`：`last_3/5/7` 含今天与 `*_excluding_today`；单元测试 `timeWindow.test.js` | **已完成** |
| 广告层多天取数 | `queryMultiDayWindow`、`doesWindowIncludeToday`；不含今天不查今日快照 | **已完成** |
| 同层聚合 | `queryRuleDataByLevel` 与 `includeToday`、层级 `created_time`；测试 `ruleDataService.levelStatus.test.js` 等 | **已完成** |
| lifetime 创建时间 | `loadCreatedSinceByAd`、`queryDailyStatsForRange` 过滤；`CREATED_TIME_MISSING` | **已完成** |
| 测试 | 时间窗口、level、dispatcher 等相关测试 | **已完成** |

### 3.2 对照 `dynamic-budget-plan_3f4c4998.plan.md`

计划 frontmatter 中六项 todo 均已标为 **completed**；实现与计划一致部分不再逐条复述，**相对计划文档的增量与纠偏**如下（均已写回计划文件「执行状态」小节）：

| 计划条目 | 落地说明 |
|----------|----------|
| 指标 `purchases_avg_after_create` | `ruleDataService` 广告层计算 + 单测覆盖有效日、`null`、普通 `purchases` 不受影响 |
| 条件仅 `ad` | 前后端限制 + `templateValidator` + `ruleEnableGateService` 启用与合并路径校验 |
| `set_dynamic_budget` | 配置校验、执行层公式与上下限、`actionPriority`、审计解释扩展 |
| `campaign` 动态预算 | **CBO 改系列**；**ABO 单子组可路由到该组**；**多子组有预算则跳过**（与计划初稿「一律改系列」不同，属线上必要纠偏） |
| 调度/冷却 | `cronService` 与 `actionExecutorService` 共用解析逻辑；手动范围空目标 **dispatcher 跳过** |
| 测试 | `rules.test.js`、`ruleEngineDispatcher.test.js`、`actionExecutorService.statusIntent.test.js`、`ruleEnableGateService.test.js` 等；全量 **`npm test`**、**`npm run build`** 通过 |

---

## 4. 遇到的问题与解决方法

### 4.1 前端时间窗口下拉未更新

- **现象**：线上规则页「时间窗口」仍为旧选项（无「不含今天」、无「至今为止」等）。
- **原因**：只重启了 **Node 后端**；页面静态资源来自 **`npm run build` 产出的 `dist/`**，未重新构建或未部署到 Nginx/容器挂载目录时，浏览器仍是旧 bundle。
- **解决**：在仓库根目录执行 `npm ci`（按需）与 **`npm run build`**，将 **`dist/`** 同步到实际对外静态根；浏览器 **强刷** 避免缓存。

### 4.2 `lifetime` 路径下接口 500 / JS 报错：`Assignment to constant variable.`

- **现象**：`/api/rule-data` 等使用 `lifetime` 时返回错误信息含 **`Assignment to constant variable.`**。
- **原因**：`queryMultiDayWindow` 内对 **`startDate`** 使用了 **`const`**，在 `lifetime` 分支需按最早 `created_time` 重写起点时发生 **对常量重新赋值**。
- **解决**：将需重赋值的变量改为 **`let`**（仅必要处）。

### 4.3 `meta.range.start` 在 `lifetime` 下仍显示 `1970-01-01`，与真实查库起点不一致

- **现象**：查库已按 `created_time` 收紧，但 HTTP 返回的 **`meta.range.start`** 仍为 **`1970-01-01`**。
- **原因**：`meta` 原先直接取自 **`calculateTimeWindow('lifetime')`** 的语义占位起点；真实起点在 **`ruleDataService`** 内按广告计算，未回传到接口层。
- **解决**：`queryRuleData` 在 `lifetime` 时返回 **`effective_range`**；**`GET /api/rule-data`** 组装 **`meta.range.start`** 时优先使用 **`result.effective_range.start`**，并重算 **`meta.range.days`**；单测断言 **`effective_range`**。

### 4.4 验收 `curl` 仍为 1970：systemd 与「野进程」抢端口

- **现象**：**`systemctl show ... MainPID` 为 `0`** 或 **`inactive`**，但 **`ss` 显示 3001 仍有 `node`**；直调 **`queryRuleData`** 已有正确 **`effective_range`**，**HTTP `curl` 仍为 1970**。
- **原因**：长期占 **3001** 的 **`node` 非当前 systemd 托管进程**（例如历史 **`nohup node server/server.js`**）；**`systemctl restart` 拉起的进程退出**后，流量仍打到旧进程。
- **解决**：  
  1. **`tr '\0' ' ' < /proc/<PID>/cmdline`** 确认监听进程命令行。  
  2. **结束占用 3001 的旧 `node`**。  
  3. **`sudo systemctl start fb-ad-logic-engine.service`**，确认 **`Active: active (running)`** 且 **`MainPID` 与 `ss` 中 PID 一致**。  
  4. **`curl ... time_window=lifetime`** 核对 **`meta.range.start.local`** 与 **`effective_range`** 一致。

### 4.5 构建时的 Vite 提示（非阻塞）

- **现象**：`npm run build` 时出现 **`NODE_ENV=production is not supported in the .env file`** 类提示。
- **说明**：属 Vite 对 `.env` 中写 `NODE_ENV` 的约束提示，**不阻止**生产构建成功。

### 4.6 规则仅选手动单广告却命中大量对象：手动范围 + 空 `target_ids` 扩大为全账户

- **现象**：规则配置为单账户、未开启动态、仅意图操作少量对象，调度评估却命中 **十余个或全账户级** 广告。
- **根因**：落库形态为 **`use_dynamic_scope=0`** 且 **`target_ids=[]`**（或等价空数组）时，旧逻辑按「全账户广告」拉取评估集合。
- **解决（纵深）**：  
  1. **`server/routes/rules.js`**：`assertManualScopeHasTargets`；保存/更新时拒绝空手动目标；`PUT` 合并后对 `purchases_avg_after_create` 与 `targetLevel` 再校验。  
  2. **`server/services/ruleEngineDispatcher.js`**：`use_dynamic_scope=0` 且目标为空 → **跳过评估**（fail-closed），不再拉全账户 `ad_id`。  
  3. **`src/views/RuleManager.vue`**：关动态且无目标时 **阻止提交**。

### 4.7 默认创建规则无法保存：`parseDynamicScopePayload` 将「未传参」误判为显式 `false`

- **现象**：新建/默认规则在未显式传 `useDynamicScope` 时被后端当成 **`use_dynamic_scope=false` + 空目标**，触发 **MANUAL_SCOPE_TARGETS_REQUIRED**。
- **根因**：`parseDynamicScopePayload` 把字段 **`undefined`** 与显式布尔 **`false`** 混用同一分支，导致「缺省」被当成「显式关闭动态且未选目标」。
- **解决**：仅当请求体字段 **`!== undefined`** 时视为显式传入，再进入手动范围目标校验。

### 4.8 `set_dynamic_budget` 在 `campaign` 层、ABO 场景调系列预算导致 Facebook `400`

- **现象**：`targetLevel=campaign`、系列为 **ABO**（预算在广告组）时，仍对 **Campaign** 下发日预算更新，Graph API 返回 **400**。
- **根因**：动态预算执行层未与旧预算动作一致走 **CBO/ABO 智能路由**。
- **解决**：**`resolveBudgetTargetContext`**：系列有日预算 → **CBO 改系列**；无系列预算且子广告组聚合 **唯一** 有组预算 → **改该组**；**多个** 子组有预算 → **`campaign_abo_multiple_adsets_requires_adset_level`** **skipped**（产品预期为跳过而非瞎改）。执行层可缓存 **`_resolvedDynamicBudgetTargetContext`** 供同请求复用。

### 4.9 仲裁键 / 冷却键与真实预算节点不一致

- **现象**：同轮或多轮调度中，仲裁赢家、被压制规则写入的 `scopeKey` 与最终执行调用的 **adset/campaign** 不一致，导致冷却或互斥行为不符合预期。
- **根因**：调度侧曾用简化假设（如固定按规则 `targetLevel`）生成键，而执行层才解析真实预算挂载点。
- **解决**：**`cronService.js`** 对 `set_dynamic_budget` **异步解析**与执行层相同的预算上下文，**`pickSingleCandidateAction`** 与压制记录使用同一 **`scopeKey`**；失败回退 **`cooldownKey`** 时传入正确的 **`actionToPass`**。

### 4.10 启用规则时报错或层级切换后条件与层级不匹配

- **现象**：`targetLevel` 非 `ad` 时仍允许带「多天购买次数平均数」条件启用；或 **PUT** 只改 `targetLevel` 未重传条件体，绕过校验。
- **解决**：**`ruleEnableGateService.validateActions(actions, targetLevel)`**；启用与更新路径校验 **`purchases_avg_after_create` 仅 `ad` 可用**。

### 4.11 线上手动执行弹窗显示「跳过」但原因不直观；接口返回 `set_dynamic_budget not supported`

- **现象 A**：前端仅展示「跳过」，未展示后端 **`skip_reason`**（若后续要产品化，可在 UI 映射展示）。  
- **现象 B**：请求返回 **`set_dynamic_budget not supported`** 或动作不执行。
- **原因 B**：云上 **`node` 进程仍为旧代码**（同 **4.4**：未部署新构建或未重启到正确 PID），与仓库已通过测试的代码版本不一致。
- **解决 B**：确认 **`dist/`** 与 **`server/`** 已同步、**仅 systemd 托管实例监听 3001**，再 **`systemctl restart fb-ad-logic-engine.service`** 后复测。

### 4.12 Facebook 预算错误难以从日志判断是「业务拒绝」还是其它

- **现象**：日志仅见 **400** 或笼统 message，缺少 **`error_subcode` / `error_user_msg`**。
- **解决**：**`server/index.js`**（及预算更新调用链）解析 **`formatFacebookErrorPayload`** / **`formatRequestError`**，在非 2xx 响应体中附带结构化 **`facebookError`**。

---

## 5. 主要改动文件（便于代码检索）

**时间窗口与 lifetime**

- `server/utils/timeWindow.js`
- `server/services/ruleDataService.js` — `queryMultiDayWindow`、`loadCreatedSinceByAd`、`effective_range`、`queryRuleDataByLevel`
- `server/index.js` — **`GET /api/rule-data`** 的 **`meta.range`** 与 **`effective_range`**
- `server/utils/templateValidator.js`、`server/services/ruleEngineDispatcher.js`、`server/utils/timeWindowMapping.js`（若存在短别名）
- 前端：`src/views/RuleManager.vue`、`src/views/AdminTemplates.vue`、`src/utils/ruleAuditNarrative.js`
- 测试：`server/tests/timeWindow.test.js`、`server/tests/ruleDataService.levelStatus.test.js`、`server/tests/ruleEngineDispatcher.test.js`

**动态预算、手动范围、调度与错误体**

- `server/routes/rules.js` — 手动目标、`parseDynamicScopePayload`、`PUT` 合并校验
- `server/services/ruleEngineDispatcher.js` — 手动范围空目标跳过
- `server/services/actionExecutorService.js` — `set_dynamic_budget`、`resolveBudgetTargetContext`、缓存
- `server/services/cronService.js` — 动态预算仲裁与 `scopeKey`
- `server/services/ruleEnableGateService.js` — `validateActions` 与层级
- `server/utils/templateValidator.js` — 条件/动作合法枚举
- `server/utils/actionPriority.js` — `set_dynamic_budget` 优先级
- `server/utils/automationLogExplanation.js` — 审计解释
- `server/index.js` — Facebook 错误格式化
- 前端：`src/views/RuleManager.vue`
- 测试：`server/tests/rules.test.js`、`server/tests/ruleEngineDispatcher.test.js`、`server/tests/actionExecutorService.statusIntent.test.js`、`server/tests/ruleEnableGateService.test.js` 等

---

## 6. 验收要点（云上可复现）

**时间窗口与 lifetime**

1. 新建/编辑规则 → 时间窗口含 **近 3/5/7 天（含/不含今天）**、**至今为止**、自定义；保存与列表正常。  
2. `GET /api/rule-data`，`time_window=lifetime`：**`meta.range.start`** 与结构表 **`created_time`** 最早自然日 **一致**，**非** `1970-01-01`；**`days`** 与起止一致。  
3. **仅由 `systemd` 托管的 Node 监听 3001**，`MainPID` 与 `ss` PID 一致。

**动态预算与手动范围**

1. **手动范围**：未开启动态且未选任何目标 → **保存失败**；已落库空目标规则 → **调度不评估**（不拉全账户）。  
2. **`campaign` + ABO 多广告组有预算**：预期 **`campaign_abo_multiple_adsets_requires_adset_level`** **跳过**，不应对某一组静默改预算。  
3. **CBO / ABO 单子组**：预算 API 目标与 **`resolveBudgetTargetContext`** 一致；审计日志含公式指标、倍率、裁剪与最终美分。  
4. 发版前在**可绑定监听端口**的环境执行全量 **`npm test`** 与 **`npm run build`**（部分用例依赖本机监听；沙箱或受限环境可能出现 `EPERM`，以 CI/云上全绿为准）。

---

## 7. 后续建议（运维与协作）

1. **统一启动方式**：生产以 **`fb-ad-logic-engine.service`** 为准，避免 **`nohup`** 与 **systemd** 双实例。  
2. **发布后自检**：`systemctl status` + `ss -lntp` + **`MainPID` 与监听 PID 一致** + 关键接口 `curl`；必要时查 **`journalctl -u fb-ad-logic-engine.service -n 200`** 与库表/文件型 **`automation_logs`**（以实际部署为准）。  
3. **JWT 与密钥**：排障中若暴露过 Token，按安全流程 **轮换**。  
4. **产品可选**：手动执行结果弹窗展示 **`skip_reason`** 映射文案，缩短「跳过」无因的排障时间。

---

## 8. 结论

本轮已按 **`time-window-upgrade_050328ee.plan.md`** 完成**时间窗口扩展**、**「至今为止」取数与 `meta` 对齐**，并按 **`dynamic-budget-plan_3f4c4998.plan.md`**（含执行状态纠偏）完成 **`purchases_avg_after_create`** 与 **`set_dynamic_budget`** 全链路；同时收口 **手动范围空目标全账户误伤**、**动态 scope 默认值误判**、**campaign 层 ABO 预算路由**、**调度仲裁与预算节点一致**、**Facebook 错误体可读** 及 **云上双 Node 占端口导致「代码已更、行为未更」** 等问题。文档落盘于 **`项目开发过程/`**，供后续迭代与排障对照。
