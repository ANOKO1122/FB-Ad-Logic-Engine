# 动态筛选防误判与审计增强 — ID 归一化约定与 Code Review 清单

依据方案「动态筛选防误判与审计增强」v2 最终微调，本文档明确**保存与预览路径的 ID 归一化约定**，以及 Code Review 时需核对的入口，保证配置表从源头洁净、与「取消回写」形成闭环。

---

## 一、1.5 ID 归一化（act_ 修复）— 显式约定

### 1. 目的

保证写入 `rules.target_ids` / `target_by_account` 及预览结果的 ID 从源头就是**单层 act_** 格式，避免 `act_act_` 等脏数据进入配置表；配合「取消回写」语义，配置表不再被污染。

### 2. 约定一：保存规则时

- **createRule / updateRule** 必须通过现有 **syncTargetByAccount**（内部使用 `targetIdUtils.parseCompositeId` / `normalizeAccountId`）对 `target_ids` 做归一化后再落库。
- **禁止**将未归一化的 `act_act_` 等写入 `rules` 表。

### 3. 约定二：执行/预览时

- 凡生成复合 ID（`act_xxx:id`）并写入或返回给前端的路径，统一通过 **normalizeCompositeId(accountId, objId)** 生成，确保与 rules 侧格式一致且无重复前缀。

### 4. 实现确认（现状）

- **rulesService** 已在 createRule/updateRule 前调用 syncTargetByAccount，满足「保存时归一化」。
- **dynamicScopeService** 的 previewDynamicScope 已使用 normalizeCompositeId 生成 object_ids；回写 target_ids 时使用 normalizeAccountId(acc) + `${acc}:${objId}`，满足「预览与回写归一化」。

---

## 二、Code Review 清单：写 rules.target_ids 或返回复合 ID 的入口

以下入口在改动或新增逻辑时需核对「经 ID 归一化后再落库/再返回」。

| 类型 | 文件与位置 | 说明 |
|------|------------|------|
| 写 rules.target_ids | `server/services/rulesService.js` | createRule：第 52 行 syncTargetByAccount(ruleData) 后 db.insert；updateRule：第 196-197 行含 targetIds 时 syncTargetByAccount(updates) 后 db.update。 |
| 写 rules.target_ids | `server/services/dynamicScopeService.js` | refreshDynamicTargetsForRule 内约 704-713 行：从 rule_matched_objects 读出后用 normalizeAccountId(acc) 拼 targetIds，再 UPDATE rules。 |
| 返回复合 ID 给前端 | `server/services/dynamicScopeService.js` | previewDynamicScope：约 385 行 objectIds.push(normalizeCompositeId(accountId, adId))，返回 object_ids。 |
| 返回 target_ids（来自 DB） | 规则 API GET /api/rules、GET /api/rules/:id | 数据来源仅为上两处写入，已归一化；新增写 rules.target_ids 的路径时须经 syncTargetByAccount 或等价归一化。 |

---

## 三、审计计数维度：manual_count / dynamic_count

- **表**：`rule_matched_objects_history`
- **新增列**：`manual_count INT NULL`、`dynamic_count INT NULL`（兼容旧数据）。
- **含义**：当次动态筛选得到的 ad 数量（union 前）为 dynamic_count；当次手动目标展开到 ad 的数量（union 前）为 manual_count；便于排障时区分「筛选异常」与「手动勾选变化」。
- **写入**：仅在 status === NORMAL 且有变动时写入历史；INSERT 时传入 dynamic_count、manual_count（来自 calculateMatchedAdIdsForRule 返回值）。

详见迁移 `040_add_manual_dynamic_count_to_rule_matched_objects_history.sql` 与 dynamicScopeService 写入逻辑。
