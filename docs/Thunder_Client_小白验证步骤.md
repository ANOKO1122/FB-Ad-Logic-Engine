# 用 Thunder Client 验证本次改动（小白步骤）

按顺序做下面几步即可。**前提**：后端已启动（例如 `node server/index.js` 或 npm run dev），端口是 3001（若你是 3000 或别的，把下面所有 `3001` 改成你的端口）。

---

## 第一步：打开 Thunder Client

1. 在 Cursor / VS Code 左侧边栏点 **雷电路标**（Thunder Client）。
2. 点 **New Request**（或「新建请求」），会出来一个空请求。

---

## 第二步：先登录，拿到 token

接口需要登录后的 token，所以先发一次登录请求。

1. **方法**：左上角下拉选 **POST**。
2. **地址**：在 URL 框里输入（把 `3001` 改成你的后端端口）：
   ```text
   http://localhost:3001/api/auth/login
   ```
3. **Body**：
   - 点 **Body** 选项卡 → 选 **JSON**。
   - 在文本框里写（把用户名、密码改成你在系统里能登录的）：
     ```json
     {
       "username": "你的用户名",
       "password": "你的密码"
     }
     ```
4. 点右上角蓝色 **Send** 发送。
5. **看结果**：
   - 右侧 **Status** 应为 **200**。
   - 点 **Response** 选项卡，在 JSON 里找到 **token** 这一项，**整段复制**（一串长字符，不要带引号外的空格）。  
     例如：`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`  
   - 若 Status 是 401，说明用户名或密码错了，请检查 Body 里的账号密码。

---

## 第三步：验证「多账户结构接口」的 meta（per_account_limit、has_more）

1. **再新建一个请求**（New Request），或另开一个 Tab。
2. **方法**：选 **GET**。
3. **地址**：
   ```text
   http://localhost:3001/api/structure/objects/multi
   ```
4. **带 token**（二选一）：
   - **方式 A**：点 **Headers** → 点 **Add Header**（或「添加」）→  
     - **Name**：`Authorization`  
     - **Value**：`Bearer 这里粘贴第二步复制的整段token`  
     （注意：`Bearer` 后面有一个空格，再跟 token，中间没有逗号。）
   - **方式 B**：点 **Auth** 选项卡 → Type 选 **Bearer Token** → 在 Token 框里**只粘贴 token**（不要写 Bearer）。
5. **Query 参数**：
   - 点 **Query** 选项卡，添加三行（若没有 Query 区域就点「Add Query」或旁边 + 号）：

   | Name         | Value |
   |--------------|-------|
   | account_ids  | act_你的账户1,act_你的账户2 |
   | type         | ad    |
   | limit        | 50    |

   **说明**：把 `act_你的账户1`、`act_你的账户2` 换成你在「规则管理」里能选的那两个广告账户 ID（可先在前端规则页选两个账户，从下拉或列表里抄下来）。若只写一个账户也可以，例如：`act_4252903478277839`。

6. 点 **Send** 发送。
7. **检查**：
   - **Status** 应为 **200**。
   - 点 **Response**，在返回的 JSON 里找到 **meta** 对象，确认里面有：
     - **per_account_limit**：有这一项，且是数字（例如 2 个账户、limit=50 时，这里是 25）。
     - **has_more**：有这一项，且是 true 或 false。  
   - 再确认 **paging** 里有 **has_more**，和 **meta.has_more** 一致。  

**到这里**：meta 的优化就验证完了。

---

## 第四步（可选）：验证「空数组账户不执行」

这一项是验证：当某条规则的 `target_by_account` 里某个账户是**空数组**时，该账户不会被加锁、不会执行一次「匹配 0」。

- **不推荐小白改数据库**：需要改某条规则的 `target_by_account`，把其中一个账户改成 `[]`，再触发「立即运行所有规则」或单条「运行此规则」，看后端日志里该账户是否不再出现。若你不熟数据库，可以**跳过**这一步。
- **若你愿意改**：在库里找到一条多账户规则，把其 `target_by_account` 的 JSON 里某一个 key 的 value 改成 `[]`，保存后在前端点「立即运行所有规则」或「运行此规则」，看后端控制台是否没有该账户的「获取锁成功」「匹配 0 个广告」日志。

---

## 常见问题

- **Status 401 / 403**：说明没带 token 或 token 过期。回到第二步重新登录，复制新的 token，再在第三步的 Headers 里把 `Bearer 旧token` 换成 `Bearer 新token`。
- **Status 400「缺少 account_ids 参数」**：在第三步里检查 **Query** 是否填了 `account_ids` 和 `type`。
- **URL 不对**：若你平时用 `http://192.168.0.67:3000` 访问前端，后端可能是同机 3001 或 3000，请把上面所有 `http://localhost:3001` 改成你实际的后端地址（例如 `http://192.168.0.67:3001`）。

---

## 小结

- **必做**：第二步登录拿 token → 第三步 GET objects/multi，带 token 和 Query → 看 Response 里 **meta.per_account_limit** 和 **meta.has_more** 存在且合理。
- **选做**：改一条规则的 target_by_account 成空数组后，触发执行，看该账户是否不再出现在日志里。
