<template>
  <div class="admin-page">
    <div class="page-header">
      <h2>用户管理</h2>
      <div class="controls">
        <select v-model="statusFilter" class="select" @change="load">
          <option value="">全部状态</option>
          <option value="active">已激活</option>
          <option value="pending">待审核</option>
          <option value="rejected">已拒绝</option>
          <option value="banned">已禁用</option>
        </select>
        <button type="button" class="btn secondary" @click="load">刷新</button>
      </div>
    </div>

    <p v-if="!isSuperAdmin" class="tip">仅超级管理员可升降管理员角色；你可维护普通用户的负责人归属。</p>

    <div v-if="loading" class="loading">加载中…</div>

    <div v-else class="card">
      <div v-if="users.length === 0" class="empty">暂无数据（超管账号不在此列表显示）</div>
      <div v-else class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>状态</th>
              <th>负责人</th>
              <th>创建规则数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td class="mono">{{ u.username }}</td>
              <td><span class="tag" :class="u.role">{{ roleLabel(u.role) }}</span></td>
              <td>{{ u.status }}</td>
              <td>
                <template v-if="u.role === 'staff'">
                  <select
                    v-if="u.status === 'active'"
                    class="select small"
                    :value="u.owner_id != null ? String(u.owner_id) : ''"
                    @change="onOwnerChange(u, $event)"
                  >
                    <option value="" disabled>— 请选择负责人 —</option>
                    <option v-for="o in ownerOptions" :key="o.id" :value="String(o.id)">{{ o.owner_name }}</option>
                  </select>
                  <span v-else class="muted">—</span>
                </template>
                <span v-else class="muted">—</span>
              </td>
              <td>
                <span v-if="u.role === 'staff'">{{ rulesCount(u) }}</span>
                <span v-else class="muted">—</span>
              </td>
              <td class="actions-cell">
                <template v-if="isSuperAdmin && u.status === 'active'">
                  <button
                    v-if="u.role === 'staff'"
                    type="button"
                    class="btn small secondary"
                    @click="setRole(u, 'admin')"
                  >设为管理员</button>
                  <button
                    v-else-if="u.role === 'admin'"
                    type="button"
                    class="btn small danger"
                    @click="setRole(u, 'staff')"
                  >降为普通用户</button>
                </template>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, computed } from 'vue'
import { authFetch } from '../utils/authFetch.js'

export default {
  name: 'AdminUsers',
  setup() {
    const users = ref([])
    const ownerOptions = ref([])
    const loading = ref(false)
    const statusFilter = ref('active')
    const myRole = ref('')

    const isSuperAdmin = computed(() => myRole.value === 'super_admin')

    const roleLabel = (r) => {
      if (r === 'super_admin') return '超管'
      if (r === 'admin') return '管理员'
      return '普通用户'
    }

    const rulesCount = (u) => {
      const n = u.rules_count
      if (n == null) return '—'
      return typeof n === 'bigint' ? n.toString() : Number(n)
    }

    const loadMe = async () => {
      try {
        const r = await authFetch('/api/me')
        const d = await r.json()
        if (d.user) myRole.value = d.user.role || ''
      } catch {}
    }

    const loadOwners = async () => {
      try {
        const r = await authFetch('/api/admin/owners')
        const d = await r.json()
        ownerOptions.value = d.owners || []
      } catch {
        ownerOptions.value = []
      }
    }

    const load = async () => {
      loading.value = true
      try {
        const q = statusFilter.value ? `?status=${encodeURIComponent(statusFilter.value)}` : ''
        const r = await authFetch(`/api/admin/users${q}`)
        const d = await r.json()
        users.value = d.users || []
      } catch (e) {
        alert('加载失败: ' + (e.message || String(e)))
      } finally {
        loading.value = false
      }
    }

    const onOwnerChange = async (u, ev) => {
      const raw = ev.target.value
      if (raw === '') {
        ev.target.value = u.owner_id != null ? String(u.owner_id) : ''
        return
      }
      const oid = parseInt(raw, 10)
      if (!Number.isFinite(oid)) return
      if (!confirm(`将「${u.username}」的负责人更新为所选项？`)) {
        ev.target.value = String(u.owner_id || '')
        return
      }
      try {
        const r = await authFetch(`/api/admin/users/${u.id}/owner`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner_id: oid })
        })
        const d = await r.json()
        if (!r.ok || !d.success) {
          alert(d.error || '更新失败')
          await load()
          return
        }
        await load()
      } catch (e) {
        alert(e.message || String(e))
        await load()
      }
    }

    const setRole = async (u, role) => {
      const msg = role === 'admin'
        ? `确定将「${u.username}」设为管理员？`
        : `确定将「${u.username}」降为普通用户？`
      if (!confirm(msg)) return
      try {
        const r = await authFetch(`/api/admin/users/${u.id}/role`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role })
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok || !d.success) {
          alert(d.error || '操作失败')
          return
        }
        await load()
      } catch (e) {
        alert(e.message || String(e))
      }
    }

    onMounted(async () => {
      await loadMe()
      await loadOwners()
      await load()
    })

    return {
      users,
      ownerOptions,
      loading,
      statusFilter,
      isSuperAdmin,
      roleLabel,
      rulesCount,
      load,
      onOwnerChange,
      setRole
    }
  }
}
</script>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
  gap: 12px;
}
.page-header h2 {
  margin: 0;
  font-size: 24px;
  color: var(--text-primary);
}
.controls {
  display: flex;
  gap: 12px;
  align-items: center;
}
.select {
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  min-width: 120px;
}
.select.small {
  padding: 4px 8px;
  font-size: 13px;
  max-width: 160px;
}
.tip {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 16px;
}
.loading {
  padding: 24px;
  color: var(--text-secondary);
}
.card {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.table-container {
  overflow-x: auto;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
}
.data-table th,
.data-table td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--bg-body);
  text-align: left;
}
.data-table th {
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 13px;
}
.mono {
  font-family: ui-monospace, monospace;
  font-size: 14px;
}
.muted {
  color: var(--text-secondary);
  font-size: 13px;
}
.empty {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
}
.tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  background: var(--bg-body);
}
.tag.admin {
  color: #2563eb;
}
.tag.staff {
  color: var(--text-secondary);
}
.actions-cell {
  white-space: nowrap;
}
.btn.small {
  padding: 4px 10px;
  font-size: 13px;
  margin-right: 6px;
}
</style>
