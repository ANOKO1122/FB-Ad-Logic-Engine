<template>
  <div class="admin-page">
    <div class="page-header">
      <h2>用户审核</h2>
      <div class="controls">
        <select v-model="statusFilter" class="select">
          <option value="">全部状态</option>
          <option value="pending">待审核</option>
          <option value="active">已通过</option>
          <option value="rejected">已拒绝</option>
        </select>
        <button @click="load" class="btn secondary">刷新</button>
      </div>
    </div>

    <div v-if="loading" class="loading">加载中...</div>
    
    <div v-else class="list-container">
      <div v-if="users.length === 0" class="empty">暂无数据</div>
      
      <div v-for="u in users" :key="u.id" class="user-card">
        <div class="card-left">
          <div class="username">{{ u.username }}</div>
          <div class="meta">
            <span class="tag role">{{ u.role }}</span>
            <span class="tag status" :class="u.status">{{ u.status }}</span>
            <span class="info">负责人: {{ u.owner_name || '-' }}</span>
          </div>
        </div>
        <div class="card-right" v-if="u.status === 'pending'">
          <button class="btn success small" @click="approve(u.id)">通过</button>
          <button class="btn danger small" @click="reject(u.id)">拒绝</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, watch, onMounted } from 'vue'
import { authFetch } from '../utils/authFetch.js'

export default {
  name: 'AdminReview',
  emits: ['refresh-pending'], // 声明事件
  setup(props, { emit }) {
    const users = ref([])
    const statusFilter = ref('pending')
    const loading = ref(false)

    const load = async () => {
      loading.value = true
      try {
        const url = statusFilter.value ? `/api/admin/users?status=${statusFilter.value}` : '/api/admin/users'
        const resp = await authFetch(url)
        const data = await resp.json()
        users.value = data.users || []
      } finally {
        loading.value = false
      }
    }

    const approve = async (id) => {
      if (!confirm('确定通过该用户？')) return
      const resp = await authFetch(`/api/admin/users/${id}/approve`, { method: 'POST' })
      const data = await resp.json()
      if (!data.success) return alert(data.error || '操作失败')
      await load()
      emit('refresh-pending') // 通知父组件更新红点
    }

    const reject = async (id) => {
      if (!confirm('确定拒绝该用户？')) return
      const resp = await authFetch(`/api/admin/users/${id}/reject`, { method: 'POST' })
      const data = await resp.json()
      if (!data.success) return alert(data.error || '操作失败')
      await load()
      emit('refresh-pending') // 通知父组件更新红点
    }

    watch(statusFilter, load)
    onMounted(load)

    return { users, statusFilter, loading, load, approve, reject }
  }
}
</script>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.page-header h2 {
  margin: 0;
  font-size: 24px;
  color: var(--text-primary);
}

.controls {
  display: flex;
  gap: 12px;
}

.select {
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  min-width: 120px;
}

.list-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.user-card {
  background: #fff;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}

.username {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}

.meta {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
}

.tag {
  padding: 2px 8px;
  border-radius: 4px;
  background: #f0f2f5;
  color: var(--text-secondary);
}

.tag.status.pending { background: #fff8e1; color: #f57c00; }
.tag.status.active { background: #e8f5e9; color: #2e7d32; }
.tag.status.rejected { background: #ffebee; color: #c62828; }

.info {
  color: var(--text-secondary);
  margin-left: 8px;
}

.card-right {
  display: flex;
  gap: 8px;
}

.btn.success { background: var(--secondary-color); color: #fff; }
.btn.danger { background: var(--danger-color); color: #fff; }
.btn.small { padding: 6px 12px; font-size: 13px; }

.empty {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
  background: #fff;
  border-radius: 12px;
}
</style>
