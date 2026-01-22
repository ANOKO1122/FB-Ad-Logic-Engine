# FB Ad-Intelligence Server (本地决策中枢)

这是一个基于 Vue 3 和 Express.js 的 Facebook Marketing API 监控与自动化规则系统。

目前，它是一个**本地运行的智能监控台**，能够实时拉取广告数据并执行基于规则的判断（如：CTR 低于阈值自动暂停）。未来，它将演进为**服务端决策中枢**，支持 7x24 小时无人值守运行、钉钉告警审计以及多账户 RBAC 权限管理。

---

## 🚀 快速开始 (Quick Start)

### 1. 环境准备
- **Node.js**: 建议 v18+
- **本地代理**: 必须开启（用于访问 Facebook API）
  - 推荐工具: v2rayN / Clash
  - 监听端口: **10808** (HTTP/SOCKS5)

### 2. 安装与配置

#### 第一步：安装依赖
```bash
npm install
```

#### 第二步：配置环境变量
复制 `.env.example` 为 `.env`，并填入以下配置：

```env
PORT=3001

# --- Facebook 配置 ---
# 目前开发阶段使用短期 Token 且已过期
# 请暂时留空，等待后续提供长期 Token (60天)
FACEBOOK_ACCESS_TOKEN=

# --- 网络代理配置 (必需) ---
# 后端会自动识别并建立隧道
HTTP_PROXY=http://127.0.0.1:10808
HTTPS_PROXY=http://127.0.0.1:10808

# --- 数据库配置 (Phase 4 规划中) ---
# 当前版本尚未连接数据库，此处为预留配置
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASS=123456
DB_NAME=fb_ad_brain
```

### 3. 启动项目
推荐同时启动前端和后端：
```bash
npm run dev:all
```
启动成功后访问：
- 前端控制台：[http://localhost:3000](http://localhost:3000)
- 后端 API：[http://localhost:3001/api/health](http://localhost:3001/api/health)

---

## ✨ 功能特性

### 1. 实时监控体系
- **全维度数据**: 监控账户内所有广告的展示、点击、花费、CTR、CPC、CPM、转化等。
- **智能网络适配**: 后端 (`server/socks5.js`) 自动探测并适配本地代理 (127.0.0.1:10808)，解决国内开发连接 FB API 的痛点。

### 2. 自动规则引擎 (当前版本)
支持创建自定义规则，满足条件自动执行操作。

#### 💡 规则配置示例
| 场景 | 条件设置 (Logic) | 执行操作 (Action) |
| :--- | :--- | :--- |
| **止损熔断** | `CTR < 0.8%` 且 `花费 > $20` | ⏸️ 暂停广告 |
| **扩量尝试** | `转化数 > 5` 且 `CPA < $10` | 💰 增加预算 20% |
| **高耗低效** | `花费 > $100` 且 `转化数 == 0` | ⏸️ 暂停广告 |

---

## 🛠️ 技术栈与目录结构

- **Frontend**: Vue 3 + Vite + Axios (可视化监控、规则配置)
- **Backend**: Express.js + Node.js (API 代理、规则执行接口)
- **Network**: 自研 HTTP/SOCKS5 自动代理适配

```text
FB-Ad-Logic-Engine/
├── server/                 # Express 后端核心
│   ├── index.js            # API 路由与 FB 客户端
│   └── socks5.js           # 代理隧道实现 (核心组件)
├── src/                    # Vue 3 前端源码
│   ├── services/           # 业务逻辑 (规则引擎目前在此)
│   └── views/              # 监控大屏与设置页
├── .env                    # 敏感配置 (Token, Proxy, DB)
└── README.md               # 项目文档
```

---

## 🗺️ 演进路线 (Roadmap)

我们正在从“前端辅助工具”向“服务端决策中枢”演进。

### Phase 1: 当前状态 (Current)
- ✅ 前端可视化监控
- ✅ 后端代理连通 FB Graph API
- ✅ 基础规则引擎 (运行在浏览器 `localStorage` 中)
- ✅ 手动/半自动执行规则

### Phase 2: 后端逻辑化与模拟 (In Progress)
- 🔄 将规则引擎迁移至 Node.js 后端
- 🔄 引入 `node-cron` 定时任务
- 🔄 **Dry Run (模拟模式)**: 只产生日志，不实际修改广告，用于验证策略准确性。

### Phase 3: 审计与通知
- 📝 **日志审计**: 记录每一次决策的快照数据 (Snapshot)。
- 🔔 **钉钉告警**: 触发规则时推送消息给对应投手：“广告A触发止损规则，建议暂停”。

### Phase 4: 生产级架构 (Future)
- 🗄️ **MySQL 持久化**: 存储账号映射、规则集、执行日志 (预设密码 `123456`)。
- 🛡️ **RBAC 权限**: “谁投的广告谁看，谁设的规则谁管”。
- 🚀 **全自动实战**: 逐步开放大预算账户的自动止损/扩量权限。

---

## 🔌 API 端点说明

后端服务运行在 `http://localhost:3001/api`：

| 方法 | 路径 | 参数 | 说明 |
| :--- | :--- | :--- | :--- |
| GET | `/health` | - | 健康检查，返回后端状态 |
| GET | `/accounts` | - | 获取当前 Token 下的所有广告账户 |
| GET | `/ads` | `account_id` | 获取指定账户的广告列表及实时数据 |
| GET | `/insights` | `account_id`, `since`, `until` | 获取详细洞察数据 (支持自定义时间范围) |
| POST | `/execute-rules` | Body: `{ rules: [] }` | 执行规则集 (目前由前端调用) |

---

## ⚠️ 常见问题与注意事项

1. **代理报错 `ECONNREFUSED`**
   - 请检查 v2rayN/Clash 是否开启，并确认端口是否为 **10808**。
   - 如果使用其他端口，请修改 `.env` 中的 `HTTP_PROXY`。

2. **规则不生效**
   - 当前版本规则存储在浏览器缓存 (`localStorage`) 中。
   - 如果清除浏览器缓存或更换电脑，规则会丢失 (Phase 2 将修复此问题)。

3. **API 速率限制**
   - Facebook API 有严格的调用频率限制。
   - 建议监控刷新间隔设置不低于 **60 秒**。

---

## 许可证
MIT