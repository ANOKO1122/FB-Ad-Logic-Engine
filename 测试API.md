# 测试API和调试指南

## 快速测试步骤

### 1. 检查后端服务器是否运行

访问：http://localhost:3001/api/health

应该返回：
```json
{"status":"ok","message":"服务器运行正常"}
```

### 2. 测试Facebook API连接

在浏览器中直接访问（替换YOUR_TOKEN为你的实际令牌）：
```
http://localhost:3001/api/accounts
```

或者使用curl：
```bash
curl http://localhost:3001/api/accounts
```

### 3. 查看后端控制台日志

启动后端服务器后，控制台会显示：
- ✅ Token配置状态
- 📡 API请求详情
- ❌ 错误信息（如果有）

## 常见错误及解决方案

### 错误1: "Invalid OAuth access token"

**原因：**
- Token已过期
- Token格式不正确
- Token被撤销

**解决：**
1. 在Graph API Explorer中重新生成Token
2. 转换为长期Token
3. 更新.env文件

### 错误2: "Insufficient permissions"

**原因：**
- Token缺少必需权限

**解决：**
确保Token具有以下权限：
- `ads_read`
- `ads_management`  
- `business_management`

### 错误3: "User does not have permission"

**原因：**
- 用户不是广告账户的管理员
- 账户权限不足

**解决：**
1. 在Facebook Business Manager中检查账户权限
2. 确保你的Facebook账户是广告账户的管理员

### 错误4: "Unsupported get request"

**原因：**
- API端点不正确
- 使用了错误的API版本

**解决：**
检查API版本是否为v24.0

## 手动测试Token

### 方法1: 使用Graph API Explorer

1. 访问：https://developers.facebook.com/tools/explorer/
2. 选择你的应用
3. 输入Token
4. 测试端点：`/me/adaccounts`

### 方法2: 使用curl命令

```bash
curl "https://graph.facebook.com/v24.0/me/adaccounts?access_token=YOUR_TOKEN"
```

### 方法3: 在浏览器中测试

```
https://graph.facebook.com/v24.0/me/adaccounts?access_token=YOUR_TOKEN
```

## 检查Token信息

访问以下URL查看Token信息（替换YOUR_TOKEN）：
```
https://graph.facebook.com/v24.0/me?access_token=YOUR_TOKEN
```

应该返回你的用户信息。

## 调试技巧

### 1. 启用详细日志

后端服务器会自动输出详细日志，包括：
- API请求URL
- 错误详情
- 返回数据数量

### 2. 检查.env文件

确保：
- 文件名为 `.env`（不是 `.env.txt`）
- 文件在项目根目录
- Token没有多余的空格或引号
- 格式：`FACEBOOK_ACCESS_TOKEN=EAALxxxxx`

### 3. 验证Token格式

Facebook Token通常：
- 以 `EAAL` 开头（用户Token）
- 长度约60-200字符
- 不包含空格

## 获取帮助

如果问题仍然存在：

1. **查看后端控制台**：查看详细的错误信息
2. **检查浏览器网络标签**：查看API请求和响应
3. **测试Token**：在Graph API Explorer中直接测试
4. **检查权限**：确保Token具有所有必需权限

