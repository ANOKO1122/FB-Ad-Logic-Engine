# Step 1 pause_ad 真闭环 — 验收步骤

> 对应 TASKS.md 推荐顺序 Step 1：Pre-Flight 本地 status、非 Dry Run 真实 POST、already-state 容错。

---

## 验收项 1：Vitest 单元测试

**命令**：

```bash
npm test -- server/tests/preFlight.test.js
```

**预期**：所有用例通过（pause_ad Pre-Flight、activate_ad Pre-Flight、FB already 容错、Dry Run 下 Pre-Flight 生效）。

---

## 验收项 2：预算幂等（相关动作执行）

```bash
npm test -- server/tests/actionExecutorBudgetIdempotent.test.js
```

**预期**：通过（传 `_resolvedBudgetCents` 时不再调用 getAdsetBudget）。

---

## 验收项 3：规则执行链路（可选回归）

```bash
npm test -- server/tests/rules.test.js
```

**预期**：通过。

---

## 验收项 4：手动验证（可选）

若需确认**真实 POST** 与 **automation_logs**：

1. 新建一条规则：条件 `spend > 0` (today)，动作 `pause_ad`，**关闭 Dry Run**。
2. 选一个 ACTIVE 广告作为作用对象，保存。
3. 手动执行规则（或等 Cron），观察后端日志有 `✅ 成功暂停广告 xxx`。
4. 查库确认有日志记录：

```sql
SELECT id, rule_id, ad_id, status, skip_reason, triggered_at
FROM automation_logs
WHERE triggered_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
ORDER BY id DESC
LIMIT 10;
```

5. 在 FB 广告后台确认该广告状态变为 PAUSED。

---

## 验收步骤汇总

1. 执行 `npm test -- server/tests/preFlight.test.js`
2. 执行 `npm test -- server/tests/actionExecutorBudgetIdempotent.test.js`
3. （可选）执行 `npm test -- server/tests/rules.test.js`
4. （可选）按「验收项 4」做一次真实暂停 + 查库 + FB 后台核对
5. 若全部通过，在 TASKS.md 中确认 Step 1 相关项已勾选（多数已勾）
