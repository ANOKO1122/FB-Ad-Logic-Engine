<template>
  <div class="auth-container">
    <div class="auth-card">
      <h1>登录</h1>
      <p class="subtitle">Facebook 广告监控系统</p>

      <div v-if="loadingAuthOptions" class="gate-card">
        <div class="gate-title">正在检查登录方式...</div>
        <div class="gate-desc">请稍候，系统正在确认是否需要先走钉钉门禁。</div>
      </div>

      <div v-else-if="dingtalkGateEnabled" class="gate-card">
        <div v-if="dingtalkEnabled">
          <div class="gate-title">正在跳转到钉钉验证...</div>
          <div class="gate-desc">
            本系统仅对公司内部在职员工开放。若浏览器未自动跳转，请点击下方按钮继续。
          </div>
          <a class="btn btn-secondary" href="/api/auth/dingtalk/login">继续前往钉钉扫码登录</a>
        </div>
        <div v-else>
          <div class="gate-title">门禁模式已开启，但钉钉入口未开放</div>
          <div class="gate-desc">
            当前公开用户名密码登录已关闭，但钉钉登录开关未开启。请联系管理员检查
            `ENABLE_DINGTALK_AUTH` 配置。
          </div>
        </div>
      </div>

      <form v-else @submit.prevent="handleLogin" class="auth-form">
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

      <div v-if="!loadingAuthOptions && !dingtalkGateEnabled" class="divider"></div>

      <div v-if="!loadingAuthOptions && !dingtalkGateEnabled" class="alt-login">
        <a v-if="dingtalkEnabled" class="btn btn-secondary" href="/api/auth/dingtalk/login">钉钉扫码登录</a>
        <div v-else class="alt-hint">钉钉扫码登录暂未开放</div>
      </div>

      <div class="auth-footer">
        <router-link v-if="!loadingAuthOptions && !dingtalkGateEnabled" to="/register">还没有账号？立即注册</router-link>
      </div>
    </div>
  </div>
</template>

<script>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { setStoredToken } from '../utils/authFetch.js'

export default {
  name: 'Login',
  setup() {
    const router = useRouter()
    const username = ref('')
    const password = ref('')
    const error = ref('')
    const loading = ref(false)
    const dingtalkEnabled = ref(false)
    const dingtalkGateEnabled = ref(false)
    const loadingAuthOptions = ref(true)

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
        if (data.token) setStoredToken(data.token)
        if (data.user.status === 'pending') router.push('/pending')
        else router.push('/monitor')
      } catch (e) {
        error.value = '网络错误，请稍后重试'
      } finally {
        loading.value = false
      }
    }

    const loadAuthOptions = async () => {
      try {
        const resp = await fetch('/api/auth/options', { credentials: 'include' })
        const data = await resp.json().catch(() => ({}))
        dingtalkEnabled.value = !!data?.dingtalkEnabled
        dingtalkGateEnabled.value = !!data?.dingtalkGateEnabled
      } catch {
        dingtalkEnabled.value = false
        dingtalkGateEnabled.value = false
      } finally {
        loadingAuthOptions.value = false
      }
    }

    onMounted(async () => {
      await loadAuthOptions()
      if (dingtalkGateEnabled.value && dingtalkEnabled.value) {
        window.location.replace('/api/auth/dingtalk/login')
      }
    })

    return {
      username,
      password,
      error,
      loading,
      handleLogin,
      dingtalkEnabled,
      dingtalkGateEnabled,
      loadingAuthOptions,
    }
  }
}
</script>

<style scoped>
.auth-container { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg,#1877f2 0%,#42389d 100%); padding: 20px; }
.auth-card { background: #fff; border-radius: 12px; padding: 40px; width: 100%; max-width: 400px; box-shadow: 0 10px 40px rgba(0,0,0,.2); }
h1 { margin: 0 0 8px; color: #1877f2; text-align: center; }
.subtitle { color: #666; text-align: center; margin-bottom: 24px; }
.gate-card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px; background: #f9fafb; margin-bottom: 16px; }
.gate-title { font-weight: 700; color: #111827; margin-bottom: 6px; }
.gate-desc { font-size: 13px; color: #374151; line-height: 1.6; margin-bottom: 10px; }
.auth-form { display: flex; flex-direction: column; gap: 16px; }
.form-group { display: flex; flex-direction: column; gap: 8px; }
input { padding: 12px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; }
.error-message { background: #fff2f2; color: #e41e3f; padding: 10px 12px; border-radius: 8px; font-size: 14px; }
.btn { padding: 12px 16px; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
.btn-primary { background: #1877f2; color: #fff; }
.btn-primary:disabled { opacity: .6; cursor: not-allowed; }
.btn-secondary { background: #111827; color: #fff; text-align: center; text-decoration: none; display: inline-block; width: 100%; }
.btn-secondary.disabled { opacity: 0.6; cursor: not-allowed; pointer-events: none; }
.divider { margin: 16px 0; height: 1px; background: #eee; }
.alt-login { display: flex; flex-direction: column; gap: 8px; }
.alt-hint { font-size: 13px; color: #6b7280; text-align: center; }
.auth-footer { margin-top: 16px; text-align: center; }
</style>



