<template>
  <div class="admin-page">
    <div class="page-header">
      <h2>负责人管理</h2>
      <div class="controls">
        <button type="button" class="btn secondary" @click="loadOwners">刷新</button>
        <button type="button" class="btn" @click="openAddModal">+ 新增负责人</button>
      </div>
    </div>

    <p class="page-desc">
      负责人主数据仅在此维护；广告账户映射请在
      <router-link to="/admin/account-mapping" class="inline-link">账户设置</router-link>
      中操作。
    </p>

    <div v-if="loading" class="loading">加载中...</div>

    <div v-else class="card">
      <div v-if="owners.length === 0" class="empty">暂无负责人数据</div>
      <div v-else class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>标识</th>
              <th>广告账户数</th>
              <th>系统账户数</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in owners" :key="o.id">
              <td>{{ o.owner_name }}</td>
              <td class="mono">{{ o.owner_key }}</td>
              <td>{{ countOf(o, 'ad_account_count') }}</td>
              <td>{{ countOf(o, 'system_user_count') }}</td>
              <td>{{ o.is_active ? '启用' : '停用' }}</td>
              <td>
                <button
                  v-if="o.owner_key !== 'none'"
                  type="button"
                  class="btn danger small"
                  @click="openDeleteModal(o)"
                >
                  删除
                </button>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新增负责人 -->
    <div v-if="showAddModal" class="modal-overlay" @click.self="showAddModal = false">
      <div class="modal-content" role="dialog" aria-labelledby="add-owner-title">
        <div class="modal-header">
          <h3 id="add-owner-title">新增负责人</h3>
          <button type="button" class="modal-close" aria-label="关闭" @click="showAddModal = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>负责人名称 *</label>
            <input v-model="newOwnerName" type="text" class="input" placeholder="例如：张三" />
          </div>
          <div class="form-group">
            <label>负责人标识（可选）</label>
            <input v-model="newOwnerKey" type="text" class="input" placeholder="不填则与名称相同；批量导入时用于匹配" />
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn secondary" @click="showAddModal = false">取消</button>
          <button
            type="button"
            class="btn"
            :disabled="!newOwnerName?.trim() || creating"
            @click="submitCreate"
          >
            {{ creating ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 删除确认（影响量 + confirm） -->
    <div v-if="pendingDelete" class="modal-overlay" @click.self="pendingDelete = null">
      <div class="modal-content" role="dialog" aria-labelledby="del-owner-title">
        <div class="modal-header">
          <h3 id="del-owner-title">确认删除负责人</h3>
          <button type="button" class="modal-close" aria-label="关闭" @click="pendingDelete = null">×</button>
        </div>
        <div class="modal-body">
          <p class="warn-text">
            将删除「<strong>{{ pendingDelete.owner_name }}</strong>」，操作不可撤销。
          </p>
          <ul class="impact-list">
            <li>广告账户（有效映射）：<strong>{{ deleteImpact.ad }}</strong> 个将归「无」</li>
            <li>系统用户：<strong>{{ deleteImpact.sys }}</strong> 人将归「无」</li>
          </ul>
          <p v-if="impactLoading" class="muted">正在刷新影响量…</p>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn secondary" @click="pendingDelete = null">取消</button>
          <button
            type="button"
            class="btn danger"
            :disabled="deleting || impactLoading"
            @click="confirmDelete"
          >
            {{ deleting ? '删除中…' : '确认删除' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'
import { authFetch } from '../utils/authFetch.js'

export default {
  name: 'AdminOwners',
  setup() {
    const owners = ref([])
    const loading = ref(false)
    const showAddModal = ref(false)
    const newOwnerName = ref('')
    const newOwnerKey = ref('')
    const creating = ref(false)

    const pendingDelete = ref(null)
    const deleteImpact = ref({ ad: 0, sys: 0 })
    const impactLoading = ref(false)
    const deleting = ref(false)

    const countOf = (o, key) => {
      const v = o[key]
      if (v == null) return '—'
      return typeof v === 'bigint' ? v.toString() : Number(v)
    }

    const loadOwners = async () => {
      loading.value = true
      try {
        const resp = await authFetch('/api/admin/owners')
        const data = await resp.json()
        if (!resp.ok) {
          alert(data.error || '加载失败')
          return
        }
        owners.value = data.owners || []
      } catch (e) {
        alert('加载失败: ' + (e.message || String(e)))
      } finally {
        loading.value = false
      }
    }

    const openAddModal = () => {
      newOwnerName.value = ''
      newOwnerKey.value = ''
      showAddModal.value = true
    }

    const submitCreate = async () => {
      if (!newOwnerName.value?.trim()) return
      creating.value = true
      try {
        const resp = await authFetch('/api/admin/owners', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            owner_name: newOwnerName.value.trim(),
            owner_key: newOwnerKey.value.trim() || undefined
          })
        })
        const data = await resp.json()
        if (!resp.ok || !data.success) {
          alert(data.error || '创建失败')
          return
        }
        showAddModal.value = false
        await loadOwners()
      } catch (e) {
        alert('创建出错: ' + (e.message || String(e)))
      } finally {
        creating.value = false
      }
    }

    const openDeleteModal = async (o) => {
      if (o.owner_key === 'none') return
      pendingDelete.value = o
      deleteImpact.value = {
        ad: Number(o.ad_account_count) || 0,
        sys: Number(o.system_user_count) || 0
      }
      impactLoading.value = true
      try {
        const resp = await authFetch(`/api/admin/owners/${o.id}/impact`)
        const data = await resp.json()
        if (resp.ok && data.success) {
          deleteImpact.value = {
            ad: Number(data.ad_account_count) || 0,
            sys: Number(data.system_user_count) || 0
          }
        }
      } catch {
        // 保留列表上的数字
      } finally {
        impactLoading.value = false
      }
    }

    const confirmDelete = async () => {
      const o = pendingDelete.value
      if (!o) return
      deleting.value = true
      try {
        const resp = await authFetch(`/api/admin/owners/${o.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true })
        })
        const data = await resp.json().catch(() => ({}))
        if (!resp.ok || !data.success) {
          alert(data.error || data.message || '删除失败')
          return
        }
        pendingDelete.value = null
        await loadOwners()
      } catch (e) {
        alert('删除出错: ' + (e.message || String(e)))
      } finally {
        deleting.value = false
      }
    }

    onMounted(() => {
      loadOwners()
    })

    return {
      owners,
      loading,
      showAddModal,
      newOwnerName,
      newOwnerKey,
      creating,
      pendingDelete,
      deleteImpact,
      impactLoading,
      deleting,
      countOf,
      loadOwners,
      openAddModal,
      submitCreate,
      openDeleteModal,
      confirmDelete
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
}

.page-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 16px;
}

.inline-link {
  color: var(--primary-color);
  text-decoration: none;
}
.inline-link:hover {
  text-decoration: underline;
}

.loading {
  padding: 24px;
  color: var(--text-secondary);
}

.card {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  padding: 0;
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
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
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

.warn-text {
  margin: 0 0 12px;
  color: var(--text-primary);
}

.impact-list {
  margin: 0;
  padding-left: 20px;
  color: var(--text-primary);
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  width: 90%;
  max-width: 480px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h3 {
  margin: 0;
  font-size: 18px;
}

.modal-close {
  background: none;
  border: none;
  font-size: 24px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
  width: 32px;
  height: 32px;
  line-height: 1;
  border-radius: var(--radius-sm);
}
.modal-close:hover {
  background: var(--bg-body);
}

.modal-body {
  padding: 24px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 20px 24px;
  border-top: 1px solid var(--border-color);
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  margin-bottom: 8px;
  font-weight: 500;
  font-size: 14px;
}

.form-group .input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font-size: 14px;
  background: var(--bg-body);
  color: var(--text-primary);
  box-sizing: border-box;
}
.form-group .input:focus {
  outline: none;
  border-color: var(--primary-color);
}
</style>
