# Facebook Marketing API 实时监控与自动规则系统

这是一个基于Vue 3和Express.js的Facebook Marketing API监控系统，可以实时监控广告数据并执行自动规则。完全本地部署，无需Supabase。

## 功能特性

1. **实时监控**
   - 监控账户内所有广告的数据（展示、点击、花费、CTR、CPC、转化等）
   - 可自定义更新间隔
   - 实时数据展示

2. **自动规则引擎**
   - 基于条件触发自动操作
   - 支持多种条件：CTR、CPC、花费、转化数等
   - 支持多种操作：暂停/启用广告、增加/减少预算
   - 规则可启用/禁用
   - 支持手动执行和自动执行

## 技术栈

- **前端**: Vue 3 + Vite
- **后端**: Express.js (Node.js)
- **API**: Facebook Marketing API v24.0

## 安装步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填入你的配置：

```env
FACEBOOK_ACCESS_TOKEN=your_facebook_access_token_here
PORT=3001
```

### 3. 获取Facebook访问令牌

**详细步骤请查看：`获取Facebook访问令牌指南.md`**

快速步骤：
1. 访问 [Facebook开发者控制台](https://developers.facebook.com/) 创建应用
2. 添加 Marketing API 产品
3. 在 [Graph API Explorer](https://developers.facebook.com/tools/explorer/) 中生成访问令牌
4. 转换为长期令牌（60天有效期）
5. 将令牌配置到 `.env` 文件中的 `FACEBOOK_ACCESS_TOKEN`

> 💡 **提示**：查看 `获取Facebook访问令牌指南.md` 获取详细的图文说明和常见问题解答

#### 获取访问令牌详细步骤：

**方法一：使用 Graph API Explorer**
1. 访问 [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. 选择你的应用
3. 添加以下权限：
   - `ads_read`
   - `ads_management`
   - `business_management`
4. 生成访问令牌

**方法二：转换为长期令牌**
短期令牌通常只有1-2小时，需要转换为长期令牌（60天）：
```bash
curl -X GET "https://graph.facebook.com/v24.0/oauth/access_token?grant_type=fb_exchange_token&client_id={app-id}&client_secret={app-secret}&fb_exchange_token={short-lived-token}"
```

### 4. 运行项目

**方式一：同时启动前端和后端（推荐）**
```bash
npm run dev:all
```

**方式二：分别启动**
```bash
# 终端1：启动后端服务器
npm run dev:server

# 终端2：启动前端开发服务器
npm run dev
```

启动后：
- 前端地址：http://localhost:3000
- 后端API：http://localhost:3001/api

## 使用说明

### 实时监控

1. 选择要监控的广告账户
2. 启用监控开关
3. 设置更新间隔（秒）
4. 系统将自动获取并显示广告数据

### 创建自动规则

1. 点击"添加规则"
2. 设置规则名称
3. 添加条件（例如：CTR < 1%）
4. 添加操作（例如：暂停广告）
5. 保存规则

### 规则示例

**示例1：低CTR自动暂停**
- 条件：CTR < 1%
- 操作：暂停广告

**示例2：高花费自动减少预算**
- 条件：花费 > 100
- 操作：减少预算 20%

**示例3：低转化自动暂停**
- 条件：转化数 < 5 且 花费 > 50
- 操作：暂停广告

## API端点

所有API端点都在 `/api` 路径下：

### GET `/api/accounts`
获取广告账户列表

### GET `/api/ads?account_id={id}`
获取指定账户的广告列表

### GET `/api/insights?account_id={id}&since={date}&until={date}`
获取广告洞察数据

### POST `/api/execute-rules`
执行自动规则

### GET `/api/health`
健康检查端点

```json
{
  "account_id": "act_123456",
  "rules": [
    {
      "id": "rule_1",
      "name": "低CTR暂停",
      "conditions": [
        {
          "metric": "ctr",
          "operator": "lt",
          "value": 1
        }
      ],
      "actions": [
        {
          "type": "pause_ad"
        }
      ],
      "enabled": true
    }
  ]
}
```

## 注意事项

1. **访问令牌权限**：确保你的Facebook访问令牌具有以下权限：
   - `ads_read`
   - `ads_management`
   - `business_management`

2. **API限制**：Facebook API有速率限制，建议监控间隔不少于30秒

3. **预算调整**：预算调整操作会立即生效，请谨慎设置规则

4. **数据存储**：规则数据存储在浏览器本地存储中，清除浏览器数据会丢失规则

## 开发

```bash
# 同时启动前端和后端（推荐）
npm run dev:all

# 仅启动前端
npm run dev

# 仅启动后端服务器
npm run dev:server

# 构建前端
npm run build

# 预览构建结果
npm run preview

# 生产模式启动服务器
npm start
```

## 许可证

MIT

