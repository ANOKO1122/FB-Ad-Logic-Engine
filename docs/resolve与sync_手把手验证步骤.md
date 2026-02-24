# resolve 回显查库 与 sync 刷新 — 验证步骤

## 方式一：Vitest（推荐，无需手动操作）

```bash
npm test -- server/tests/structureResolveSync.test.js
```

**覆盖**：ids 为空、DB miss 返回 missing、structure_ads 存在返回 name、混合（存在+不存在）、选择器 meta.source。

---

## 方式二：Thunder Client 手把手验证

配合 `Thunder_Client_结构resolve与sync验证集合.json` 使用。

---

## 前置

1. **后端已启动**：`npm run dev:server` 或 `node server/server.js`（端口 3001）
2. **登录拿 token**：POST `http://localhost:3001/api/auth/login`，Body `{"username":"管理员","password":"你的密码"}`，复制响应里的 `token`
3. **Thunder Client 环境**：建 Environment，添加变量 `token` = 复制的 token

---

## 导入集合

1. Thunder Client → Collections → 三个点 → Import
2. 选择 `docs/Thunder_Client_结构resolve与sync验证集合.json`
3. 选中对应 Environment（含 token）

---

## 验证步骤

> **重要**：验证 1、2、3 都是 **GET** `http://localhost:3001/api/structure/resolve`，**仅 ids 参数不同**。不要和 sync（POST）搞混，否则会 404。

---

### 验证 1：resolve 存在 ID → 从 structure_ads 返回 name

**请求**（可直接复制到 Thunder Client URL 框）：
```
GET http://localhost:3001/api/structure/resolve?ids=120234595940490501
```
> 把 `120234595940490501` 换成你选择器返回的任意真实 ad_id。

**Headers**：`Authorization: Bearer 你的token`

**预期 Status**：200

**预期 Response Body**（可直接对比）：
```json
{
  "items": [
    {
      "id": "120234595940490501",
      "name": "某广告名称",
      "effective_status": "ACTIVE",
      "status": "ACTIVE",
      "configured_status": "ACTIVE"
    }
  ]
}
```
> `items[0]` 必须有 `id`、`name`，**不能**有 `missing` 字段。

---

### 验证 2：resolve DB miss → 返回 `{ id, missing: true }`

**请求**（可直接复制）：
```
GET http://localhost:3001/api/structure/resolve?ids=99999999999999,88888888888888
```

**Headers**：`Authorization: Bearer 你的token`

**预期 Status**：200

**预期 Response Body**（可直接对比）：
```json
{
  "items": [
    { "id": "99999999999999", "missing": true },
    { "id": "88888888888888", "missing": true }
  ]
}
```
> 每条必须有 `missing: true`，**不能**有 `name`。若你看到 404，检查 URL 是否误写成 sync 或端口错误。

---

### 验证 3：resolve 混合（存在 + 不存在）

**请求**（把 `你的真实ad_id` 换成验证 1 用的 ad_id）：
```
GET http://localhost:3001/api/structure/resolve?ids=120234595940490501,99999999999999
```

**Headers**：`Authorization: Bearer 你的token`

**预期 Status**：200

**预期 Response Body**（可直接对比）：
```json
{
  "items": [
    {
      "id": "120234595940490501",
      "name": "某广告名称",
      "effective_status": "ACTIVE",
      "status": "ACTIVE",
      "configured_status": "ACTIVE"
    },
    { "id": "99999999999999", "missing": true }
  ]
}
```
> 第一条有 `name` 无 `missing`；第二条有 `missing: true` 无 `name`。顺序可能与 ids 参数一致或不同，用 `id` 对应即可。

---

### 验证 4：sync 强制同步 + 选择器查库

1. 打开 **4. sync-强制同步结构**
2. Body 里 `account_id` 改为你有权限的账户（如 `act_1155891202142879`）
3. Send
4. **预期**：200，`ok: true`，`synced_count` 为正数
5. 再执行 **5. 选择器-ads查库**（account_id 同上）
6. **预期**：200，`items` 为 structure_ads 数据，`meta.source` 为 `structure_ads`
7. **验收**：FB 新建/改名广告后，点一次 sync，选择器能搜到最新

---

### 验证 5：补齐 missing 流程（端到端）

1. 新建一条规则，选择一个广告 A，保存
2. 在 DB 中手动删除 structure_ads 里该广告的行（模拟 DB miss）：
   ```sql
   DELETE FROM structure_ads WHERE ad_id = '广告A的id' LIMIT 1;
   ```
3. 编辑该规则 → 预期「作用对象」里广告 A 显示为「id (未同步)」黄底
4. 点「刷新列表」（会先调用 sync，再 reload）
5. 再次编辑规则 → 预期广告 A 能解析出 name
6. **验收**：DB miss 时 UI 显示未同步；刷新列表后可补齐

---

## 常见错误

| 现象 | 原因 | 处理 |
|------|------|------|
| 404 `Cannot GET /api/sync/strhttp://localhost:3001/api/...` | URL 被拼错，把 resolve 地址塞进 sync 里了 | 在 URL 框**完整清空**后，从文档**直接复制**上面的请求 URL，不要手敲或拼贴 |
| 404 或连接失败 | 端口 3000（前端）和 3001（后端）弄混 | resolve / sync / 选择器 都用 **3001** |
| 401 Unauthorized | token 未配置或过期 | 检查 Environment 里 `token`，重新登录获取 |

---

## 验收清单

| 项 | 标准 | 通过 |
|----|------|------|
| resolve 存在 ID | 返回 name，不穿透 FB | ☐ |
| resolve DB miss | 返回 `{ id, missing: true }` | ☐ |
| resolve 混合 | 存在的有 name，不存在的有 missing | ☐ |
| sync 成功 | 200，ok:true，synced_count>0 | ☐ |
| 选择器查库 | meta.source=structure_ads，0 FB 列表调用 | ☐ |
| 补齐 missing | 刷新列表后 missing 能变正常 | ☐ |
