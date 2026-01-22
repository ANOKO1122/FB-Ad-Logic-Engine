这是一个基于 Vue 3 (Pinia) 和 Express.js (MySQL) 的 Facebook Marketing API 监控与自动化规则系统。

目前，它是一个**本地运行的智能监控台**。未来，它将演进为**服务端决策中枢**，支持 7x24 小时无人值守运行、可审计的执行日志以及多用户隔离体系。

---

## 🛠️ 开发者体验与质量保证 (Developer Experience & QA)

作为效能工程实践项目，本项目不仅关注功能实现，更注重**代码的可维护性**与**自动化反馈循环**。

- **分层测试体系**: 放弃传统的 Postman 手动调试，引入 **Jest + Supertest** 搭建集成测试流水线。
- **架构分离**: 核心业务逻辑 (`app.js`) 与服务器启动逻辑 (`server.js`) 物理分离，支持无端口占用测试。
- **自动化验证**: 每次修改核心规则逻辑后，通过 `npm test` 在 1 秒内完成全量功能回归。

---

## 🚀 快速开始

### 1. 环境准备
- **Node.js**: v18+ (推荐使用 v20+ ESM 环境)
- **MySQL**: 8.0+ (数据库名: `fb_ad_brain`)
- **本地代理**: 端口 **10808** (HTTP/SOCKS5)

### 2. 安装与配置
```bash
npm install
# 安装效能工程核心依赖
npm install --save-dev jest supertest
3. 运行项目
code
Bash
# 开发模式
npm run dev:all

# 运行自动化集成测试 (推荐)
npm test
✨ 核心特性
1. 自动规则引擎 (Phase 3 & 5 演进中)
去中心化存储: 正在从 localStorage 迁移至 MySQL 以支持无人值守巡检。
原子化条件: 支持 CTR、花费、ROI、转化等多维度指标逻辑组合。
冒烟测试覆盖: 规则的增删改查均经过自动化脚本验证，确保多用户数据隔离安全。
2. 多用户隔离架构 (Phase 2 ✅)
安全认证: JWT + HttpOnly Cookie 方案。
权限模型: 管理员 (Admin) 全局管理，职员 (Staff) 仅可见归属账户。
数据流安全: 后端强制在数据库查询层注入 owner_id 过滤，从根源防止越权。
3. 实时监控体系 (Phase 1 ✅)
数据对齐: 精确匹配 fb_pixel_purchase，解决成效数据翻倍痛点。
异步性能: 基础指标即时渲染，ROI 深度指标采用报告轮询机制。
🗺️ 演进路线 (Roadmap)

Phase 1: 稳定性与数据口径对齐

Phase 2: 多用户隔离架构与 UI 重构
[sarcastic] Phase 3: 规则重心下沉 (当前阶段) - 迁移至 MySQL 并引入测试护航

Phase 5: 7x24h 定时任务与审计日志
⚠️ 开发者笔记 (Key Fixes)
ID 精度: 广告 ID 全程 String 处理，防止 JavaScript 溢出。
异常捕获: 全局拦截 FB API 报错，通过前端 Notify 组件实现错误透明化。
code
Code
---

### 第二部分：给 Cursor 的“效能指令”

打开 Cursor，在 **Composer (Ctrl+I)** 或者 **Chat (Ctrl+L)** 中粘贴以下指令：

> **指令：启动 Phase 3 规则持久化与自动化测试重构**
>
> 1. **环境初始化：**
>    - 运行 `npm install --save-dev jest supertest`。
>    - 在 `package.json` 的 `scripts` 中添加 `"test": "jest --detectOpenHandles"`。
>
> 2. **后端架构重构（关键）：**
>    - 检查 `server/index.js`。目前它可能同时包含 `app` 定义和 `app.listen`。
>    - 请将其拆分为两个文件：
>      - `server/app.js`: 仅包含中间件、路由和 `module.exports = app`。
>      - `server/server.js`: 引入 `app.js`，执行 `app.listen` 并打印启动日志。
>    - 这样做的目的是让 Supertest 可以在不启动真实端口的情况下运行测试。
>
> 3. **数据库设计：**
>    - 请为我设计一张 `rules` 表，字段包括：`id` (int, pk), `user_id` (int), `rule_name` (varchar), `conditions` (json), `actions` (json), `enabled` (boolean), `created_at`。
>    - 给出创建此表的 SQL 语句。
>
> 4. **编写第一个集成测试：**
>    - 创建目录 `server/tests/`。
>    - 创建文件 `server/tests/rules.test.js`。
>    - 编写一个测试用例：模拟一个带有有效 JWT Cookie 的用户，发送 `POST /api/rules` 请求创建一条新规则，并预期返回 201 状态码，且数据库中该记录的 `user_id` 与当前用户一致。
>
> **请先完成上述架构调整和测试环境搭建，完成后告诉我，我们再一起写对应的 API 代码。**

---

