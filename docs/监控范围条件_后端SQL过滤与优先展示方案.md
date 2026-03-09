# 监控范围条件：后端 SQL 过滤 + 优先展示方案

## 一、目标与问题

- **现状**：前端根据「状态 等于 所有投放中」「名称 包含 xx」等条件，先拉全量（或后台分批拉全量），再在前端过滤勾选，多账户时请求多、数据量大、界面卡。
- **目标**：不在前端拉「不满足条件」的数据；由**后端按条件查库**，只返回满足条件的对象，并**优先展示**（如开启在前），前端只做展示和勾选，不再做大列表过滤。

---

## 二、思路概览

1. **后端**：结构列表接口支持「监控范围」相关过滤参数，在 SQL 里用 `WHERE` 限定状态、名称包含/不包含，只查满足条件的行；需要时 `ORDER BY` 把 ACTIVE 排前面。
2. **前端**：应用监控范围条件时，把当前条件行转成上述 API 参数，只请求「带过滤」的列表；拿到首屏（或全部）匹配结果后直接展示并**全部勾选**，不再拉全量再前端过滤。
3. **效果**：不拉不满足条件的目标，节省时间和资源；列表天然是「匹配项优先/仅匹配项」，无需大费周章拉全量。

---

## 三、后端设计

### 3.1 新增/约定参数（与现有兼容）

在现有 `q`、`limit`、`after`、`include_paused` 基础上，为「监控范围」增加：

| 参数 | 说明 | 示例 |
|------|------|------|
| `scope_status` | 状态过滤：只查指定状态 | `active_only` / `paused_only` / `active_and_paused` |
| `scope_status_exclude` | 状态排除：从上述状态集合中排除指定状态 | 逗号分隔，如 `PAUSED` 或 `ACTIVE,PAUSED`（与「状态 不等于」对应） |
| `name_exclude` | 名称不包含（SQL NOT LIKE） | 关键词字符串 |
| `scope_created_within_hours` | 创建时间段：只查近 N 小时内创建的对象（按当前时间滑动） | 正整数，如 `24`、`48`、`72` 或 1–720 自定义 |

- **`scope_status`**（可选）  
  - `active_only`：只查 `effective_status = 'ACTIVE'`  
  - `paused_only`：只查 `effective_status = 'PAUSED'`  
  - `active_and_paused`：查 `effective_status IN ('ACTIVE','PAUSED')`  
  - 不传或空：沿用现有逻辑（由 `include_paused` 决定 ACTIVE 或 ACTIVE+PAUSED），保证兼容。

- **优先级（与 include_paused）**  
  - **当 `scope_status` 有值时**：忽略 `include_paused`，仅按 `scope_status` 决定状态集合。  
  - **当 `scope_status` 为空时**：按「q 为空 → 仅 ACTIVE；include_paused=1 → ACTIVE+PAUSED；q 非空 → 放宽到多类状态」执行。  
  - 避免二者同时生效产生冲突。

- **`scope_status_exclude`**（可选，与前端「状态 不等于」对应）  
  - 逗号分隔的状态码，如 `PAUSED` 或 `ACTIVE,PAUSED`。  
  - 在得到 `statusList`（由 scope_status 或 include_paused/q 决定）后，从 statusList 中排除这些状态再参与 `WHERE effective_status IN (...)`。  
  - 若排除后 statusList 为空，则返回空结果。

- **`name_exclude`**（可选）  
  - 非空时：`AND (name NOT LIKE '%name_exclude%')`（可按需做大小写不敏感）。  
  - **名称类条件大表**：`LIKE '%x%'` / `NOT LIKE '%x%'` 在前导通配符下难以用 name 索引，大表上较贵；WHERE 顺序保持「先 account_id + effective_status，再 name 条件」，便于先用索引缩小再扫 name。名称包含（q）与名称不包含（name_exclude）均按此原则。

- **`q`**（已有）  
  - 继续表示「名称包含」：`AND name LIKE '%q%'`。

- **`scope_created_within_hours`**（可选）  
  - 为正整数时：`AND created_time IS NOT NULL AND created_time >= ?`，阈值为 `UTC_TIMESTAMP() - INTERVAL N HOUR`（或等价：`new Date(Date.now() - N * 3600 * 1000).toISOString()`）。  
  - 与名称/状态条件 **AND** 组合：即「状态 AND 名称包含 AND 名称不包含 AND 创建时间段」同时满足才返回。

- 多个条件同时存在时：**AND** 组合（状态 AND 名称包含 AND 名称不包含 AND 创建时间段）。

### 3.2 SQL 行为（三个 list 方法统一）

以 `listStructureAdsFromDb` / campaigns / adsets 为例，逻辑一致：

1. **状态列表 `statusList`**  
   - 若传了 `scope_status`：  
     - `active_only` → `['ACTIVE']`  
     - `paused_only` → `['PAUSED']`  
     - `active_and_paused` → `['ACTIVE','PAUSED']`  
   - 若未传 `scope_status`：保持现有逻辑（`include_paused` → `['ACTIVE','PAUSED']` 或 `['ACTIVE']`；有 `q` 时用 `EFFECTIVE_STATUS_FILTER`）。

2. **WHERE**  
   - `account_id = ?`  
   - `effective_status IN (?, ...)`  
   - 若 `q` 非空：`AND name LIKE ?`（`%q%`）  
   - 若 `name_exclude` 非空：`AND (name NOT LIKE ? OR name IS NULL)`，参数 `%name_exclude%`  
   - 若 `scope_created_within_hours` 为正整数 N：`AND created_time IS NOT NULL AND created_time >= ?`，参数为当前时间往前 N 小时的 ISO 字符串（与名称/状态条件 AND 组合）。  
   - **名称包含与名称不包含同时存在时**：语义为「最终集合 = 名称包含 AND 名称不排除」，后端用上述 AND 组合即可；前端不再对同一条件做二次过滤。  
   - **注意**：`NOT LIKE` 在大表上可能无法利用 `name` 索引，高频使用 `name_exclude` 时需关注全表扫描风险；必要时可考虑先用「包含」缩小候选集再排除。  
   - **较贵原因**：名称包含（`LIKE '%x%'`）与名称不包含（`NOT LIKE '%x%'`）依赖字符串匹配，无法用 B-Tree 索引直接定位，只能在「account_id + effective_status 已筛选出的行」上逐行判断；大表时成本较高。当前 WHERE 顺序已尽量先用索引缩小范围，若出现慢查询可考虑两段查询或应用层过滤。  
   - 若有 `after`：`AND id > ?`

3. **ORDER BY**  
   - 当 `statusList` 包含 ACTIVE 与 PAUSED 时：`ORDER BY (effective_status = 'ACTIVE') DESC, id ASC`，保证**开启的在前**。  
   - 当只查单一状态时：`ORDER BY id ASC` 即可。

4. **分页**  
   - 不变：`LIMIT limit+1`，用最后一条 `id` 作为 `after` 游标。

### 3.3 接口传递

- **GET /api/structure/objects**  
  - 增加 query：`scope_status`、`name_exclude`，原样传给 `listStructureObjectsFromDb`。

- **GET /api/structure/objects/multi**  
  - 同上，在首轮与带 `after` 的请求里都带上 `scope_status`、`name_exclude`，传给每个账户的 `listStructureObjectsFromDb`。  
  - **多账户分页**：已支持完整组合游标（`after` 为 base64 的 `{ i, a, pas }`）；带 `after` 时解码并对对应账户拉下一页。前端多账户下会循环「加载更多」直到无 `after`，与后端对齐。

- **listStructureObjectsFromDb**  
  - 把 `opts.scope_status`、`opts.name_exclude` 放进 `listOpts`，下发给三个 list 方法。

---

## 四、前端设计

### 4.1 从「条件行」到 API 参数

在「应用监控范围条件」时，根据当前已填写的条件行，算出请求参数（仅对「已完成」行）：

- **状态 等于**  
  - 「所有投放中」→ `scope_status = 'active_only'`  
  - 「所有已暂停」→ `scope_status = 'paused_only'`  
  - 「所有投放中和已暂停」→ `scope_status = 'active_and_paused'`  
  - 若没有状态行或未选值：不传 `scope_status`（沿用现有 `include_paused` 等）。
- **状态 不等于**（同一状态行的 operator 为「不等于」时）  
  - 「所有投放中」→ `scope_status_exclude = 'ACTIVE'`（且不传 scope_status 或由默认 statusList 再排除）  
  - 「所有已暂停」→ `scope_status_exclude = 'PAUSED'`  
  - 「所有投放中和已暂停」→ `scope_status_exclude = 'ACTIVE,PAUSED'`  
  - 列表请求同时带 `scope_status_exclude`，后端在 statusList 上排除后再查。

- **名称 包含**  
  - 有关键词 → `q = 关键词`（已有逻辑）。

- **名称 不包含**  
  - 有关键词 → `name_exclude = 关键词`。

- **创建时间段 包含**  
  - 选「近 24/48/72 小时内」或「自定义 N 小时」→ `scope_created_within_hours = N`（多行创建时间段取**最短窗口** min 小时）。  
  - 不传或非法值：后端不生效；前端仅在合法正整数时传参。

多行条件之间为 AND，对应后端 SQL 的 AND。

### 4.2 何时「带过滤」请求、何时不再拉全量

- **存在任意「监控范围条件」**（至少一行完整）：  
  - 用上面规则生成 `scope_status`、`q`、`name_exclude`、`scope_created_within_hours`（及现有 `include_paused` 若仍需兼容）。  
  - 调用结构列表（单账户 / multi）时**始终带上这些参数**，即「只拉满足条件的对象」。

- **不再**：  
  - 不因为「有状态/名称条件」就先拉全量再前端过滤；  
  - 不依赖「后台分批拉全量」做首屏（可选保留为「加载更多」的后续页，但首屏只请求带过滤的一页）。

### 4.3 首屏与勾选逻辑

- 应用条件时：  
  - 用当前条件生成 API 参数；  
  - 只请求**一页**（例如 limit=500）的「带过滤」结果；  
  - 将结果赋给列表数据源，并**对本页结果全部勾选**（因为后端已过滤，本页即匹配项）；  
  - 若有 `paging.after`：展示「已勾选 N 个（当前已加载）；点击加载更多可继续」，用户点「加载更多」再请求带相同参数 + `after` 的下一页，追加到列表并继续全部勾选。

- 这样：  
  - 首屏只拉「满足条件的 500 条」，不再拉不满足条件的目标；  
  - 开启状态优先由后端 `ORDER BY` 保证，前端可保留现有「ACTIVE 在前」的展示排序作为补充。

### 4.4 与现有「needFetchAll」的衔接

- 可保留「needFetchAll」为「需要带过滤的列表」的标记：  
  - 有名称包含/不包含/状态条件/**或创建时间段条件** → needFetchAll = true。  
- 但 needFetchAll 时的行为改为：  
  - **只**用上述参数请求**带过滤**的列表（首屏一页，或加「加载更多」），**不再**做「先拉全量再前端过滤」或「后台循环拉全量再过滤」。  
- 若仍保留「多账户后台拉全量」作为可选：可改为「只拉带过滤的全量」（每页都是匹配项），请求数会少很多，前端仍可择机简化为首屏 + 加载更多。

---

## 五、实现要点小结

| 层级 | 内容 |
|------|------|
| **后端** | 三个 list 方法支持 `scope_status`、`name_exclude`、`scope_created_within_hours`；WHERE 与 ORDER BY 如上；单账户 / multi 路由透传参数。 |
| **前端** | 条件行 → `scope_status` / `q` / `name_exclude` / `scope_created_within_hours`；列表请求带这些参数；首屏只请求一页带过滤结果并全部勾选；需要时再「加载更多」同参数 + after。 |
| **效果** | 不拉不满足条件的目标；满足条件的对象优先展示（ACTIVE 在前）；名称/状态/创建时间段条件完全由 SQL 满足，前端不再大列表过滤。 |

---

## 六、可选：仅展示匹配项 vs 展示全部且匹配项在前

- **当前方案**：仅请求「匹配」的数据，列表里只展示匹配项并全部勾选（推荐）。  
- 若将来需要「列表里也看到不匹配的，但匹配的排前面」：  
  - 可再增加一种模式或参数，例如先按条件查匹配 id 列表，再请求「全部」列表并在前端按该 id 列表排序（匹配的在前）；实现复杂度更高，建议先做「只查匹配」方案。

---

按此方案实现后，选「状态等于所有投放中」或「名称包含 xx」时，将直接走 SQL 过滤，只返回并优先展示满足条件的对象，不再为不满足条件的目标浪费请求与前端计算。

---

## 七、尚未验证 / 测试清单（收尾用）

实现与 multi 游标修复已完成，以下为建议的验证/测试项，可按需打勾。

### 7.1 后端

| 项 | 说明 |
|----|------|
| ☐ multi 不带 after | GET `/api/structure/objects/multi` 无 after 时 200，有更多时返回 `paging.after`、`has_more: true` |
| ☐ multi 带 after | 用上一步的 after 再请求，返回下一页，且与上一页 **不重复**（游标修复后不再重复） |
| ☐ multi + scope 参数 | 同一 URL 加 `scope_status=active_only` 或 `name_exclude=xxx`，结果条数与 SQL 一致（可用 `server/db/migrations/verify_scope_conditions_count.sql` 核对） |
| ☐ 单账户 + scope | GET `/api/structure/objects` 或 `/api/structure/:level` 带 `scope_status`、`name_exclude`，结果正确过滤 |

### 7.2 前端（规则弹窗 → 作用对象 → 监控范围条件）

| 项 | 说明 |
|----|------|
| ☐ 单账户 + 名称包含 | 能拉匹配结果，超过一页时出现「加载更多」，勾选数与后端一致 |
| ☐ 单账户 + 名称不包含 | 只展示不包含关键词的项并全部勾选（后端 SQL 过滤，不再前端大列表过滤） |
| ☐ 多账户 + 名称包含 | 自动循环加载更多直到没有更多；最终「已勾选 N 个」与多账户 SQL 合计一致 |
| ☐ 多账户 + 名称不包含 | 同上，仅展示不包含关键词的项，勾选数与 SQL 一致 |
| ☐ 状态条件 | 「所有投放中 / 已暂停 / 投放中+已暂停」勾选与选项一致；**多账户时已勾选数 = SQL 对应 COUNT**（广告/广告组/广告系列均可各测一次） |
| ☐ 创建时间段 | 选「近 24/48/72 小时内」或自定义小时，列表只展示该时间窗口内创建的对象并全部勾选；多行创建时间段取最短窗口；单账户与多账户均带同一组 `scope_created_within_hours` |

### 7.3 数量核对（可选）

用 `server/db/migrations/verify_scope_conditions_count.sql` 中语句查库，与界面「已勾选 N 个对象」对比：

- 广告层级：状态=所有投放中 → 应与 `ad_active_count` 一致（修复游标后应为 94 而非 134）。
- 广告组/广告系列：按条件（如 状态=所有投放中 AND 名称包含 0224）与对应 SQL 结果一致。

### 7.4 自动化测试（可选）

- 是否有单元/集成测试覆盖：multi 带 after 时跳过 `pas[j]==null` 的账户、不返回 `a: null` 的游标。
- 是否覆盖 `scope_status`、`name_exclude` 在 list 与路由中的透传。

以上全部通过即可视为本方案与游标修复验收完成。
