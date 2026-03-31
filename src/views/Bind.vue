<template>
  <div class="bind-page">
    <h2>注册并绑定</h2>

    <div v-if="loading">正在读取待绑定信息...</div>
    <div v-else-if="loadError" class="error">
      {{ loadError }}
      <div class="actions">
        <a href="/api/auth/dingtalk/login">重新扫码登录</a>
      </div>
    </div>

    <div v-else class="card">
      <div class="hint">
        你已通过钉钉身份校验，但尚未绑定本系统账号。请选择一种方式继续。
      </div>

      <div class="kv">
        <div class="k">unionId</div>
        <div class="v">{{ pending.unionId }}</div>
      </div>
      <div class="kv">
        <div class="k">钉钉userid</div>
        <div class="v">{{ pending.dingtalkUserId }}</div>
      </div>
      <div class="kv">
        <div class="k">手机号</div>
        <div class="v">{{ pending.mobile || '（未返回）' }}</div>
      </div>
      <div class="kv">
        <div class="k">内部员工</div>
        <div class="v">{{ pending.contactType === 0 ? '是' : '否/未知' }}</div>
      </div>
      <div class="kv">
        <div class="k">在职</div>
        <div class="v">{{ pending.active === true ? '是' : pending.active === false ? '否' : '未知' }}</div>
      </div>

      <div class="switch">
        <button :class="{ active: mode === 'existing' }" @click="mode = 'existing'">我已有旧账号</button>
        <button :class="{ active: mode === 'register' }" @click="mode = 'register'">我是首次使用</button>
      </div>

      <form v-if="mode === 'existing'" class="form" @submit.prevent="submitBindExisting">
        <div class="row">
          <label>旧账号用户名</label>
          <input v-model="existing.username" type="text" required />
        </div>
        <div class="row">
          <label>旧账号密码</label>
          <input v-model="existing.password" type="password" required />
        </div>
        <button :disabled="submitting" type="submit">{{ submitting ? '绑定中...' : '绑定旧账号' }}</button>
      </form>

      <form v-else class="form" @submit.prevent="submitRegisterAndBind">
        <div class="row">
          <label>新用户名</label>
          <input v-model="register.username" type="text" required />
        </div>
        <div class="row">
          <label>密码</label>
          <input v-model="register.password" type="password" required />
        </div>
        <div class="row">
          <label>确认密码</label>
          <input v-model="register.confirmPassword" type="password" required />
        </div>
        <div class="row">
          <label>负责人</label>
          <select v-model="register.ownerId" required>
            <option value="">请选择负责人</option>
            <option v-for="o in owners" :key="o.id" :value="o.id">{{ o.owner_name }}</option>
          </select>
        </div>
        <button :disabled="submitting" type="submit">{{ submitting ? '提交中...' : '首次注册并绑定' }}</button>
      </form>

      <div v-if="actionError" class="error action-error">{{ actionError }}</div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { setStoredToken } from '../utils/authFetch.js'

const loading = ref(true)
const loadError = ref('')
const actionError = ref('')
const submitting = ref(false)
const pending = ref(null)
const owners = ref([])
const mode = ref('existing')

const existing = ref({
  username: '',
  password: '',
})

const register = ref({
  username: '',
  password: '',
  confirmPassword: '',
  ownerId: '',
})

async function loadPendingBind() {
  const resp = await fetch('/api/auth/dingtalk/pending-bind', { credentials: 'include' })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || !data?.success) {
    throw new Error(data?.error || '读取待绑定信息失败')
  }
  pending.value = data.pending
}

async function loadOwners() {
  const resp = await fetch('/api/owners', { credentials: 'include' })
  const data = await resp.json().catch(() => ({}))
  owners.value = data.owners || []
}

async function submitBindExisting() {
  actionError.value = ''
  submitting.value = true
  try {
    const resp = await fetch('/api/auth/dingtalk/bind-existing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(existing.value),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      actionError.value = data?.error || '绑定失败'
      return
    }
    if (data?.token) setStoredToken(data.token)
    window.location.href = data?.next || '/dashboard'
  } catch {
    actionError.value = '网络异常，请稍后重试'
  } finally {
    submitting.value = false
  }
}

async function submitRegisterAndBind() {
  actionError.value = ''
  if (register.value.password !== register.value.confirmPassword) {
    actionError.value = '两次输入的密码不一致'
    return
  }
  submitting.value = true
  try {
    const payload = {
      username: register.value.username,
      password: register.value.password,
      owner_id: Number(register.value.ownerId),
    }
    const resp = await fetch('/api/auth/dingtalk/register-and-bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      actionError.value = data?.error || '注册并绑定失败'
      return
    }
    if (data?.token) setStoredToken(data.token)
    window.location.href = data?.next || '/pending'
  } catch {
    actionError.value = '网络异常，请稍后重试'
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  try {
    await Promise.all([loadPendingBind(), loadOwners()])
  } catch (e) {
    loadError.value = e.message || '读取待绑定信息失败'
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.bind-page {
  max-width: 820px;
  margin: 40px auto;
  padding: 0 16px;
}
.card {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 16px;
  background: #fff;
}
.hint {
  margin-bottom: 12px;
  color: #374151;
}
.kv {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px dashed #e5e7eb;
}
.k {
  color: #6b7280;
}
.v {
  color: #111827;
  word-break: break-all;
}
.error {
  color: #b91c1c;
}
.actions a {
  display: inline-block;
  margin-top: 8px;
}
.next {
  margin-top: 12px;
  color: #374151;
}
.switch {
  margin-top: 14px;
  display: flex;
  gap: 8px;
}
.switch button {
  border: 1px solid #d1d5db;
  padding: 8px 12px;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
}
.switch button.active {
  background: #2563eb;
  color: #fff;
  border-color: #2563eb;
}
.form {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row input,
.row select {
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 9px 10px;
}
.form button {
  margin-top: 4px;
  border: none;
  border-radius: 8px;
  padding: 10px 12px;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
}
.form button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.action-error {
  margin-top: 10px;
}
</style>

