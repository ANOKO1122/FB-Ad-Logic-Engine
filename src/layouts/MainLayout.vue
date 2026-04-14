<template>
  <div class="app-layout">
    <!-- 左侧侧边栏 -->
    <aside class="sidebar">
      <div class="logo-area">
        <h2>FB 智投</h2>
        <span class="version">v1.2</span>
      </div>

      <nav class="nav-menu">
        <router-link to="/dashboard" class="nav-item" active-class="active">
          <span class="text">数据监控</span>
        </router-link>

        <router-link to="/rules" class="nav-item" active-class="active">
          <span class="text">规则管理</span>
        </router-link>

        <router-link to="/logs" class="nav-item" active-class="active">
          <span class="text">执行日志</span>
        </router-link>

        <div class="divider"></div>

        <!-- 仅管理员可见 -->
        <template v-if="user && (user.role === 'admin' || user.role === 'super_admin')">
          <router-link to="/system" class="nav-item" active-class="active">
            <span class="text">系统状态</span>
          </router-link>

          <router-link to="/admin/users" class="nav-item" active-class="active">
            <span class="text">用户管理</span>
          </router-link>

          <router-link to="/admin/owners" class="nav-item" active-class="active">
            <span class="text">负责人管理</span>
          </router-link>

          <router-link to="/admin/account-mapping" class="nav-item" active-class="active">
            <span class="text">账户设置</span>
          </router-link>

          <router-link to="/admin/templates" class="nav-item" active-class="active">
            <span class="text">模板管理</span>
          </router-link>

          <router-link to="/admin/rule-history" class="nav-item" active-class="active">
            <span class="text">规则审计</span>
          </router-link>
          
          <router-link to="/admin/review" class="nav-item" active-class="active">
            <span class="text">用户审核</span>
            <span v-if="pendingCount > 0" class="badge-count">{{ pendingCount }}</span>
          </router-link>
        </template>
      </nav>

      <!-- 底部用户信息区 -->
      <div class="sidebar-footer" v-if="user">
        <div class="user-profile">
          <div class="avatar">{{ user.username.charAt(0).toUpperCase() }}</div>
          <div class="user-info">
            <div class="name" :title="user.username">{{ user.username }}</div>
            <div class="role">{{ roleLabel(user.role) }}</div>
          </div>
        </div>
        
        <button class="btn-logout" @click="handleLogout">
          退出登录
        </button>
      </div>
    </aside>

    <!-- 右侧内容区 -->
    <main class="main-content">
      <div class="page-container">
        <router-view @refresh-pending="fetchPendingCount"></router-view>
      </div>
    </main>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { authFetch, setStoredToken } from '../utils/authFetch.js'

export default {
  name: 'MainLayout',
  setup() {
    const router = useRouter()
    const user = ref(null)
    const pendingCount = ref(0)

    const fetchUser = async () => {
      try {
        const res = await authFetch('/api/me')
        if (res.ok) {
          const data = await res.json()
          user.value = data.user
          // 如果是管理员，获取待审核人数
          if (user.value.role === 'admin' || user.value.role === 'super_admin') {
            fetchPendingCount()
          }
        } else {
          router.push('/login')
        }
      } catch (e) {
        console.error('获取用户信息失败', e)
      }
    }

    const fetchPendingCount = async () => {
      try {
        const res = await authFetch('/api/admin/users')
        if (res.ok) {
          const data = await res.json()
          // 统计 status 为 pending 的用户
          pendingCount.value = (data.users || []).filter(u => u.status === 'pending').length
        }
      } catch (e) {
        console.warn('获取待审核人数失败', e)
      }
    }

    const handleLogout = async () => {
      if (!confirm('确定要退出登录吗？')) return
      try {
        await authFetch('/api/auth/logout', { method: 'POST' })
        setStoredToken(null)
        router.push('/login')
      } catch (e) {
        console.error('退出失败', e)
        router.push('/login')
      }
    }

    const roleLabel = (role) => {
      if (role === 'super_admin') return '超级管理员'
      if (role === 'admin') return '管理员'
      return '员工'
    }

    onMounted(fetchUser)

    return {
      user,
      pendingCount,
      handleLogout,
      fetchPendingCount,
      roleLabel
    }
  }
}
</script>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}

.sidebar {
  width: var(--sidebar-width);
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  z-index: 10;
  flex-shrink: 0;
}

.logo-area {
  height: var(--header-height);
  display: flex;
  align-items: center;
  padding: 0 20px;
  border-bottom: 1px solid var(--border-color);
}

.logo-area h2 {
  margin: 0;
  font-size: 20px;
  color: var(--primary-color);
  font-weight: 800;
}

.version {
  margin-left: 8px;
  font-size: 10px;
  color: var(--text-secondary);
  background: #f0f2f5;
  padding: 2px 6px;
  border-radius: 4px;
}

.nav-menu {
  flex: 1;
  padding: 16px 8px;
  overflow-y: auto;
}

.nav-item {
  display: flex;
  align-items: center;
  padding: 12px 16px; /* 增加内边距 */
  margin-bottom: 4px;
  text-decoration: none;
  color: var(--sidebar-text);
  border-radius: var(--radius-md);
  transition: all 0.2s;
  font-weight: 600; /* 加粗字体 */
  font-size: 15px; /* 稍微调大字号 */
  position: relative;
}

.nav-item:hover {
  background-color: #f0f2f5;
  color: var(--primary-color); /* 悬停变色 */
}

.nav-item.active {
  background-color: var(--sidebar-active-bg);
  color: var(--sidebar-active-text);
}

.divider {
  height: 1px;
  background: var(--border-color);
  margin: 12px 0;
  opacity: 0.5;
}

/* 红色徽章 */
.badge-count {
  position: absolute;
  right: 12px;
  background-color: var(--danger-color);
  color: white;
  font-size: 12px;
  font-weight: bold;
  height: 20px;
  min-width: 20px;
  line-height: 20px;
  text-align: center;
  border-radius: 10px;
  padding: 0 6px;
  box-shadow: 0 2px 4px rgba(250, 56, 62, 0.3);
}

/* 底部区域 */
.sidebar-footer {
  padding: 16px;
  border-top: 1px solid var(--border-color);
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.user-profile {
  display: flex;
  align-items: center;
  gap: 10px;
}

.avatar {
  width: 36px;
  height: 36px;
  background: #e4e6eb;
  color: #65676B;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 600;
}

.user-info {
  flex: 1;
  overflow: hidden;
}

.user-info .name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.user-info .role {
  font-size: 12px;
  color: var(--text-secondary);
}

.btn-logout {
  width: 100%;
  padding: 10px; /* 增加按钮高度 */
  border: 1px solid var(--border-color);
  background: #fff;
  color: var(--text-secondary);
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  font-weight: 500;
}

.btn-logout:hover {
  background: #FFF5F5;
  color: var(--danger-color);
  border-color: #FED7D7;
}

.main-content {
  flex: 1;
  background: var(--bg-body);
  overflow-y: auto;
  position: relative;
}

.page-container {
  padding: 24px;
  min-height: 100%;
}
</style>
