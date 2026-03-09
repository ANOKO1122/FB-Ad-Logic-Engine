# 方案 A 验证与测试指南（多账户 after 游标 + 监控范围条件）

本文档说明如何验证/测试「方案 A」相关功能，包括你尚未验证过的部分。

---

## 一、要验证的功能概览

| 模块 | 功能 | 验证方式 |
|------|------|----------|
| 后端 | `GET /api/structure/objects/multi` 支持 `after` 游标分页 | 接口测试（Thunder Client / curl） |
| 前端 | needFetchAll 包含「名称 不包含」且有关键词 | 规则弹窗内手动操作 |
| 前端 | 多账户下「应用监控范围」时自动拉全量（循环加载更多） | 规则弹窗内手动操作 |
| 前端 | 多账户下显示「加载更多」按钮并能正确翻页 | 规则弹窗内手动操作 |

---

## 二、前置条件

1. **后端已启动**  
   例如：`node server/index.js` 或 `npm run dev`，端口默认 3001（若不同请把下文中的 `3001` 换成你的端口）。

2. **拿到登录 token**  
   - 用 Thunder Client 或 Postman 发 **POST** `http://localhost:3001/api/auth/login`，Body 选 JSON：`{"username":"你的用户名","password":"你的密码"}`。  
   - 响应 200 后，从 JSON 里复制 **token** 整段（如 `eyJhbGciOiJIUzI1NiIs...`）。  
   - 后续请求在 Header 里加：`Authorization: Bearer <刚复制的token>`。

3. **至少两个有权限的广告账户**  
   用于验证多账户。若只有一个账户，可只做单账户相关验证。

---

## 三、后端验证：multi 接口的 after 游标

### 3.1 第一页（不带 after）

1. 新建 GET 请求，URL：
   ```text
   http://localhost:3001/api/structure/objects/multi
   ```
2. **Headers**：`Authorization: Bearer <你的token>`  
3. **Query**：

   | Name        | Value                          |
   |-------------|---------------------------------|
   | account_ids | act_账户1,act_账户2             |
   | type        | ad（或 campaign / adset）       |
   | limit       | 50                             |

   把 `act_账户1,act_账户2` 换成你有权限的两个账户 ID。

4. 发送请求。

**检查**：

- Status **200**。
- 响应里有 **paging**：
  - 若当前数据超过一页，应有 **paging.after**（一串 base64），且 **paging.has_more** 为 `true`。
  - 若数据不足一页，**paging.after** 可为 `undefined`，**paging.has_more** 为 `false`。
- **meta.has_more** 与 **paging.has_more** 一致。
- **items** 里每条都有 **account_id**。

### 3.2 第二页（带 after）

1. 复制上一响应的 **paging.after** 整段（若为 undefined 说明没有下一页，可换 limit 更小或换账户再测）。
2. 同一 GET 请求，在 **Query** 里增加一行：

   | Name  | Value           |
   |-------|------------------|
   | after | 粘贴 paging.after |

3. 再次发送。

**检查**：

- Status **200**。
- **items** 是「下一页」数据，条数一般 ≤ limit，且与第一页不重复（可对比第一页的 `id`+`account_id`）。
- 若还有更多页，会再次返回 **paging.after** 和 **paging.has_more: true**；否则 **paging.has_more** 为 `false`。

**结论**：以上通过即说明后端 multi 的 after 游标工作正常。

---

## 四、前端验证：规则弹窗内的监控范围条件

在「规则管理」页：新建规则或编辑已有规则，打开规则弹窗，到 **「2. 作用对象 (Where)」**。

### 4.1 单账户 +「名称 包含」+ 加载更多

1. 只选 **1 个** 广告账户。
2. 目标层级选「广告」（或广告组/广告系列）。
3. 在「监控范围条件」第一行：字段选 **名称**，操作符选 **包含**，值里输入一个**能匹配到多条**的关键词（例如你账户里广告名共有的某个词）。
4. 等待约 2 秒（防抖）或随便点一下别处，触发自动应用。

**预期**：

- 提示「正在拉取匹配结果…」。
- 列表会拉取匹配结果；若超过一页，会出现 **「加载更多」** 按钮。
- 点击「加载更多」后，列表变长，直到没有更多时按钮消失。
- 最后提示「已勾选 N 个对象」，且下方列表中匹配项被勾选。

### 4.2 单账户 +「名称 不包含」

1. 仍单账户、目标层级「广告」。
2. 监控范围条件：字段 **名称**，操作符 **不包含**，值里输入一个关键词。
3. 等待自动应用。

**预期**：

- 会先拉取全量（或足够多）数据（不包含时 needFetchAll 已包含此情况）。
- 列表中只显示「名称中不包含该关键词」的广告，并自动勾选。
- 若数据多页，应能看到「加载更多」并可用。

### 4.3 多账户 +「名称 包含」+ 全量 + 加载更多

1. 选 **2 个或更多** 广告账户。
2. 目标层级选「广告」。
3. 监控范围条件：**名称** **包含** 某关键词（能匹配到多条更好）。
4. 等待自动应用。

**预期**：

- 提示「正在拉取匹配结果…」。
- 会**自动连续加载更多**直到没有下一页（多账户时也会循环 loadMore）。
- 若某一页后还有数据，应出现 **「加载更多」** 按钮（不再限制为「仅单账户显示」）；点击后应再追加一页，且 `paging.after` 由后端正确返回。
- 最后提示「已勾选 N 个对象」，列表里每条带账户角标，勾选的是所有账户下匹配项。

### 4.4 多账户 +「名称 不包含」

1. 多账户，目标层级「广告」。
2. 监控范围条件：**名称** **不包含** 某关键词。
3. 等待自动应用。

**预期**：

- 会拉全量（或循环加载更多直到没有更多），再在前端过滤掉名称包含该关键词的项。
- 列表中是「所有账户里名称不包含该关键词」的广告，并自动勾选。

### 4.5 状态条件（等于 投放中/已暂停/投放中+已暂停）

1. 单账户或多账户均可。
2. 监控范围条件：字段 **状态**，操作符 **等于**，值选「所有投放中」或「所有已暂停」或「所有投放中和已暂停」。
3. 等待自动应用。

**预期**：

- 会拉取包含暂停的数据（needFetchAll 会设「包含暂停」），再按状态过滤。
- 勾选结果与所选状态一致。

---

## 五、自检清单（可打勾）

| 项 | 结果 |
|----|------|
| 后端：multi 不带 after 返回 200，且当有更多时返回 paging.after、has_more | ☐ |
| 后端：multi 带 after 返回下一页，且与上一页不重复 | ☐ |
| 前端：单账户 + 名称包含 → 能拉全量并出现「加载更多」 | ☐ |
| 前端：单账户 + 名称不包含 → 能拉全量并正确排除 | ☐ |
| 前端：多账户 + 名称包含 → 自动拉全量且出现「加载更多」 | ☐ |
| 前端：多账户 + 名称不包含 → 全量后正确排除 | ☐ |
| 前端：状态条件 → 勾选与选项一致 | ☐ |

---

## 六、常见问题

- **401 / 403**：token 过期或未带。重新登录，把新 token 填到 `Authorization: Bearer <token>`。
- **多账户没有「加载更多」**：确认后端已部署支持 after 的 multi 接口，且该次请求返回了 `paging.after`（数据要超过一页才有）。
- **「名称 不包含」没反应**：确认该行「值」已填写且非空；保存/失焦后等约 2 秒让防抖触发应用。

---

## 七、可选：用 PowerShell 快速测 after

先登录拿到 token，再执行（把 `$TOKEN` 和 `act_1,act_2` 换成实际值）：

```powershell
$TOKEN = "你的JWT"
$h = @{ Authorization = "Bearer $TOKEN" }
# 第一页
$r1 = Invoke-RestMethod -Uri "http://localhost:3001/api/structure/objects/multi?account_ids=act_1,act_2&type=ad&limit=5" -Headers $h
$r1.paging
$r1.items.Count
# 若有 after，请求第二页
if ($r1.paging.after) {
  $r2 = Invoke-RestMethod -Uri ("http://localhost:3001/api/structure/objects/multi?account_ids=act_1,act_2&type=ad&limit=5&after=" + [uri]::EscapeDataString($r1.paging.after)) -Headers $h
  $r2.items.Count
  $r2.paging.has_more
}
```

期望：第一页返回 5 条（或更少），若有 after 则第二页再返回若干条，且与第一页不重复。
