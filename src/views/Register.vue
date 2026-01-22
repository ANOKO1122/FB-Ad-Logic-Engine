<template>
  <div class="auth-container">
    <div class="auth-card">
      <h1>注册账号</h1>
      <p class="subtitle">注册后需管理员审核</p>

      <form @submit.prevent="handleRegister" class="auth-form">
        <div class="form-group">
          <label>用户名</label>
          <input v-model="username" type="text" required placeholder="2-50 个字符" />
        </div>

        <div class="form-group">
          <label>密码</label>
          <input v-model="password" type="password" required placeholder="至少 6 位" />
        </div>

        <div class="form-group">
          <label>确认密码</label>
          <input v-model="confirmPassword" type="password" required placeholder="再次输入密码" />
        </div>

        <div class="form-group">
          <label>选择负责人</label>
          <select v-model="ownerId" required>
            <option value="">请选择负责人</option>
            <option v-for="o in owners" :key="o.id" :value="o.id">{{ o.owner_name }}</option>
          </select>
        </div>

        <div v-if="error" class="error-message">{{ error }}</div>
        <div v-if="success" class="success-message">{{ success }}</div>

        <button class="btn btn-primary" :disabled="loading" type="submit">
          {{ loading ? '注册中...' : '注册' }}
        </button>
      </form>

      <div class="auth-footer">
        <router-link to="/login">已有账号？立即登录</router-link>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'

export default {
  name: 'Register',
  setup() {
    const router = useRouter()
    const username = ref('')
    const password = ref('')
    const confirmPassword = ref('')
    const ownerId = ref('')
    const owners = ref([])
    const error = ref('')
    const success = ref('')
    const loading = ref(false)

    const loadOwners = async () => {
      try {
        const resp = await fetch('/api/owners')
        const data = await resp.json()
        owners.value = data.owners || []
      } catch {}
    }

    const handleRegister = async () => {
      error.value = ''
      success.value = ''
      if (password.value !== confirmPassword.value) {
        error.value = '两次密码不一致'
        return
      }
      if (!ownerId.value) {
        error.value = '请选择负责人'
        return
      }
      loading.value = true
      try {
        const resp = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.value, password: password.value, owner_id: parseInt(ownerId.value) })
        })
        const data = await resp.json()
        if (!resp.ok) {
          error.value = data.error || '注册失败'
          return
        }
        success.value = '注册成功，请等待管理员审核（3 秒后跳转登录）'
        setTimeout(() => router.push('/login'), 3000)
      } catch (e) {
        error.value = '网络错误'
      } finally {
        loading.value = false
      }
    }

    onMounted(loadOwners)
    return { username, password, confirmPassword, ownerId, owners, error, success, loading, handleRegister }
  }
}
</script>

<style scoped>
.auth-container { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg,#1877f2 0%,#42389d 100%); padding: 20px; }
.auth-card { background: #fff; border-radius: 12px; padding: 40px; width: 100%; max-width: 420px; box-shadow: 0 10px 40px rgba(0,0,0,.2); }
h1 { margin: 0 0 8px; color: #1877f2; text-align: center; }
.subtitle { color: #666; text-align: center; margin-bottom: 24px; }
.auth-form { display: flex; flex-direction: column; gap: 16px; }
.form-group { display: flex; flex-direction: column; gap: 8px; }
input,select { padding: 12px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; }
.error-message { background: #fff2f2; color: #e41e3f; padding: 10px 12px; border-radius: 8px; font-size: 14px; }
.success-message { background: #f0fff4; color: #0d7a0d; padding: 10px 12px; border-radius: 8px; font-size: 14px; }
.btn { padding: 12px 16px; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
.btn-primary { background: #1877f2; color: #fff; }
.btn-primary:disabled { opacity: .6; cursor: not-allowed; }
.auth-footer { margin-top: 16px; text-align: center; }
</style>



