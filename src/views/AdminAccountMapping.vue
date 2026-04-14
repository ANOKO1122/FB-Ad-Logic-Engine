<template>
  <div class="admin-page">
    <p class="page-tip">新增负责人请前往 <router-link to="/admin/owners" class="inline-link">负责人管理</router-link>；本页仅维护账户与负责人的映射。</p>

    <div class="page-header">
      <h2>账户归属管理</h2>
      <div class="controls">
        <select v-model="ownerFilter" @change="loadMappings" class="select">
          <option value="">全部负责人</option>
          <option v-for="o in owners" :key="o.id" :value="o.id">{{ o.owner_name }}</option>
        </select>
        <button class="btn secondary" @click="loadMappings">刷新</button>
        <router-link to="/admin/owners" class="btn secondary link-btn">负责人管理</router-link>
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
              <th>状态</th>
              <th>更换</th>
              <th>启用/停用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in mappings" :key="m.id">
              <td class="mono">{{ m.fb_account_id }}</td>
              <td>{{ m.fb_account_name || '-' }}</td>
              <td>{{ m.owner_name }}</td>
              <td>
                <span class="status-tag" :class="{ on: isActive(m), off: !isActive(m) }">
                  {{ isActive(m) ? '启用' : '停用' }}
                </span>
              </td>
              <td>
                <select v-model="m.newOwnerId" @change="assign(m)" class="select small">
                  <option value="">选择负责人</option>
                  <option v-for="o in owners" :key="o.id" :value="o.id">{{ o.owner_name }}</option>
                </select>
              </td>
              <td>
                <button
                  v-if="isActive(m)"
                  type="button"
                  class="btn small danger"
                  :disabled="statusSavingId === m.fb_account_id"
                  @click="setMappingActive(m, false)"
                >
                  {{ statusSavingId === m.fb_account_id ? '…' : '停用' }}
                </button>
                <button
                  v-else
                  type="button"
                  class="btn small secondary"
                  :disabled="statusSavingId === m.fb_account_id"
                  @click="setMappingActive(m, true)"
                >
                  {{ statusSavingId === m.fb_account_id ? '…' : '启用' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3>批量导入</h3>
      <p class="hint">每行：<code>act_数字</code> 空格 负责人（owner_key 或 owner_name，含「无」）。整批任一错误则不落库，并提示行号。已存在的账户仅更新负责人，<strong>不自动改启用/停用</strong>；新插入的账户默认为启用。</p>
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
import { authFetch } from '../utils/authFetch.js'

export default {
  name: 'AdminAccountMapping',
  setup() {
    const owners = ref([])
    const mappings = ref([])
    const ownerFilter = ref('')
    const importText = ref('')
    const statusSavingId = ref('')

    const isActive = (m) => {
      const v = m.is_active
      if (v === true || v === 1) return true
      if (v === false || v === 0) return false
      if (typeof v === 'bigint') return v === 1n
      return Number(v) === 1
    }

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

    const setMappingActive = async (m, nextActive) => {
      const word = nextActive ? '启用' : '停用'
      if (!confirm(`确定${word}广告账户 ${m.fb_account_id}？\n停用后：不参与同步与规则调度，普通用户在选账户列表中不可见。`)) return
      statusSavingId.value = m.fb_account_id
      try {
        const resp = await authFetch('/api/admin/account-mappings/status', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fb_account_id: m.fb_account_id, is_active: nextActive })
        })
        const data = await resp.json().catch(() => ({}))
        if (!resp.ok || !data.success) {
          alert(data.error || '操作失败')
          return
        }
        await loadMappings()
      } catch (e) {
        alert(e.message || String(e))
      } finally {
        statusSavingId.value = ''
      }
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
        if (!resp.ok || !data.success) {
          const errs = Array.isArray(data.errors) ? data.errors : []
          if (errs.length > 0) {
            const detail = errs.map((e) => `第${e.line}行: ${e.message || e.code || ''}`).join('\n')
            alert(`${data.error || '整批校验未通过'}\n\n${detail}`)
          } else {
            alert(data.error || '导入失败')
          }
          return
        }
        alert(data.message || '导入成功')
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

    return { 
      owners, mappings, ownerFilter, importText, statusSavingId,
      isActive, setMappingActive,
      loadMappings, assign, batchImport
    }
  }
}
</script>

<style scoped>
.page-tip {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 12px;
}
.inline-link {
  color: var(--primary-color);
  text-decoration: none;
}
.inline-link:hover {
  text-decoration: underline;
}
.link-btn {
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
}

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

.status-tag {
  display: inline-block;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: var(--radius-md, 6px);
  font-weight: 600;
}
.status-tag.on {
  background: rgba(34, 197, 94, 0.15);
  color: #16a34a;
}
.status-tag.off {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
}
</style>
