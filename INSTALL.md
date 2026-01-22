# 安装指南

## 前置要求

1. **Node.js** (版本 16 或更高)
   - 下载地址：https://nodejs.org/
   - 安装后验证：打开命令行运行 `node --version` 和 `npm --version`

2. **Facebook 开发者账户**
   - 注册地址：https://developers.facebook.com/
   - 创建应用并获取 Marketing API 访问令牌

## 安装步骤

### 方法一：使用安装脚本（Windows）

1. 双击运行 `install.bat` 文件

### 方法二：手动安装

1. **打开命令行/终端**

2. **进入项目目录**
   ```bash
   cd "d:\projects\新建文件夹"
   ```

3. **安装依赖**
   ```bash
   npm install
   ```

4. **创建环境变量文件**
   
   创建 `.env` 文件（在项目根目录），内容如下：
   ```env
   FACEBOOK_ACCESS_TOKEN=your_facebook_access_token_here
   PORT=3001
   ```
   
   > 将 `your_facebook_access_token_here` 替换为你的实际 Facebook 访问令牌

5. **启动项目**
   
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
   
   启动成功后：
   - 前端地址：http://localhost:3000
   - 后端API：http://localhost:3001/api

## 获取 Facebook 访问令牌

### 步骤 1：创建 Facebook 应用

1. 访问 [Facebook 开发者控制台](https://developers.facebook.com/)
2. 点击 **我的应用** > **创建应用**
3. 选择 **业务** 类型
4. 填写应用信息并创建

### 步骤 2：添加 Marketing API 产品

1. 在应用设置中，点击 **添加产品**
2. 找到 **Marketing API** 并点击 **设置**

### 步骤 3：获取访问令牌

#### 方法一：使用 Graph API Explorer

1. 访问 [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. 选择你的应用
3. 添加以下权限：
   - `ads_read`
   - `ads_management`
   - `business_management`
4. 点击 **生成访问令牌**
5. 复制短期令牌

#### 方法二：转换为长期令牌

短期令牌通常只有 1-2 小时有效期，需要转换为长期令牌（60天）：

```bash
curl -X GET "https://graph.facebook.com/v24.0/oauth/access_token?grant_type=fb_exchange_token&client_id={app-id}&client_secret={app-secret}&fb_exchange_token={short-lived-token}"
```

将返回的 `access_token` 值配置到 `.env` 文件中的 `FACEBOOK_ACCESS_TOKEN`。

## 验证安装

1. **启动项目**
   ```bash
   npm run dev:all
   ```
   或使用启动脚本：
   ```bash
   start.bat
   ```

2. **打开浏览器**
   访问 http://localhost:3000

3. **测试功能**
   - 点击"刷新账户列表"按钮
   - 如果看到广告账户列表，说明配置成功
   - 如果出现错误，检查：
     - `.env` 文件中的 `FACEBOOK_ACCESS_TOKEN` 是否正确
     - 后端服务器是否正常运行（http://localhost:3001/api/health）
     - Facebook 访问令牌是否有效且具有所需权限

## 常见问题

### 问题 1：npm install 失败

**解决方案：**
- 检查网络连接
- 尝试使用国内镜像：
  ```bash
  npm config set registry https://registry.npmmirror.com
  npm install
  ```

### 问题 2：无法连接到后端服务器

**解决方案：**
- 检查后端服务器是否启动（应该运行在 http://localhost:3001）
- 检查 `.env` 文件中的配置是否正确
- 确认端口 3001 未被其他程序占用

### 问题 3：Facebook API 返回错误

**解决方案：**
- 检查访问令牌是否有效
- 确认令牌具有所需权限
- 查看 Facebook API 状态页面

### 问题 4：后端服务器启动失败

**解决方案：**
- 检查 Node.js 版本是否 >= 16
- 确认所有依赖已正确安装（运行 `npm install`）
- 检查 `.env` 文件是否存在且格式正确
- 查看控制台错误信息

## 下一步

安装完成后，请参考：
- `README.md` - 功能使用说明
- `DEPLOYMENT.md` - 部署详细指南

如有问题，请检查控制台错误信息或联系支持。

