<template>
  <div class="pending-container">
    <div class="pending-card">
      <h1>等待审核</h1>
      <p class="desc">你的账号已注册成功，正在等待管理员审核。</p>
      <div class="info" v-if="user">
        <div>用户名：{{ user.username }}</div>
        <div>负责人：{{ user.owner_name || '-' }}</div>
        <div>状态：{{ user.status }}</div>
      </div>
      <div class="actions">
        <button class="btn" @click="refresh" :disabled="loading">{{ loading ? '检查中...' : '刷新状态' }}</button>
        <button class="btn btn-outline" @click="logout">退出登录</button>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'

export default {
  name: 'Pending',
  setup() {
    const router = useRouter()
    const user = ref(null)
    const loading = ref(false)

    const refresh = async () => {
      loading.value = true
      try {
        const resp = await fetch('/api/me', { credentials: 'include' })
        if (!resp.ok) return router.push('/login')
        const data = await resp.json()
        user.value = data.user
        if (data.user.status === 'active') router.push('/monitor')
      } finally {
        loading.value = false
      }
    }

    const logout = async () => {
      try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }) } catch {}
      router.push('/login')
    }

    onMounted(refresh)
    return { user, loading, refresh, logout }
  }
}
</script>

<style scoped>
.pending-container { min-height: 100vh; display:flex; align-items:center; justify-content:center; background:#f5f7fa; padding:20px; }
.pending-card { background:#fff; border-radius:12px; padding:40px; width:100%; max-width:520px; box-shadow:0 10px 40px rgba(0,0,0,.08); }
.desc { color:#666; margin: 8px 0 16px; }
.info { background:#f8f9fa; border-radius:8px; padding:12px; color:#333; margin-bottom:16px; }
.actions { display:flex; gap:12px; }
.btn { padding:10px 14px; border: none; border-radius:8px; background:#1877f2; color:#fff; cursor:pointer; }
.btn:disabled { opacity:.6; cursor:not-allowed; }
.btn-outline { background:#fff; color:#333; border:1px solid #ddd; }
</style>



