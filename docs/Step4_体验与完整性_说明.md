# Step 4 体验与完整性 — 是什么、做什么

> 对应 TASKS 推荐开发顺序的**第四步**，排在「数据可信 → 能真关广告 → 日志可解释」之后，主题是：**优化选择与同步体验、补齐体验与完整性**。

---

## 一、Step 4 是什么

**Step 4 = 体验与完整性**，聚焦两件事：

1. **结构同步**：结构镜像（structure_ads / campaigns / adsets）的**增量策略、定时轮转、手动刷新**等行为是否完整、可验收。
2. **选择器体验**：规则管理里「选择目标对象」的**查库、分页、过滤、多账户、监控范围条件**等是否好用、无穿透 FB、数据一致。

在整体顺序里的位置：

- **Step 0**：数据口径（today spend>0、status=effective_status）
- **Step 1**：pause_ad 真闭环（Pre-Flight、真实 POST、already-state 容错）
- **Step 2**：审计可复盘（automation_logs 最小字段）
- **Step 3**：Piggyback 补齐 structure_ads（失败不影响主链路）
- **Step 4**：**体验与完整性**（结构增量/定时同步、选择器优化等）← 当前阶段

---

## 二、当前状态（大部分已落地）

TASKS 里和 Step 4 相关的内容，**多数已经勾选**：

| 类别 | 内容 | 状态 |
|------|------|------|
| 结构镜像表 | structure_ads、structure_campaigns、structure_adsets 建表与三层查库 | ✅ 已落地 |
| 定时同步 | 每小时结构全量轮转（默认 6 账户、可上调 12、并发 1）、P0 让路 | ✅ 已落地 |
| 伪增量 | 每 15 分钟心跳后对 diffIds 做 resolveObjectsByIds，不依赖 FB updated_time | ✅ 已落地 |
| 手动刷新 | POST /api/sync/structure，锁+冷却，前端「刷新列表」 | ✅ 已落地 |
| 选择器查库 | GET /api/structure/:level、objects、objects/multi 查库，0 FB 列表调用 | ✅ 已落地 |
| 监控范围条件 | scope_status、name_exclude 后端 SQL 过滤 + multi 游标修复 | ✅ 已落地 |

也就是说：**主流程已经按「结构增量 + 定时同步 + 选择器优化」设计做完了**，Step 4 现在指的是**剩余项与可选优化**。

---

## 三、Step 4 阶段我们做什么（剩余与可选）

下面是可以放在「Step 4 体验与完整性」里做的事，按优先级大致分为三类。

### 3.1 验收与回归（建议先做）

- **结构同步验收**  
  - 伪增量：一轮 touched_rows 远小于全表，无「mode=incremental 却扫全表」；手动暂停广告后，下一轮伪增量能把 structure_ads 状态更新为 PAUSED。  
  - 全量轮转：先完成热同步再跑结构同步；usage 高时本小时跳过结构任务。  
  - 手动刷新：见 `docs/Step4_刷新列表端到端验收.md`，点刷新 → POST /api/sync/structure → 列表从 structure_ads 重载。
- **选择器验收**  
  - 默认仅 ACTIVE，勾选「包含暂停」后能看到 PAUSED；输入 q 能搜到目标；全程 0 FB 列表调用。  
  - 多账户 + 监控范围条件：已勾选数与 SQL 一致（你已核对过 act_1155891202142879 + 名称包含 0）。
- **Step4 文档里的可选验收**  
  - `docs/Step4_体验与完整性_验收与下一步.md` 中的选项 A/B/C（Dry Run 开关、Winston 日志、AdsPolar 验证脚本），按需执行并在 TASKS 里打勾。

### 3.2 可选实现与优化

- **选择器统一走统一接口（可选）**  
  - 将 RuleManager 选择器从「三个 level 接口」逐步迁到 `getStructureObjectsUnified` + type，统一走 `GET /api/structure/objects`（单账户 / multi 已有），减少分支、便于维护。
- **campaigns/adsets 纳入定时轮转（按需）**  
  - TASKS 写明：当前仅 **ads** 层级参与每小时结构全量轮转；**campaigns/adsets** 待后续按需再纳入。若你希望广告系列/广告组也定时从 FB 全量更新，可在 Step 4 里加这一块。
- **级联选择控件（可选，属 2.3）**  
  - 前端「账户 → 广告系列 → 广告组 → 广告」级联下钻，最终写入 target_ids。TASKS 2.3 仍有未勾选项，可算作体验完整性的一部分，按需做。

### 3.3 文档与清单

- 在 `docs/Step4_体验与完整性_验收与下一步.md` 里，把「已验收」的项标清楚，避免和「未做」的混在一起。
- 在 TASKS 里为「结构同步增量化」「选择器本地展示过滤」的**验收口径**单独打勾（若你已按 3.1 验收通过）。

---

## 四、总结：Step 4 一句话

- **Step 4 体验与完整性** = 在「数据可信、能真关广告、日志可解释」都做完之后，把**结构同步（增量/定时/手动）**和**选择器（查库/过滤/多账户/监控条件）**的体验与行为验收完，并做**可选**的接口统一、campaigns/adsets 轮转、级联选择等优化。

**当前建议**：先做 3.1 的验收与回归（结构同步 + 选择器 + 监控条件数量），再视需要做 3.2 的某一两项（例如统一接口或 campaigns/adsets 轮转）。
