# FB Ad-Intelligence Server (本地决策中枢 - 完整架构版)

这是一个基于 Vue 3 (Pinia) 和 Express.js (MySQL) 的 Facebook Marketing API 监控与自动化规则系统。

目前，它是一个**本地运行的智能监控台**。未来，它将演进为**服务端决策中枢**，支持 7x24 小时无人值守运行、可审计的执行日志以及多账户负责人隔离。

---

## 🚀 快速开始 (Quick Start)

### 1. 环境准备
- **Node.js**: 建议 v18+
- **MySQL**: 8.0+ (需手动创建数据库 `fb_ad_brain`)
- **本地代理**: 必须开启（用于访问 Facebook API）
  - 推荐工具: v2rayN / Clash
  - 监听端口: **10808** (HTTP/SOCKS5)

### 2. 安装与配置

#### 第一步：安装核心依赖
```bash
npm install
# V1.1 架构新增核心依赖
npm install pinia mysql2 node-cron
第二步：配置环境变量 (.env)
复制 .env.example 为 .env，并填入以下配置：
code
Env
PORT=3001

# --- Facebook 配置 ---
FACEBOOK_ACCESS_TOKEN=你的长期Token(60天)
FB_API_VERSION=v24.0

# --- 网络代理配置 (必需) ---
# 后端会自动识别并建立隧道
HTTP_PROXY=http://127.0.0.1:10808
HTTPS_PROXY=http://127.0.0.1:10808

# --- 数据库配置 (V1.1 生产级架构) ---
DB_HOST=localhost
DB_PORT=3306
DB_USER=fb_ad
DB_PASS=123456
DB_NAME=fb_ad_brain
3. 启动项目
推荐同时启动前端和后端：
code
Bash
npm run dev:all
前端控制台：http://localhost:3000
后端 API：http://localhost:3001/api/health
✨ 功能特性

### 1. 实时监控体系
- **全维度数据**: 监控账户内所有广告的展示、点击、花费、CTR、CPC、CPM、转化等
- **层级切换**: 支持广告/广告组/广告系列三种层级视图切换
- **状态显示**: 广告状态中文显示（开启/关闭/已归档/已删除）
- **数据对齐**: 与 Facebook Ads Manager 数据口径对齐（成效、ROAS、uCPC、CPA 等）
- **智能网络适配**: 后端自动探测并适配本地代理 (127.0.0.1:10808)，解决跨境 API 连接痛点
- **异步加载**: 基础数据立即展示，ROI 深度指标异步加载（购买/加购/结账/支付等）

### 2. 多用户隔离架构
- **用户认证**: JWT + HttpOnly Cookie（安全可靠）
- **角色权限**: 
  - `admin`: 可审核用户、分配账户归属、查看全部广告账户
  - `staff`: 仅可查看自己负责人(owner)名下的广告账户与数据
- **数据隔离**: "谁投的广告谁看"，后端自动过滤权限范围外的账户和数据
- **规则隔离**: "谁设的规则谁管"，规则按用户隔离存储

### 3. 自动规则引擎
- **自定义规则**: 支持创建自定义规则，满足条件自动执行操作
- **规则管理**: 规则列表、添加/编辑/删除、启用/禁用
- **立即执行**: 支持手动触发规则执行

| 场景 | 条件设置 (Logic) | 执行操作 (Action) |
| :--- | :--- | :--- |
| 止损熔断 | CTR < 0.8% 且 花费 > $20 | ⏸️ 暂停广告 |
| 扩量尝试 | 转化数 > 5 且 CPA < $10 | 💰 增加预算 20% |
🛠️ 技术栈与目录结构
Frontend: Vue 3 + Vite + Pinia (状态管理) + Axios
Backend: Express.js + Node.js + MySQL (持久化) + node-cron (定时任务)
Network: 自研 HTTP/SOCKS5 自动代理适配
code
Text
FB-Ad-Logic-Engine/
├── server/                 # Express 后端核心
│   ├── db/                 # MySQL 连接池配置 (New)
│   ├── middleware/         # 用户鉴权中间件 (New)
│   ├── utils/              # ID 归一化等工具函数 (New)
│   ├── services/           # cron 定时任务与规则执行 (New)
│   ├── index.js            # API 路由与 FB 客户端核心
│   └── socks5.js           # 代理隧道实现组件
├── src/                    # Vue 3 前端源码
│   ├── stores/             # Pinia 用户状态与权限 (New)
│   ├── services/           # API 封装与 Axios 请求拦截
│   └── views/              # 监控大屏、规则设置、管理页
├── .env                    # 敏感配置 (Token, Proxy, DB)
└── README.md               # 项目演进与技术手册
🗺️ 演进路线与实现状态

### Phase 1: 稳定性与透明化 ✅ (已完成)
- ✅ 前端可视化监控与代理连通
- ✅ 加载优化: 切换账户立即拉取数据，不再等待定时周期
- ✅ 错误透明: 捕获并前端显示 FB API 的 error.message 和 code
- ✅ 状态反馈: Loading 加载状态，处理"今日无数据"友好提示
- ✅ 数据对齐: 修复成效7倍问题，ROAS/uCPC/CPA 等字段与 Ads Manager 对齐
- ✅ 层级切换: 支持广告/广告组/广告系列三种层级视图
- ✅ 状态显示: 广告状态中文显示（开启/关闭/已归档/已删除）

### Phase 2: 多用户隔离架构 ✅ (已完成)
- ✅ 用户隔离: 实现"谁投的广告谁看，谁设的规则谁管"
- ✅ 认证：使用 **JWT + HttpOnly Cookie**（替代不安全的 `x-user-id`）
- ✅ 权限管理：
  - `admin`：可审核用户、分配账户归属、查看全部广告账户
  - `staff`：仅可查看自己负责人(owner)名下的广告账户与数据
- ✅ 数据隔离：后端根据 `users.owner_id` 与 `account_mappings.owner_id` 过滤 `/api/accounts`（以及后续相关数据请求）
- ✅ 规则隔离：规则按用户隔离存储（`localStorage` key: `facebook_auto_rules::user:{userId}`）
- ✅ 账户归属管理：管理员可分配账户给指定负责人

### Phase 3: 规则重心下沉与 7x24h 自动化 🔄 (进行中)
- 🔄 持久化: 规则从 localStorage 迁移至 MySQL rules 表
- 🔄 定时任务: node-cron 每 15 分钟自动巡检，支持浏览器关闭后的后台执行
- 🔄 并发保护: 任务执行状态锁，防止上个周期未结束导致 API 频率超限

### Phase 4: 前端布局优化 🎨 (已完成)
- 🎨 响应式布局：优化表格、卡片、模态框的移动端适配
- 🎨 UI/UX 优化：统一的色彩体系、间距规范、交互反馈

### Phase 5: 审计、模拟与安全实战 📋 (规划中)
- 📋 Dry Run: 支持模拟执行模式，仅记录日志不实际调用 FB API
- 📋 日志审计: execution_logs 记录每一次触发规则的瞬时快照数据
- 📋 批量操作: 前端支持 Promise.all 并行批量暂停/开启广告，大幅提升性能
🔌 API 端点说明（基于 Cookie 登录）
方法	路径	说明
POST	/api/auth/register	注册（默认 pending）
POST	/api/auth/login	登录（设置 HttpOnly Cookie）
POST	/api/auth/logout	退出登录
GET	/api/me	获取当前用户
GET	/api/owners	获取负责人列表（注册下拉框）
GET	/api/accounts	获取当前用户可见的广告账户（管理员=全部；员工=按 owner_id）
GET	/api/insights	获取基础洞察数据（轻量）
GET	/api/insights	获取基础洞察数据（支持 level=ad|adset|campaign 参数）
GET	/api/roi	获取 ROI 深度指标（购买/加购/结账/支付/独立点击），支持 level 参数，可能返回 202+report_run_id
GET	/api/roi/result	轮询 ROI 异步作业结果（支持 level 参数）
GET	/api/ads	获取广告列表（包含状态信息，仅 ad 层级需要）
GET	/api/admin/users	(管理员) 用户列表/筛选
POST	/api/admin/users/:id/approve	(管理员) 审核通过
POST	/api/admin/users/:id/reject	(管理员) 审核拒绝
GET	/api/admin/account-mappings	(管理员) 账户归属列表
POST	/api/admin/account-mappings/assign	(管理员) 分配账户归属
⚠️ 常见问题与注意事项

### 技术要点
- **ID 精度保护**: 广告 ID 与账户 ID 必须全程以 String 处理，严禁转为 Number 导致溢出
- **代理配置**: 代理报错 ECONNREFUSED 时，请检查 v2rayN/Clash 是否开启，并确认端口为 10808
- **速率限制**: Facebook API 频率受限，建议监控刷新间隔不低于 60 秒
- **数据对齐**: 所有接口默认开启 `use_account_attribution_setting=true`，确保与 Ads Manager 归因口径一致

### 已解决的关键问题

#### 1. 成效数据7倍问题 ✅
- **问题**: 前端显示的"成效(购买)"是 Facebook Ads Manager 的 7 倍
- **原因**: 后端提取购买数时使用了 `includes('purchase')`，导致多个包含 purchase 的 action_type 被累加
- **解决**: 改为精确匹配 `offsite_conversion.fb_pixel_purchase`，优先命中权威 action_type，不再累加所有变体

#### 2. 切换账户数据残留问题 ✅
- **问题**: 切换账户后，页面仍显示上一个账户的数据
- **原因**: 旧账户的监控 interval 和 ROI 轮询没有正确清理
- **解决**: 引入 `currentMonitoringAccountId` 追踪当前监控账户，切换时调用 `stopMonitoringForAccount` 清理旧账户的所有异步任务

#### 3. ROI 异步接口 500 错误 ✅
- **问题**: `/api/roi/result` 返回 500，导致前端一直轮询失败，数据永远加载不出来
- **原因**: 异步任务请求了 `cost_per_unique_link_click` 字段，但在 report-run 场景下该字段变成 "summary field 不存在"，直接 400
- **解决**: 异步任务不再请求该字段，改为降级字段集；`/{report_run_id}/insights` 拉取时自动降级，确保接口可用

#### 4. 数据对齐问题 ✅
- **问题**: uCPC、CPA、ROAS 等字段与 Ads Manager 不一致
- **解决**: 
  - ROI 接口优先返回 Facebook 官方的 `cost_per_action_type`、`cost_per_unique_*` 字段
  - 前端优先展示官方字段，缺失时才用 `spend/次数` 推导
  - ROAS 改为纯数字比值（如 2.53），而不是百分比（252.97%）

#### 5. Vue key 重复警告 ✅
- **问题**: 控制台出现 "Duplicate keys found" 警告
- **原因**: `getRowKey` 在不同层级可能返回相同的值，或 ID 为空导致多个空字符串
- **解决**: 在 key 前加上层级前缀（`ad_`、`adset_`、`campaign_`），确保唯一性
许可证
MIT