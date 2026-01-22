<template>
  <div class="auth-container">
    <div class="auth-card">
      <h1>登录</h1>
      <p class="subtitle">Facebook 广告监控系统</p>

      <form @submit.prevent="handleLogin" class="auth-form">
        <div class="form-group">
          <label>用户名</label>
          <input v-model="username" type="text" required placeholder="请输入用户名" />
        </div>

        <div class="form-group">
          <label>密码</label>
          <input v-model="password" type="password" required placeholder="请输入密码" />
        </div>

        <div v-if="error" class="error-message">{{ error }}</div>

        <button class="btn btn-primary" :disabled="loading" type="submit">
          {{ loading ? '登录中...' : '登录' }}
        </button>
      </form>

      <div class="auth-footer">
        <router-link to="/register">还没有账号？立即注册</router-link>
      </div>
    </div>
  </div>
</template>

<script>
import { ref } from 'vue'
import { useRouter } from 'vue-router'

export default {
  name: 'Login',
  setup() {
    const router = useRouter()
    const username = ref('')
    const password = ref('')
    const error = ref('')
    const loading = ref(false)

    const handleLogin = async () => {
      error.value = ''
      loading.value = true
      try {
        const resp = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username: username.value, password: password.value })
        })
        const data = await resp.json()
        if (!resp.ok) {
          error.value = data.error || '登录失败'
          return
        }
        if (data.user.status === 'pending') router.push('/pending')
        else router.push('/monitor')
      } catch (e) {
        error.value = '网络错误，请稍后重试'
      } finally {
        loading.value = false
      }
    }

    return { username, password, error, loading, handleLogin }
  }
}
</script>

<style scoped>
.auth-container { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg,#1877f2 0%,#42389d 100%); padding: 20px; }
.auth-card { background: #fff; border-radius: 12px; padding: 40px; width: 100%; max-width: 400px; box-shadow: 0 10px 40px rgba(0,0,0,.2); }
h1 { margin: 0 0 8px; color: #1877f2; text-align: center; }
.subtitle { color: #666; text-align: center; margin-bottom: 24px; }
.auth-form { display: flex; flex-direction: column; gap: 16px; }
.form-group { display: flex; flex-direction: column; gap: 8px; }
input { padding: 12px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; }
.error-message { background: #fff2f2; color: #e41e3f; padding: 10px 12px; border-radius: 8px; font-size: 14px; }
.btn { padding: 12px 16px; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
.btn-primary { background: #1877f2; color: #fff; }
.btn-primary:disabled { opacity: .6; cursor: not-allowed; }
.auth-footer { margin-top: 16px; text-align: center; }
</style>



