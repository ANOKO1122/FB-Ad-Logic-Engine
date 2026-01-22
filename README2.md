# FB Ad-Intelligence Server（本地决策中枢 / Local Decision Center）

本仓库是一个本地运行的 Facebook Marketing API 监控与规则系统：

- 前端：Vue 3 + Vite，用于可视化监控和规则管理
- 后端：Express.js + Node.js，用于和 Facebook Graph API 通讯（含代理适配），并提供规则执行接口

项目正在从「前端辅助工具」演进为「服务端广告决策中枢」，目标是：

- 替代人工盯盘，实现 7x24 小时实时监控
- 按预设 ROI / CPA / 消耗规则自动做出“关停 / 加预算”等决策
- 对所有决策过程做日志审计，并通过钉钉推送给对应负责人
- 通过 RBAC 实现“谁投的广告谁看、谁设的规则谁管”

---

## 1. 当前状态与目标状态

### 1.1 当前已经具备的能力（代码已实现）

- **实时监控**
  - 按广告维度拉取 insights 数据（`level=ad`）  
  - 指标包括：展示、点击、花费、CTR、CPC、CPM、转化等  
  - 前端可配置监控间隔，轮询拉取数据展示  
- **基础规则执行**
  - 前端通过 `/api/execute-rules` 将规则提交给后端执行
  - 后端具备调用 Facebook API 修改广告状态的能力（如暂停广告）
- **网络代理适配**
  - 后端使用 `server/index.js` + `server/socks5.js` 实现 HTTP / SOCKS5 自动探测与适配  
  - 兼容本地 v2rayN 混合端口代理（目前你的环境为 `127.0.0.1:10808`）

> ⚠️ 注意：当前版本中，规则引擎主要在前端（浏览器）运行，规则数据存储在浏览器 `localStorage` 中，浏览器关闭后自动执行不会持续运行。这也是后续要迁移到后端的核心原因。

### 1.2 目标状态（规划中的 Ad-Intelligence Server）

在后续迭代中，系统会逐步升级为：

- **服务端独立运行**
  - 规则引擎迁移到后端
  - 引入定时任务（`node-cron`）在服务端周期执行
- **Dry Run / Real 模式**
  - `SIMULATE（只读验证）`：只记录日志 + 发钉钉通知，不改动广告
  - `REAL（实战模式）`：真正调用 Facebook API 执行暂停/加预算等操作
- **结构化数据与 RBAC**
  - 使用 MySQL 持久化用户、账号、规则、执行日志
  - 按用户/投手隔离数据访问权限
- **可审计与可回溯**
  - 每一次“准备执行/已经执行”的操作都写入日志（包括触发时刻所有关键数据）

---

## 2. 目录结构（当前仓库）

```text
FB-Ad-Logic-Engine/
├── server/                 # Express 后端（Facebook API + 代理适配）
│   ├── index.js            # 主要路由和 Facebook API 客户端
│   └── socks5.js           # 原生 SOCKS5 + TLS 实现
├── src/                    # Vue 3 前端
│   ├── services/           # 前端 API / 监控服务 / 规则引擎（当前版）
│   ├── App.vue
│   └── main.js
├── vite.config.js          # Vite 开发代理：/api -> http://localhost:3001
├── .env                    # 本地环境变量（不会提交到 Git）
├── INSTALL.md              # 安装与调试说明
└── package.json
```

---

## 3. 技术栈

### 后端（当前 + 规划）

- Runtime: Node.js（建议 18+）
- Framework: Express.js
- HTTP Client: axios + 原生 http/https/tls
- 网络代理：
  - 环境变量：`HTTP_PROXY` / `HTTPS_PROXY`
  - 自研：HTTP CONNECT 隧道 + SOCKS5 协议适配（见 `server/socks5.js`）
- 计划引入：
  - `node-cron`：定时任务
  - `mysql2 + Sequelize`：MySQL 持久化
  - `Joi`：参数校验
  - 钉钉 Webhook：告警通知

### 前端

- Framework: Vue 3 + Vite
- HTTP: axios
- 状态 & UI（规划中）：Element Plus + Pinia（后续接入）

---

## 4. 环境配置（结合你的当前电脑环境）

### 4.1 Node 与代理

- Node.js：建议使用 18 或以上版本
- 本机代理：
  - 工具：v2rayN（Mixed Port）
  - 代理地址：`127.0.0.1`
  - 代理端口：`10808`

后端通过环境变量自动读取代理配置：

```env
# .env 中配置（推荐 HTTP 代理，后端会自动处理）
HTTP_PROXY=http://127.0.0.1:10808
HTTPS_PROXY=http://127.0.0.1:10808
```

如需使用 SOCKS5，也可以：

```env
HTTPS_PROXY=socks5://127.0.0.1:10808
```

### 4.2 Facebook 访问令牌

当前状态：

- 你现在手里的是短期 Token，并且已经过期
- 后续你会提供长期 Token（60 天）用于真实调试

`.env` 示例：

```env
PORT=3001

FACEBOOK_ACCESS_TOKEN=    # 目前可以先留空，等拿到新 Token 再填
```

### 4.3 未来的 MySQL 配置（设计中的，不是当前必需）

当进入 Phase 3 及以后时，准备接入 MySQL，并按照你现在规划的密码：

```env
# Database（未来接入用）
DB_HOST=localhost
DB_USER=root
DB_PASS=123456
DB_NAME=fb_ad_brain
DB_DIALECT=mysql
```

> 当前代码还没有使用 MySQL，这部分是为后续演进预留，不会影响当前启动。

---

## 5. 快速启动

### 5.1 安装依赖

```bash
npm install
```

### 5.2 启动（推荐方式）

同时启动前端和后端：

```bash
npm run dev:all
```

启动成功后：

- 前端地址：http://localhost:3000
- 后端 API：http://localhost:3001/api

你也可以分别启动：

```bash
# 终端 1：启动后端
npm run dev:server

# 终端 2：启动前端
npm run dev
```

---

## 6. 已有后端 API（当前实现）

所有接口都在 `/api` 路径下，由 `server/index.js` 负责处理。

- `GET /api/health`
  - 健康检查

- `GET /api/accounts`
  - 获取当前 Token 下的广告账户列表

- `GET /api/ads?account_id=act_xxx`
  - 获取指定广告账户的广告列表

- `GET /api/insights?account_id=act_xxx&...`
  - 获取广告洞察数据  
  - 默认 `date_preset=today`  
  - 支持传入自定义时间范围（since/until）或 preset

- `POST /api/execute-rules`
  - 执行一批规则（前端构造规则数组发给后端）
  - 当前版本可能触发真实 API 操作（例如暂停广告），后续会加上 `DRY_RUN` 保护

---

## 7. 现有规则引擎的局限

前端目录 `src/services/ruleEngine.js` 中：

- 规则保存在浏览器 `localStorage`
- 自动执行依赖浏览器保持打开状态
- 多用户、多账号的隔离还未实现

这些问题会在后续阶段通过「后端规则引擎 + MySQL + RBAC」统一解决。

---

## 8. 未来演进路线（结合你的方案）

下面这部分是**规划**，不是当前已经完成的功能，用来给你和后续接手的人看清楚路线图。

### Phase 1：后端逻辑化与只读验证（PoC）

**目标：**  
后端能够独立、稳定地执行规则判断，但不对真实广告做任何修改，纯“读 + 打印”。

**关键内容：**

- 将规则引擎从前端迁移到后端（从 `localStorage` 迁移到服务端内存或 JSON）
- 引入 `node-cron`，每 X 分钟在后端执行一次规则评估
- 增加全局开关：`DRY_RUN = true`
  - 规则触发时：
    - 不调用 Facebook UPDATE 接口
    - 只在日志中输出类似：
      > [模拟] 广告 {ad_name} 满足规则 {rule_name}，如果是实战将执行 {action}
- 建立静态的负责人映射表（先用 JSON 文件代替数据库）：
  - 格式示例：
    ```json
    {
      "act_123456": { "owner_id": 1, "owner_dingtalk_id": "xxxx" }
    }
    ```

**验收方式：**

- 持续运行 24 小时
- 检查日志中被标记为“应该关”的广告，和投手人工复盘是否一致

### Phase 2：模拟日志与钉钉告警

**目标：**  
让真实负责人参与进来，系统开始“说话”，但还不能碰真实广告。

**关键内容：**

- 建立简单的日志文件（按天切分），记录：
  - 触发时间
  - 广告 ID / 名称
  - 当前 ROI / 消耗等关键数据快照
  - 命中的规则名称
  - 建议的操作（暂停 / 加预算等）
- 基于映射表，使用钉钉机器人给对应负责人发送“模拟告警”：
  > 【模拟运行】@负责人，您的广告 [XX] 刚才触发了 [XX规则]：  
  > 当时数据为 [消耗 $25, 转化 0, CTR 0.5%]，  
  > 如果是实战，它已经被关掉。你认为这个判断合理吗？

- 通过投手反馈，调整规则中的阈值（例如增加“起跑线”金额）

### Phase 3：MySQL 引入与权限隔离

**目标：**  
真正落地数据库与 RBAC，让系统能够「多人协同、安全可控」。

**核心表设计（与方案保持一致，可略有扩展）：**

- `sys_users`
  - `id`、`username`、`password_hash`
  - `dingtalk_token`、`dingtalk_mobile`
  - `role`：`admin` / `staff`

- `account_mappings`
  - `id`
  - `fb_account_id`、`fb_account_name`
  - `owner_id` → `sys_users.id`
  - `is_active`：是否开启监控
  - `execution_mode`：`SIMULATE` / `REAL`

- `ad_rules`
  - `id`
  - `owner_id` → `sys_users.id`
  - `rule_name`
  - `conditions`（JSON，存储阈值逻辑）
  - `action_type`：`PAUSE` / `SCALE_UP`
  - `is_enabled`

- `op_logs`
  - `id`
  - `fb_account_id`、`fb_ad_id`、`ad_name`
  - `rule_id`（建议增加，用于回溯是哪个规则触发）
  - `trigger_data`（JSON，记录那一刻快照：spend/roi/conversions 等）
  - `action_performed`
  - `execution_mode`：`SIMULATE` / `REAL`
  - `status`：`SUCCESS` / `FAILED`
  - `error_message`（可选）
  - `created_at`

**用户隔离逻辑：**

- 前端只展示当前登录用户有权限的 account_id
- 后端在查询 FB 数据前，必须检查 account 是否属于 `current_user`
  - 若不属于，直接返回错误，避免绕过前端通过 Postman 越权访问

### Phase 4：小范围实测与全面上线

**目标：**  
在严格控制风险的前提下，由模拟模式逐步切换到真实自动化。

**关键点：**

- 在 `account_mappings` 中增加字段：
  - `is_active_automation`：是否允许该账号参与自动化实战
- 首周选小预算账户进行在线实测：
  - 观察实际止损效果与误杀率
- 增加“一键熔断”机制：
  - 例如：一个开关字段或管理接口，可以立即将所有账号的 `execution_mode` 切回 `SIMULATE` 或全部关闭任务
- 经一段期稳定运行后，再逐步把大预算账户纳入自动化

---

## 9. 常见问题

常见安装与 Token 配置问题，请参见仓库中的 [INSTALL.md](file:///d:/projects/FB-Ad-Logic-Engine/INSTALL.md)。

---

## 10. 许可证

MIT