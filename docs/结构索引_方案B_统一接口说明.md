# 结构索引 · 方案 B：服务层聚合（统一接口）— 说明与教学

## 一、一句话比喻

**以前**：前端要 campaign 打 A 接口、要 adset 打 B 接口、要 ad 打 C 接口，三个接口返回的字段还不一样，前端要写很多 `if (level === 'campaign') ... else if ...`。  
**现在**：只打一个接口 `/api/structure/objects?type=campaign|adset|ad`，服务端根据 `type` 内部派发到三张结构表，**统一成同一套字段**再返回，前端/规则只处理一种结构，少分支、少拼装。

---

## 二、为什么要这样设计（和“建 DB 视图”的区别）

- **不建 DB 视图**：表结构不动，风险小；视图一旦建错或要改口径，要改库、要迁移。
- **服务层统一**：逻辑在 Node 里，改口径只改代码、可灰度、可加权限/限流/缓存，大厂常见做法。
- **统一返回结构**：每条对象都有 `id, type, name, campaign_id, adset_id, effective_status, account_id`。campaign 的 `adset_id` 为空、`campaign_id` 为自己 id；adset 的 `adset_id` 为自己 id；ad 两个都来自结构表。这样前端和规则侧不用再“如果是 campaign 就取这个字段，如果是 ad 就取那个字段”。

---

## 三、本次变更点（落到文件/函数）

| 位置 | 变更 |
|------|------|
| `server/services/structureSyncService.js` | 新增 `listStructureObjectsFromDb(accountId, { type, q, limit, after, include_paused })`，type 只允许 campaign/adset/ad，内部分发到现有三个 list，再映射成统一字段返回。 |
| `server/index.js` | 新增 `GET /api/structure/objects`，参数 account_id、type、q、limit、after、include_paused；调 `listStructureObjectsFromDb`，返回 `{ items, paging: { after? }, meta }`。 |
| `src/services/facebookApi.js` | 新增 `getStructureObjectsUnified(type, accountId, opts)`，请求 `/api/structure/objects`。 |
| 旧接口 | `GET /api/structure/:level`（campaigns/adsets/ads）**保持不变**，不影响现有前端。 |

---

## 四、风险点与注意点

- **type 校验**：只允许 `campaign | adset | ad`，否则 400，避免误传 level 或其它字符串。
- **权限**：与旧接口一致，走 `requireAuth`、`requireActive`、`assertAccountAccess(account_id)`。
- **兼容**：旧接口未删，前端可以逐步从“三个 level 接口”迁到“一个 objects + type”，验收时两套都能用。

---

## 五、验收口径（你可执行的验证步骤）

1. **type=campaign / adset / ad 都能返回**
   - 用 Postman 或 curl（需带登录后的 Cookie/Token）：
     - `GET /api/structure/objects?account_id=act_你的账户&type=campaign&limit=10`
     - 同上把 `type` 换成 `adset`、`ad`
   - 预期：200，`items` 为数组，每条带 `id, type, name, campaign_id, adset_id, effective_status, account_id`。

2. **字段统一**
   - campaign：`type=campaign`，`campaign_id === id`，`adset_id === null`。
   - adset：`type=adset`，`adset_id === id`，`campaign_id` 有值（来自 structure_adsets）。
   - ad：`type=ad`，`campaign_id`、`adset_id` 来自 structure_ads。

3. **筛选与分页仍有效**
   - 加 `q=关键词`、`include_paused=1`、`after=游标`，结果应符合筛选和分页（与旧接口行为一致）。

4. **多账户接口 GET /api/structure/objects/multi 的 meta（2026-02-14 补充）**
   - 多账户合并列表接口 `GET /api/structure/objects/multi?account_ids=act_1,act_2&type=ad&limit=50` 在响应 `meta` 中增加：
     - **per_account_limit**：每账户参与合并时的条数上限（数字）。
     - **has_more**：是否存在更多数据（与 paging.has_more 一致），便于前端「加载更多」与每账户配额展示。
   - 验证：用 Thunder Client 带 token 与 Query 发 GET objects/multi，检查 Response 中 `meta.per_account_limit`、`meta.has_more` 存在且合理。详见 `docs/Thunder_Client_小白验证步骤.md`。

5. **旧接口不受影响**
   - 直接调 `GET /api/structure/campaigns`、`/adsets`、`/ads`（同 account_id、limit 等），返回格式与之前一致，不报错。

---

## 六、面试可问 / 你怎么答（要点）

- **问**：为什么用“服务层聚合”而不是数据库视图？  
  **答**：不改表结构、易灰度、易加权限和缓存；视图改口径要动库，部署和回滚成本高。

- **问**：统一接口返回的 `campaign_id`/`adset_id` 在不同 type 下含义？  
  **答**：campaign 只有 campaign_id（自身 id）、adset_id 为空；adset 有 campaign_id（上级）和 adset_id（自身）；ad 两个都来自结构表，便于前端/规则统一处理。

- **问**：和原来三个接口（campaigns/adsets/ads）的关系？  
  **答**：新接口是统一入口、统一字段；旧接口保留兼容，前端可逐步迁移。

---

## 七、验证结论（实测通过，可直接发给 AI 作上下文）

本次 6 项验证结论如下（全部通过；第 3 项为“不可验证但原因正常”）：

1. **include_paused**：通过。开启 `include_paused=1` 时返回的对象更多，默认只返回 ACTIVE。
2. **q 搜索过滤**：通过。`q` 为 name 模糊匹配，结果符合预期。
3. **分页 after**：当前账号数据量不足，`paging.after` 为 null，无法生成下一页；属正常现象，非 bug。
4. **三层级接口一致性**：通过。`/structure/campaigns`、`/adsets`、`/ads` 返回结构一致且 `meta.source` 正确。
5. **结构关系正确性**：通过。用 `/api/structure/resolve` 校验 ad/adset/campaign 的 type 和关系字段一致，均可返回且无 missing。
6. **统一接口 /api/structure/objects**：通过。`type=ad` / `adset` / `campaign` 均 200；items 字段统一（id/type/name/campaign_id/adset_id/effective_status/account_id），`meta.source` 与 type 匹配。

**额外说明（原因与修改）**  
- 此前 `objects` 返回 400，是因路由顺序导致 `/api/structure/:level` 抢先匹配（`objects` 被当作 `level`）。已通过**将 objects 路由移到 :level 之前注册**修复。  
- 修改仅调整注册顺序，无业务逻辑变更。

---

**小结**：方案 B 已完成「服务层统一函数 + 统一路由 + 前端可选方法」，旧接口保留；路由顺序已修正，objects 与 :level 均按预期命中。
