# FB Ad-Intelligence Server (专业版 - 完整架构 + 效能工程)

这是一个基于 Vue 3 (Pinia) 和 Express.js (MySQL) 的 Facebook Marketing API 监控与自动化规则系统。

**定位**: 本地运行的智能监控台，未来将演进为**服务端决策中枢**，支持 7x24 小时无人值守运行、可审计的执行日志以及多账户负责人隔离。

**核心理念**: 不仅关注功能实现，更注重**代码的可维护性**与**自动化反馈循环**。通过分层测试体系和架构分离，确保项目长期稳定发展。

---

## 🚀 快速开始 (Quick Start)

### 1. 环境准备
- **Node.js**: 建议 v18+ (推荐使用 v20+ ESM 环境)
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
# ORM 支持（新功能使用）
npm install drizzle-orm
# 效能工程核心依赖（测试框架）
npm install --save-dev vitest supertest
# 开发工具
npm install --save-dev drizzle-kit concurrently
```

#### 第二步：配置环境变量 (.env)
复制 `.env.example` 为 `.env`，并填入以下配置：

```env
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
```

#### 第三步：配置 package.json

**1. 添加 ESM 模块化声明**

在 `package.json` 的顶层添加 `"type": "module"`，确保项目使用现代 ES 模块语法（`import/export`）：

```json
{
  "type": "module",
  ...
}
```

**2. 配置测试脚本**

在 `package.json` 的 `scripts` 中添加：

```json
{
  "scripts": {
    "dev": "vite",
    "dev:server": "node server/server.js",
    "dev:all": "concurrently \"npm run dev\" \"npm run dev:server\"",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

### 3. 启动项目

#### 开发模式
```bash
# 同时启动前端和后端
npm run dev:all

# 或分别启动
npm run dev          # 前端：http://localhost:3000
npm run dev:server   # 后端：http://localhost:3001/api/health
```

#### 运行自动化测试（推荐）
```bash
npm test
# 或监听模式
npm run test:watch
```

---

## ✨ 核心特性

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
- **数据流安全**: 后端强制在数据库查询层注入 `owner_id` 过滤，从根源防止越权

### 3. 自动规则引擎
- **自定义规则**: 支持创建自定义规则，满足条件自动执行操作
- **规则管理**: 规则列表、添加/编辑/删除、启用/禁用
- **立即执行**: 支持手动触发规则执行
- **定时任务**: node-cron 每 15 分钟自动巡检，支持浏览器关闭后的后台执行

| 场景 | 条件设置 (Logic) | 执行操作 (Action) |
| :--- | :--- | :--- |
| 止损熔断 | CTR < 0.8% 且 花费 > $20 | ⏸️ 暂停广告 |
| 扩量尝试 | 转化数 > 5 且 CPA < $10 | 💰 增加预算 20% |

### 4. 开发者体验与质量保证 (Developer Experience & QA)

作为效能工程实践项目，本项目不仅关注功能实现，更注重**代码的可维护性**与**自动化反馈循环**。

- **分层测试体系**: 放弃传统的 Postman 手动调试，引入 **Vitest + Supertest** 搭建集成测试流水线
- **架构分离**: 核心业务逻辑 (`app.js`) 与服务器启动逻辑 (`server.js`) 物理分离，支持无端口占用测试
- **自动化验证**: 每次修改核心规则逻辑后，通过 `npm test` 在 1 秒内完成全量功能回归
- **冒烟测试覆盖**: 规则的增删改查均经过自动化脚本验证，确保多用户数据隔离安全

---

## 🛠️ 技术栈与目录结构

**Frontend**: Vue 3 + Vite + Pinia (状态管理) + Axios  
**Backend**: Express.js + Node.js + MySQL (持久化) + node-cron (定时任务)  
**ORM**: Drizzle ORM (新功能) + 原生 SQL (旧功能，并存)  
**Testing**: Vitest + Supertest (集成测试)  
**Network**: 自研 HTTP/SOCKS5 自动代理适配

### 目录结构（专业版）

```
FB-Ad-Logic-Engine/
├── server/                      # Express 后端核心
│   ├── db/                      # 数据库配置
│   │   ├── connection.js        # 原生 SQL 连接池（旧功能使用）
│   │   ├── drizzle.js           # Drizzle ORM 连接（新功能使用）
│   │   ├── schema.js            # Drizzle Schema 定义（rules 表）
│   │   └── rules.example.js     # Drizzle 使用示例
│   ├── middleware/              # 用户鉴权中间件
│   │   └── authJwt.js
│   ├── routes/                  # 路由模块
│   │   ├── auth.js              # 认证路由（注册/登录/登出）
│   │   └── admin.js             # 管理员路由（审核/账户归属）
│   ├── services/                # 业务服务层
│   │   └── cronService.js       # cron 定时任务与规则执行
│   ├── utils/                   # 工具函数
│   │   └── accountFormatter.js  # ID 归一化等工具函数
│   ├── tests/                   # 集成测试（效能工程）
│   │   ├── rules.test.js        # 规则API测试
│   │   ├── auth.test.js         # 认证API测试
│   │   └── health.test.js       # 健康检查测试
│   ├── app.js                   # Express 应用配置（不含 listen）
│   ├── server.js                # 服务器启动入口
│   ├── index.js                 # Facebook 客户端核心（重构中）
│   └── socks5.js                # 代理隧道实现组件
├── src/                         # Vue 3 前端源码
│   ├── stores/                  # Pinia 用户状态与权限
│   ├── services/                # API 封装与 Axios 请求拦截
│   ├── views/                   # 监控大屏、规则设置、管理页
│   └── styles/                  # 全局样式
│       └── variables.css
├── .env                         # 敏感配置 (Token, Proxy, DB)
├── vitest.config.js             # Vitest 测试配置
└── README.md                    # 本文档（专业版）
```

### 架构分离说明

**为什么需要架构分离？**

传统的 Express 应用将 `app` 定义和 `app.listen()` 放在同一个文件中，这样在测试时：
- ❌ 无法避免真实端口占用
- ❌ 测试需要启动真实服务器，速度慢
- ❌ 难以进行隔离测试

**专业版解决方案：**

1. **`server/app.js`**: 仅包含 Express 应用配置（中间件、路由），导出 `app` 对象
   ```javascript
   // server/app.js
   import express from 'express'
   import cors from 'cors'
   // ... 其他中间件和路由配置
   
   const app = express()
   // ... 配置 app
   
   export default app  // 导出 app，不启动服务器
   ```

2. **`server/server.js`**: 引入 `app.js`，执行 `app.listen()` 并打印启动日志
   ```javascript
   // server/server.js
   import app from './app.js'
   
   const PORT = process.env.PORT || 3001
   app.listen(PORT, () => {
     console.log(`🚀 服务器运行在 http://localhost:${PORT}`)
   })
   ```

3. **测试文件**: 直接引入 `app.js`，使用 Supertest 测试，无需启动真实服务器
   ```javascript
   // server/tests/health.test.js
   import request from 'supertest'
   import app from '../app.js'
   
   describe('GET /api/health', () => {
     it('应该返回健康状态', async () => {
       const res = await request(app).get('/api/health')
       expect(res.status).toBe(200)
     })
   })
   ```

### 混合架构说明：原生 SQL + Drizzle ORM

**为什么采用混合架构？**

本项目采用"新瓶装新酒"策略，新旧技术并存：

1. **旧功能（登录、用户管理）**：继续使用原生 SQL (`pool.query()`)
   - 原因：功能稳定，无需重构
   - 位置：`server/db/connection.js`

2. **新功能（规则管理）**：使用 Drizzle ORM
   - 原因：类型安全、更好的开发体验
   - 位置：`server/db/drizzle.js`、`server/db/schema.js`

**两者如何并存？**

```javascript
// 旧代码：原生 SQL（继续使用）
import pool from './db/connection.js'
const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [id])

// 新代码：Drizzle ORM（新功能使用）
import { db } from './db/drizzle.js'
import { rules } from './db/schema.js'
import { eq } from 'drizzle-orm'
const userRules = await db.select().from(rules).where(eq(rules.userId, id))
```

**Drizzle ORM 的优势**：
- ✅ 类型安全：编译时检查 SQL 错误
- ✅ 自动补全：IDE 智能提示
- ✅ 性能优秀：接近原生 SQL 性能
- ✅ 学习成本低：API 直观易懂

**使用示例**（见 `server/db/rules.example.js`）：
- 创建规则：`db.insert(rules).values({ ... })`
- 查询规则：`db.select().from(rules).where(eq(rules.userId, id))`
- 更新规则：`db.update(rules).set({ ... }).where(eq(rules.id, id))`
- 删除规则：`db.delete(rules).where(eq(rules.id, id))`

---

## 🗺️ 演进路线与实现状态

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
- ✅ 规则隔离：规则按用户隔离存储（当前：`localStorage`，未来：MySQL）
- ✅ 账户归属管理：管理员可分配账户给指定负责人

### Phase 3: 规则重心下沉与 7x24h 自动化 🔄 (进行中)
- ✅ **架构分离**: 已完成 `server/app.js` 和 `server/server.js` 的架构分离（支持测试）
- ✅ **数据架构层（M2）**: 已完成数据表设计和 Data Ingestor 服务基础框架
  - ✅ 创建了 `ad_snapshots`、`daily_stats`、`automation_logs` 三个核心数据表
  - ✅ 实现了 `syncAccountTodayStats` 和 `syncAllAccountsTodayStats` 函数
  - ✅ 实现了 20-Batch 聚合批量拉取数据
  - ✅ 实现了数据字段提取逻辑（10 个核心字段）
  - ✅ 实现了获取广告状态的逻辑
  - ✅ 处理了 CPC 和 ROAS 的特殊逻辑（不入库，当天从 API 获取，历史数据通过计算）
  - ⚠️ **待完成**：API 频率自适应与自愈机制（1.3 节）
  - ⚠️ **待完成**：滑动窗口与冷热数据策略（1.4 节）
- 🔄 **持久化**: 规则从 localStorage 迁移至 MySQL `rules` 表
- 🔄 **定时任务**: node-cron 每 10 分钟自动同步 Today 数据，支持浏览器关闭后的后台执行
- 🔄 **并发保护**: 任务执行状态锁，防止上个周期未结束导致 API 频率超限
- ✅ **测试体系**: 已创建 Dry Run 模式测试脚本，验证核心逻辑

### Phase 4: 前端布局优化 🎨 (已完成)
- 🎨 响应式布局：优化表格、卡片、模态框的移动端适配
- 🎨 UI/UX 优化：统一的色彩体系、间距规范、交互反馈

### Phase 5: 审计、模拟与安全实战 📋 (规划中)
- 📋 Dry Run: 支持模拟执行模式，仅记录日志不实际调用 FB API
- 📋 日志审计: `execution_logs` 记录每一次触发规则的瞬时快照数据
- 📋 批量操作: 前端支持 Promise.all 并行批量暂停/开启广告，大幅提升性能
- 📋 **测试覆盖**: 关键业务逻辑测试覆盖率 > 80%

---

## 🔌 API 端点说明（基于 Cookie 登录）

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| POST | `/api/auth/register` | 注册（默认 pending） |
| POST | `/api/auth/login` | 登录（设置 HttpOnly Cookie） |
| POST | `/api/auth/logout` | 退出登录 |
| GET | `/api/me` | 获取当前用户 |
| GET | `/api/owners` | 获取负责人列表（注册下拉框） |
| GET | `/api/accounts` | 获取当前用户可见的广告账户（管理员=全部；员工=按 owner_id） |
| GET | `/api/insights` | 获取基础洞察数据（支持 `level=ad|adset|campaign` 参数） |
| GET | `/api/roi` | 获取 ROI 深度指标（购买/加购/结账/支付/独立点击），支持 level 参数，可能返回 202+report_run_id |
| GET | `/api/roi/result` | 轮询 ROI 异步作业结果（支持 level 参数） |
| GET | `/api/ads` | 获取广告列表（包含状态信息，仅 ad 层级需要） |
| GET | `/api/admin/users` | (管理员) 用户列表/筛选 |
| POST | `/api/admin/users/:id/approve` | (管理员) 审核通过 |
| POST | `/api/admin/users/:id/reject` | (管理员) 审核拒绝 |
| GET | `/api/admin/account-mappings` | (管理员) 账户归属列表 |
| POST | `/api/admin/account-mappings/assign` | (管理员) 分配账户归属 |

---

## 🧪 测试指南（效能工程核心）

### 测试框架配置

创建 `vitest.config.js`：

```javascript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/server/tests/**/*.test.js'],
    environment: 'node',
    globals: true,
    coverage: {
      include: ['server/**/*.js'],
      exclude: ['server/tests/**', 'server/server.js'],
      reportsDirectory: './coverage',
      provider: 'v8'
    },
    reporter: ['verbose'],
    testTimeout: 10000
  }
})
```

**Vitest 的优势**：
- ✅ 原生支持 ESM，无需实验性标志
- ✅ 与 Vite 生态无缝集成
- ✅ 更快的测试运行速度
- ✅ 更好的开发体验（热重载测试）

### 编写第一个测试

**示例：健康检查测试**

```javascript
// server/tests/health.test.js
import request from 'supertest'
import app from '../app.js'

describe('GET /api/health', () => {
  it('应该返回 200 状态码', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('status', 'ok')
  })
})
```

**示例：规则API测试**

```javascript
// server/tests/rules.test.js
import request from 'supertest'
import app from '../app.js'
import pool from '../db/connection.js'

describe('POST /api/rules', () => {
  let authToken
  let userId

  beforeAll(async () => {
    // 模拟登录，获取 JWT token
    // ... 测试前置准备
  })

  afterAll(async () => {
    // 清理测试数据
    await pool.query('DELETE FROM rules WHERE user_id = ?', [userId])
  })

  it('应该创建规则并返回 201', async () => {
    const ruleData = {
      rule_name: '测试规则',
      conditions: [{ metric: 'ctr', operator: 'lt', value: 1 }],
      actions: [{ type: 'pause_ad' }]
    }

    const res = await request(app)
      .post('/api/rules')
      .set('Cookie', `token=${authToken}`)
      .send(ruleData)

    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('rule_id')
    
    // 验证数据库记录
    const [rows] = await pool.query(
      'SELECT * FROM rules WHERE id = ? AND user_id = ?',
      [res.body.rule_id, userId]
    )
    expect(rows.length).toBe(1)
    expect(rows[0].rule_name).toBe('测试规则')
  })
})
```

### 运行测试

```bash
# 运行所有测试
npm test

# 监听模式（开发时推荐，支持热重载）
npm run test:watch

# 生成覆盖率报告
npm run test:coverage
```

💡 **专业提示**：建议在本地创建名为 `fb_ad_brain_test` 的独立数据库用于运行测试。在 `.env.test` 中配置该库，确保自动化测试不会污染开发环境的真实数据。

**示例配置 `.env.test`**：
```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=fb_ad
DB_PASS=123456
DB_NAME=fb_ad_brain_test
```

然后在测试文件中根据环境变量选择测试数据库，或在 `jest.config.js` 中配置测试环境变量。

---

## ⚠️ 常见问题与注意事项

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

### 开发者笔记
- **ID 精度**: 广告 ID 全程 String 处理，防止 JavaScript 溢出
- **异常捕获**: 全局拦截 FB API 报错，通过前端 Notify 组件实现错误透明化
- **环境变量**: `dotenv.config()` 必须在 `server/index.js` 最顶部执行
- **CORS 配置**: 必须明确允许自定义请求头 `x-user-id`（如果使用）

---

## 📋 实施指南：架构分离与测试体系搭建

### 第一步：架构分离（30分钟）

**目标**: 将 `server/index.js` 拆分为 `app.js` 和 `server.js`，支持无端口占用测试。

**步骤**:

1. **创建 `server/app.js`**
   - 从 `server/index.js` 提取 Express 应用配置
   - 包含所有中间件、路由定义
   - 导出 `app` 对象（不包含 `app.listen()`）

2. **创建 `server/server.js`**
   - 引入 `app.js`
   - 执行 `app.listen()` 并打印启动日志
   - 启动定时任务（如果有）

3. **更新启动脚本**
   - 修改 `package.json` 中的 `dev:server` 脚本指向 `server/server.js`
   - 确保开发环境正常启动

### 第二步：测试框架搭建（30分钟）

**目标**: 配置 Jest + Supertest，编写第一个测试用例。

**步骤**:

1. **安装依赖**
   ```bash
   npm install --save-dev jest supertest
   ```

2. **创建 `jest.config.js`**
   - 配置测试环境为 Node.js
   - 设置测试文件匹配规则
   - 配置覆盖率收集

3. **创建 `server/tests/` 目录**
   - 编写第一个测试文件 `health.test.js`
   - 验证测试可以正常运行

### 第三步：编写关键业务测试（按需）

**优先级**:

1. **认证相关测试** (`auth.test.js`)
   - 注册、登录、登出
   - JWT token 验证
   - 权限检查

2. **规则API测试** (`rules.test.js`)
   - 创建规则
   - 更新规则
   - 删除规则
   - 用户隔离验证

3. **数据隔离测试** (`accounts.test.js`)
   - 普通用户只能看到自己的账户
   - 管理员可以看到所有账户

---

## 🎯 下一步行动

### 短期目标（本周）
- [ ] 完成架构分离（`app.js` + `server.js`）
- [ ] 配置 Jest 测试环境
- [ ] 编写健康检查测试（验证架构分离成功）

### 中期目标（本月）
- [ ] 规则持久化到 MySQL
- [ ] 编写规则API完整测试套件
- [ ] 实现定时任务（node-cron）
- [ ] 测试覆盖率达到 60%

### 长期目标（本季度）
- [ ] 实现 Dry Run 模式
- [ ] 完善执行日志系统
- [ ] 测试覆盖率达到 80%
- [ ] 性能优化（批量操作、并发控制）

---

## 📚 参考资源

- **Jest 官方文档**: https://jestjs.io/
- **Supertest 文档**: https://github.com/visionmedia/supertest
- **Facebook Marketing API**: https://developers.facebook.com/docs/marketing-apis
- **Express.js 最佳实践**: https://expressjs.com/en/advanced/best-practice-performance.html

---

## 📖 相关文档

- **`数据字段说明.md`** - 详细说明了所有数据字段的处理逻辑、数据来源、计算方式
- **`DEV_PLAN.md`** - 开发计划文档（执行路线图）
- **`TASKS.md`** - 任务清单（每日执行入口）
- **`项目开发过程/`** - 项目开发过程记录

---

## 许可证

MIT

---

**文档版本**: v2.1 (专业版 - 完整架构 + 效能工程 + 数据架构层实现)  
**创建日期**: 2026-01-09  
**最后更新**: 2026-01-15

