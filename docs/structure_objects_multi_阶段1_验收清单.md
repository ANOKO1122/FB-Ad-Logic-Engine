# GET /api/structure/objects/multi 阶段 1 验收清单

## 前置

- 服务已启动：`npm run dev:server`（端口默认 3001）
- 认证：使用 **Authorization: Bearer \<token\>** 或 Cookie `token=...`

本文用环境变量 `$TOKEN` 表示你的 JWT，PowerShell 可先执行：
```powershell
$TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsImlhdCI6MTc3MTkwMDQ5MywiZXhwIjoxNzcyNTA1MjkzfQ.8QRV4jbUyDbPMkeMI79zCJVcCeGa7Er8pm1B8Q2DHnE"
```

---

## 1. 缺参：不传 account_ids → 400

**期望**：HTTP 400，body 含「缺少 account_ids」类错误。

**PowerShell：**
```powershell
$h = @{ Authorization = "Bearer $TOKEN" }
try {
  $r = Invoke-WebRequest -Uri "http://localhost:3001/api/structure/objects/multi" -Headers $h -UseBasicParsing
  "HTTP: " + $r.StatusCode
} catch {
  "HTTP: " + $_.Exception.Response.StatusCode.value__
  $_.ErrorDetails.Message
}
```

**curl（Git Bash / WSL）：**
```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/structure/objects/multi"
# 期望输出 400
```

---

## 2. 缺参：type 非法 → 400

**期望**：HTTP 400，body 含「type 只允许 campaign | adset | ad」。

**PowerShell：**
```powershell
$h = @{ Authorization = "Bearer $TOKEN" }
try {
  $r = Invoke-WebRequest -Uri "http://localhost:3001/api/structure/objects/multi?account_ids=act_123&type=invalid" -Headers $h -UseBasicParsing
  "HTTP: " + $r.StatusCode
} catch {
  "HTTP: " + $_.Exception.Response.StatusCode.value__
  $_.ErrorDetails.Message
}
```

**curl：**
```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/structure/objects/multi?account_ids=act_123&type=invalid"
# 期望 400
```

---

## 3. 有权限的多账户 → 200

**期望**：HTTP 200，`items` 中每条有 `account_id`，且仅包含请求中有权限的账户；`meta.accounts`、`meta.allowed_accounts` 为请求的账户数（如 2）。

把下面的 `act_账户1,act_账户2` 换成你**有权限**的两个广告账户 ID（可从单账户接口或 account_mappings 获取）。

**PowerShell：**
```powershell
$h = @{ Authorization = "Bearer $TOKEN" }
$uri = "http://localhost:3001/api/structure/objects/multi?account_ids=act_1905531400268801,act_1501999950830277&type=ad&limit=50"
$r = Invoke-WebRequest -Uri $uri -Headers $h -UseBasicParsing
$j = $r.Content | ConvertFrom-Json
"HTTP: " + $r.StatusCode
"meta: " + ($j.meta | ConvertTo-Json -Compress)
"items 条数: " + $j.items.Count
# 可选：检查每条都有 account_id
$j.items | ForEach-Object { $_.account_id } | Sort-Object -Unique
```

**验收点**：`meta.requested_accounts` = `meta.allowed_accounts` = 2，`items` 里 `account_id` 仅为此二账户。

---

## 4. 含无权限账户（1 个有权限 + 1 个无权限）→ 200，仅返回有权限账户

**说明**：若当前用户是 **admin**，则所有 account_id 均会被放行，此场景会变成「2 个都允许」；要用**非 admin** 账号才能看到 `allowed_accounts < requested_accounts`。

**期望**：HTTP 200，`meta.requested_accounts=2`，`meta.allowed_accounts=1`，`items` 仅来自有权限的那一个账户。

**PowerShell（用非 admin 的 token 替换 $TOKEN）：**
```powershell
$h = @{ Authorization = "Bearer $TOKEN" }
# 第一个为有权限账户，第二个为无权限（或不存在）账户
$uri = "http://localhost:3001/api/structure/objects/multi?account_ids=act_有权限的id,act_无权限的id&type=ad&limit=50"
$r = Invoke-WebRequest -Uri $uri -Headers $h -UseBasicParsing
$j = $r.Content | ConvertFrom-Json
"HTTP: " + $r.StatusCode
"meta: " + ($j.meta | ConvertTo-Json -Compress)
```

---

## 5. 全部无权限 → 403

**说明**：仅当**非 admin** 且传入的 account_ids 在 `account_mappings` 中均不属于该用户时，才会 403。**Admin 用户**会放行所有 id，不会出现 403。

**期望**：HTTP 403，body 含 `code: 'ACCOUNT_FORBIDDEN'`（或等价错误码）。

**PowerShell（用非 admin 的 token）：**
```powershell
$h = @{ Authorization = "Bearer $TOKEN" }
try {
  $r = Invoke-WebRequest -Uri "http://localhost:3001/api/structure/objects/multi?account_ids=act_999999999999999&type=ad&limit=50" -Headers $h -UseBasicParsing
  "HTTP: " + $r.StatusCode
} catch {
  "HTTP: " + $_.Exception.Response.StatusCode.value__
  $_.ErrorDetails.Message
}
```

---

## 验收结果汇总（可按条打勾）

| 项 | 期望 | 结果（打勾/备注） |
|----|------|-------------------|
| 不传 account_ids | 400 | ☑ 已通过 |
| type=invalid | 400 | ☑ 已通过 |
| 有权限多账户 | 200，items 含 account_id，meta.accounts=2 | ☑ 已通过 |
| 1 有权限 + 1 无权限（非 admin） | 200，allowed_accounts=1 | ☑ 已通过 |
| 全部无权限（非 admin） | 403，ACCOUNT_FORBIDDEN | ☑ 已通过 |

---

## 验证总结（手动 Thunder Client 验收）

**验收日期**：2026-02-24  

**结论**：GET `/api/structure/objects/multi` 阶段 1 验收全部通过。

- **参数校验**：缺 `account_ids`、非法 `type` 均正确返回 400。
- **权限与多账户**：有权限多账户返回 200，items 带 `account_id`，meta 中 accounts/requested_accounts/allowed_accounts 正确；含无权限账户时仅返回有权限账户数据（allowed_accounts &lt; requested_accounts）；全部无权限时返回 403、code `ACCOUNT_FORBIDDEN`。
- **实现**：`hasAccountAccess` + 多账户合并、去重、截断及 meta 字段均符合设计。

---

## 使用 Cookie 的方式（浏览器 / Postman）

若用 Cookie 而不是 Bearer：

- 键：`token`
- 值：上述 JWT 字符串

Postman：Params 填 query；Headers 可不填 Authorization，在 Cookie 中填 `token=<你的 JWT>`。  
浏览器：登录后 F12 → Application → Cookies 查看 `token`，同一域名下请求会自动带上。
