# Step 4 体验与完整性 — 验收与下一步

> 对应 TASKS 推荐顺序 Step 4；顺序 2（结构/选择器/刷新/resolve）已落地。

---

## 已具备（可验收后勾选）

| 项 | 说明 | 验收方式 |
|----|------|----------|
| 结构同步与选择器 | 手动 sync、选择器查 structure_ads、resolve 回显、刷新列表后补齐 missing | 见 `docs/resolve与sync_手把手验证步骤.md` |
| 前端 Dry Run 开关 | 规则编辑「模拟运行 (Dry Run)」开关，绑定 `isSimulation`，保存/回填 | 新建/编辑规则 → 勾选「仅模拟日志」→ 保存 → 再打开确认勾选状态；审计日志该条 `is_simulation=1` |

---

## 建议下一步（任选其一）

### 选项 A：勾选「前端 Dry Run 开关」

若你确认规则编辑里 Dry Run 开关可保存、回填且日志中 `is_simulation` 正确，可在 TASKS.md 中勾选：

- `前端：规则编辑新增 Dry Run（is_simulation）开关，并持久化到后端字段。`

### 选项 B：应用日志与轮转（Winston）— 已实现

- 对应 TASKS「0. 基础架构与测试」及「4.4 应用日志与轮转」。
- **实现状态（2026-02-10）**：统一 logger、按日轮转、14 天保留、关键模块已替换；**双写**：开发仅终端，生产为终端 + `logs/` 文件（便于事后排查）。日常开发用 `npm run dev:server`，需留档时用 `npm run dev:server:logs`（或 `set NODE_ENV=production&& node server/server.js`）。
- **Winston 验收步骤（可选，本机手动执行）**：
  1. **开发模式**：`npm run dev:server`，确认控制台为彩色分级输出，无写文件。
  2. **生产/双写模式**：`npm run dev:server:logs`（Windows）或 `NODE_ENV=production node server/server.js`（Mac/Linux），确认终端有输出且项目根目录下 `logs/` 存在 `combined-YYYY-MM-DD.log`、`error-YYYY-MM-DD.log`（JSON 格式）。
  3. **保留策略**：`logs/` 下仅保留约 14 天，旧文件可压缩为 `.gz`。
  4. **异常/拒绝**：未捕获异常写入 `exceptions-*.log`，未处理拒绝写入 `rejections-*.log`。
- 验收通过后，在 TASKS.md 中确认「0」与「4.4」Winston 相关子项已勾选。

### 选项 C：AdsPolar 验证脚本（5.1）— 建议下一步

**执行顺序**（详细步骤见项目根目录 `验证命令.md`、`下一个窗口验证和测试清单.md`）：

| 步 | 动作 | 命令或 SQL |
|----|------|------------|
| 1 | 验证写入清洗 | 后端已启动时：`node test-verify-sync.js`；看日志是否有 `🧹 [队列写入器] 数据清洗` 或确认无新僵尸数据 |
| 2 | 验证 data_date | `node test-verify-archive.js`；查 `ad_snapshots` 中 `data_date = 昨天` 的样本 |
| 3 | 热数据差异 1% | `node server/scripts/verify-spend-ads-completeness.js`；确认遗漏率 ≤1% 判为热数据差异 |
| 4 | SQL 综合 | 执行 `验证SQL查询.sql` 中查询，核对结果 |

**验收**：上述 4 步无报错、结果符合文档预期后，在 TASKS.md「5.1 AdsPolar 修复验证」中勾选对应子项。

---

## 汇总

- **已完成**：前端 Dry Run 开关已勾选（TASKS 239）；Winston 应用日志已落地（双写、关键模块替换、`npm run dev:server:logs`），TASKS 0/4.4 已勾选。
- **建议下一步**：按 **选项 C** 跑一遍 5.1 AdsPolar 验证（约 4 步），再勾选 TASKS 5.1；或选项 A 确认 Dry Run 开关后勾选。
- **日常**：开发用 `npm run dev:server`；需保留日志到文件时用 `npm run dev:server:logs`。
