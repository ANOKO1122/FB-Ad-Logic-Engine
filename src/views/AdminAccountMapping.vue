<template>
  <div class="admin-page">
    <div class="page-header">
      <h2>账户归属管理</h2>
      <div class="controls">
        <select v-model="ownerFilter" @change="loadMappings" class="select">
          <option value="">全部负责人</option>
          <option v-for="o in owners" :key="o.id" :value="o.id">{{ o.owner_name }}</option>
        </select>
        <button class="btn secondary" @click="loadMappings">刷新</button>
        <button class="btn" @click="showAddOwnerModal = true">+ 新增负责人</button>
      </div>
    </div>

    <div class="card">
      <div v-if="mappings.length === 0" class="empty">暂无账户映射数据</div>
      <div v-else class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>账户ID</th>
              <th>账户名</th>
              <th>当前负责人</th>
              <th>更换</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in mappings" :key="m.id">
              <td class="mono">{{ m.fb_account_id }}</td>
              <td>{{ m.fb_account_name || '-' }}</td>
              <td>{{ m.owner_name }}</td>
              <td>
                <select v-model="m.newOwnerId" @change="assign(m)" class="select small">
                  <option value="">选择负责人</option>
                  <option v-for="o in owners" :key="o.id" :value="o.id">{{ o.owner_name }}</option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3>批量导入</h3>
      <p class="hint">每行格式：act_12345678 负责人名字</p>
      <textarea v-model="importText" class="import-area" placeholder="act_12345678 Williams
act_87654321 Lucky"></textarea>
      <div class="actions">
        <button class="btn" @click="batchImport">开始导入</button>
      </div>
    </div>

    <!-- 新增负责人弹窗 -->
    <div v-if="showAddOwnerModal" class="modal-overlay" @click="showAddOwnerModal = false">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h3>新增负责人</h3>
          <button class="modal-close" @click="showAddOwnerModal = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>负责人名称 *</label>
            <input v-model="newOwnerName" type="text" class="input" placeholder="例如：张三" />
          </div>
          <div class="form-group">
            <label>负责人标识（可选）</label>
            <input v-model="newOwnerKey" type="text" class="input" placeholder="如果不填，将使用负责人名称" />
            <p class="form-hint">用于批量导入时匹配，通常与负责人名称相同</p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn secondary" @click="showAddOwnerModal = false">取消</button>
          <button class="btn" @click="createOwner" :disabled="!newOwnerName?.trim() || creatingOwner">
            {{ creatingOwner ? '创建中...' : '创建' }}
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
  name: 'AdminAccountMapping',
  setup() {
    const owners = ref([])
    const mappings = ref([])
    const ownerFilter = ref('')
    const importText = ref('')
    const showAddOwnerModal = ref(false)
    const newOwnerName = ref('')
    const newOwnerKey = ref('')
    const creatingOwner = ref(false)

    const loadOwners = async () => {
      try {
        const resp = await authFetch('/api/admin/owners')
        const data = await resp.json()
        owners.value = data.owners || []
      } catch {}
    }

    const loadMappings = async () => {
      try {
        const url = ownerFilter.value ? `/api/admin/account-mappings?owner_id=${ownerFilter.value}` : '/api/admin/account-mappings'
        const resp = await authFetch(url)
        const data = await resp.json()
        mappings.value = (data.mappings || []).map(x => ({ ...x, newOwnerId: '' }))
      } catch {}
    }

    const assign = async (m) => {
      if (!m.newOwnerId) return
      try {
        const resp = await authFetch('/api/admin/account-mappings/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fb_account_id: m.fb_account_id, owner_id: parseInt(m.newOwnerId) })
        })
        const data = await resp.json()
        if (!data.success) alert(data.error || '操作失败')
        await loadMappings()
        m.newOwnerId = ''
      } catch {}
    }

    const batchImport = async () => {
      if (!importText.value.trim()) return
      try {
        const lines = importText.value.trim().split('\n').map(s => s.trim()).filter(Boolean)
        const payload = lines.map(line => {
          const parts = line.split(/\s+/)
          return { fb_account_id: parts[0], owner_key: parts.slice(1).join(' ') }
        })
        const resp = await authFetch('/api/admin/account-mappings/batch-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mappings: payload })
        })
        const data = await resp.json()
        if (!data.success) return alert(data.error || '导入失败')
        alert(data.message)
        importText.value = ''
        await loadMappings()
      } catch (e) {
        alert('导入出错: ' + e.message)
      }
    }

    const createOwner = async () => {
      if (!newOwnerName.value.trim()) return
      creatingOwner.value = true
      try {
        const resp = await authFetch('/api/admin/owners', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            owner_name: newOwnerName.value.trim(),
            owner_key: newOwnerKey.value.trim() || undefined
          })
        })
        const data = await resp.json()
        if (!data.success) {
          alert(data.error || '创建失败')
          return
        }
        alert(data.message || '创建成功')
        showAddOwnerModal.value = false
        newOwnerName.value = ''
        newOwnerKey.value = ''
        await loadOwners() // 刷新负责人列表
      } catch (e) {
        alert('创建出错: ' + e.message)
      } finally {
        creatingOwner.value = false
      }
    }

    onMounted(async () => {
      await loadOwners()
      await loadMappings()
    })

    return { 
      owners, mappings, ownerFilter, importText, 
      showAddOwnerModal, newOwnerName, newOwnerKey, creatingOwner,
      loadMappings, assign, batchImport, createOwner 
    }
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

.select.small { padding: 4px 8px; font-size: 13px; }

.table-container {
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
}

.data-table th, .data-table td {
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
  color: var(--text-secondary);
}

.empty { text-align: center; padding: 40px; color: var(--text-secondary); }

.hint {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.import-area {
  width: 100%;
  height: 120px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 12px;
  font-family: monospace;
  resize: vertical;
  margin-bottom: 12px;
}

.actions { display: flex; justify-content: flex-end; }

/* 弹窗样式 */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
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
  max-width: 500px;
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
  color: var(--text-primary);
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
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  transition: background 0.2s;
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
  color: var(--text-primary);
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
}

.form-group .input:focus {
  outline: none;
  border-color: var(--primary-color);
}

.form-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
