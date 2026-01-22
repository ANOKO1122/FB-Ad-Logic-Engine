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
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'

export default {
  name: 'AdminAccountMapping',
  setup() {
    const owners = ref([])
    const mappings = ref([])
    const ownerFilter = ref('')
    const importText = ref('')

    const loadOwners = async () => {
      try {
        const resp = await fetch('/api/admin/owners', { credentials: 'include' })
        const data = await resp.json()
        owners.value = data.owners || []
      } catch {}
    }

    const loadMappings = async () => {
      try {
        const url = ownerFilter.value ? `/api/admin/account-mappings?owner_id=${ownerFilter.value}` : '/api/admin/account-mappings'
        const resp = await fetch(url, { credentials: 'include' })
        const data = await resp.json()
        mappings.value = (data.mappings || []).map(x => ({ ...x, newOwnerId: '' }))
      } catch {}
    }

    const assign = async (m) => {
      if (!m.newOwnerId) return
      try {
        const resp = await fetch('/api/admin/account-mappings/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
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
        const resp = await fetch('/api/admin/account-mappings/batch-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
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

    onMounted(async () => {
      await loadOwners()
      await loadMappings()
    })

    return { owners, mappings, ownerFilter, importText, loadMappings, assign, batchImport }
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
</style>
