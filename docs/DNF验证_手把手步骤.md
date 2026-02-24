# DNF 验证 — 手把手步骤

已预填：accountId `act_1155891202142879`、你的 token。

---

## 第一步：导入集合

1. 打开 Thunder Client
2. 点 **Collections** → 右上角 **三个点** → **Import**
3. 选择 `docs/Thunder_Client_DNF验证集合.json`
4. 导入完成

---

## 第二步：按顺序执行

确保后端已启动（`npm run dev:server`），端口 3001。

### 1. 执行「1. 验证3-time_window不一致(400)」

- 点该请求 → 点 **Send**
- **验收**：Status 400，响应里有 `INCONSISTENT_TIME_WINDOW`

### 2. 执行「2. 验证4-v2空conditions(400)」

- 点 **Send**
- **验收**：Status 400，响应里有 `INVALID_CONDITIONS`

### 3. 执行「3. 验证1-创建v1 OR规则」

- 点 **Send**
- **验收**：Status 201
- **重要**：在响应 JSON 里找到 `"id": 123`（数字），记下这个数字，比如 `42`

### 4. 执行「4. 验证1-执行(需填ruleId)」

- 点开该请求
- 把 URL 里的 `REPLACE_WITH_RULE_ID` 删掉，改成上一步的 id，例如：`http://localhost:3001/api/rules/42/execute`
- 点 **Send**
- **验收**：响应里 `matched_count >= 1`

### 5. 执行「5. 验证2-创建v2 DNF规则」

- 点 **Send**
- **验收**：Status 201
- **重要**：记下响应里的 `"id"`，比如 `43`

### 6. 执行「6. 验证2-执行(需填ruleId)」

- 把 URL 里的 `REPLACE_WITH_RULE_ID` 改成上一步的 id，例如：`http://localhost:3001/api/rules/43/execute`
- 点 **Send**
- **验收**：有匹配则 `matched_count >= 1`，否则为 0

### 7. （可选）前端回显验证

- 打开规则管理页，找到「验证2-v2 DNF」
- 点编辑 → 应进入 JSON 模式，条件组不丢

---

## 完成

以上 6 步都通过即 DNF 集成验收完成。
