# 测试说明：Vitest 用例与验证范围

> 整理自 `npm test` 输出，用于理解各测试验证什么、通过/不通过的影响。

---

## 一、总体结果

| 项目 | 值 |
|------|-----|
| 测试文件 | 14 passed |
| 测试用例 | 133 passed |
| 典型耗时 | ~2.5s |

---

## 二、各测试文件覆盖内容

### 1. src/utils/conditionsTransform.test.js（2.3.1 条件转换）

| 测试 | 验证内容 |
|------|----------|
| linesToV2Groups：A AND B OR C | 线性 `[首行, AND, OR]` 正确转成 2 组 v2 DNF |
| linesToV2Groups：custom_range | 选择自定义日期时，每条 condition 带相同 `custom_range` |
| linesToV2Groups：空 lines | 空输入 → 空 groups，不抛错 |
| v2ToLines：v2 → 线性 | v2 回填时 OR 落在新组首条，AND/OR 不丢 |
| v2ToLines：空 v2 | 空 v2 → 空 lines，timeWindow 默认 today |
| v1ToLines：单条/多条 | v1 旧规则能正确转成 whenLines 和 timeWindow |
| createDefaultWhenLine | 默认条件结构正确 |
| getDefaultWhenCustomRange | 返回当天 since=until |
| 往返一致性 | lines→v2→lines 后 AND/OR 不丢失 |

**不通过的影响**：前端编辑/保存规则时，条件组可能转换错误或回填丢失 AND/OR。

---

### 2. server/tests/conditionsValidator.test.js（条件组校验）

| 测试 | 验证内容 |
|------|----------|
| v1 空数组应无效 | 空条件被拒绝 |
| v1/v2 合法结构 | 合法条件被接受 |
| v2 groups 为空、group.conditions 为空 | 防止永真/空组 |
| v2 time_window 一致性 | 同规则内 time_window 必须一致 |
| normalizeConditionsToV2 | v1 AND/OR 正确归一化为 v2 |

**不通过的影响**：后端可能接受非法规则，或执行逻辑与预期不符。

---

### 3. server/tests/timeWindow.test.js（时间窗口）

| 测试 | 验证内容 |
|------|----------|
| today / yesterday / last_3_days / lifetime | 各时间窗口计算正确 |
| 时区 | UTC、Asia/Shanghai 等边界正确 |
| 非法 time_window | 抛出明确错误 |

**不通过的影响**：规则执行时查询时间范围错误，导致误判或不触发。

---

### 4. server/tests/rateLimitService.test.js（频率控制）

| 测试 | 验证内容 |
|------|----------|
| parseUsageHeader | 解析 `x-business-use-case-usage` |
| calculateSleepTime | 使用率 <50% / 50–85% / >85% 时休眠正确 |
| estimated_time_to_regain_access | 优先按 FB 要求等待 |
| Token 熔断 | 连续 3 次 190 后触发熔断 |
| fetchWithTimeout | 超时后正确抛错 |

**不通过的影响**：限流、休眠、熔断或超时行为异常，易触发 429 或 Token 被封。

---

### 5. server/tests/preFlight.test.js（执行前检查）

| 测试 | 验证内容 |
|------|----------|
| pause_ad | PAUSED/DISABLED/ARCHIVED/DELETED 时跳过，不调 FB |
| activate_ad | ACTIVE 时跳过；ARCHIVED/DELETED 时记不可激活 |
| already 容错 | FB 返回 "already paused/activated" 时记 skipped |
| Dry Run | 模拟模式下不调 FB |

**不通过的影响**：可能对已暂停/已启用广告重复调用 API，浪费配额。

---

### 6. server/tests/budgetUnitCents.test.js（预算单位）

| 测试 | 验证内容 |
|------|----------|
| increase_budget / decrease_budget | 百分比计算正确（如 1000 分 +10% → 1100 分） |
| 下限护栏 | 不低于 100 分 |
| 美元 ↔ 美分 | 转换正确、四舍五入 |
| 幂等 | 传入 _resolvedBudgetCents 时不再重复查预算 |

**不通过的影响**：预算变更可能算错、精度丢失，或重复调 FB。

---

### 7. server/tests/ruleEngine.test.js（规则引擎）

| 测试 | 验证内容 |
|------|----------|
| gt / lt / AND / OR | 比较与逻辑正确 |
| DNF 语义 | `(A AND B) OR C` 评估正确 |
| v1 OR 兼容 | 旧 v1 OR 规则仍能正确匹配 |
| getTimeWindowFromConditions | v2 的 time_window / custom_range 提取正确 |

**不通过的影响**：规则命中/未命中与预期不符，导致误关广告或该关不关。

---

### 8. server/tests/ruleEngine.evaluateRule.test.js（评估链路）

| 测试 | 验证内容 |
|------|----------|
| logicOperator 驼峰 | `logicOperator: 'OR'` 等字段名兼容 |

**不通过的影响**：数据库/API 字段命名变更时，规则执行可能失效。

---

### 9. server/tests/rules.test.js（规则 API）

| 测试 | 验证内容 |
|------|----------|
| POST /api/rules | 创建规则、必填校验、v2 格式校验 |
| GET /api/rules | 列表与详情返回正确字段 |
| PUT /api/rules/:id | 更新正确 |
| DELETE /api/rules/:id | 删除正确 |

**不通过的影响**：规则 CRUD 异常，前端无法正常管理规则。

---

### 10. server/tests/health.test.js（健康检查）

| 测试 | 验证内容 |
|------|----------|
| GET /api/health | 返回 200、含 timestamp 等字段 |

**不通过的影响**：监控/探活无法判断服务是否正常。

---

### 11. 其他测试文件

| 文件 | 简要说明 |
|------|----------|
| ruleDataService.test.js | 时区读取、link_clicks=0 时 cpc=0 等计算 |
| ingestorService.test.js | Today / Past 7 Days 合并、冷数据归档 |
| actionExecutorBudgetIdempotent.test.js | 预算幂等执行 |
| smartMute.test.js | Smart Mute 冷却逻辑 |

---

## 三、通过 vs 不通过的影响

| 状态 | 影响 |
|------|------|
| **全部通过** | 条件转换、校验、时间窗口、限流、执行前检查、预算单位、规则引擎、API、数据同步等核心逻辑按预期工作；可安全发布或继续开发 |
| **有失败** | 视失败模块而定：可能规则保存/回填错误、执行逻辑错误、预算算错、限流失效、重复调用 FB 等；应先修复再发布 |

---

## 四、如何运行

```bash
# 运行全部测试
npm test

# 只跑 conditionsTransform
npx vitest run src/utils/conditionsTransform.test.js

# 监听模式
npm run test:watch
```

---

## 五、总结

133 个用例覆盖了：

1. **2.3.1 条件转换**（前端逻辑）
2. **规则校验与引擎**（后端规则评估）
3. **限流与熔断**（API 安全）
4. **执行前检查**（避免无效 API 调用）
5. **预算单位与幂等**（财务与执行正确性）
6. **规则 CRUD API**（接口可用性）
7. **数据同步与归档**（数据正确性）

全部通过时，从规则配置到执行与预算变更的主链路都有自动化保障。
