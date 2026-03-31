import { createRouter, createWebHistory } from 'vue-router'
import { authFetch } from '../utils/authFetch.js'

const Login = () => import('../views/Login.vue')
const Register = () => import('../views/Register.vue')
const Pending = () => import('../views/Pending.vue')
const Bind = () => import('../views/Bind.vue')
const Dashboard = () => import('../views/Dashboard.vue')
const RuleManager = () => import('../views/RuleManager.vue')
const Logs = () => import('../views/Logs.vue')
const SystemStatus = () => import('../views/SystemStatus.vue')
const AdminReview = () => import('../views/AdminReview.vue')
const AdminAccountMapping = () => import('../views/AdminAccountMapping.vue')
const AdminTemplates = () => import('../views/AdminTemplates.vue')

const MainLayout = () => import('../layouts/MainLayout.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: Login, meta: { requiresAuth: false } },
    { path: '/register', component: Register, meta: { requiresAuth: false } },
    { path: '/bind', component: Bind, meta: { requiresAuth: false } },
    { path: '/pending', component: Pending, meta: { requiresAuth: true, allowPending: true } },

    {
      path: '/',
      component: MainLayout,
      meta: { requiresAuth: true, requiresActive: true },
      children: [
        { path: '', redirect: '/dashboard' },
        { path: 'dashboard', component: Dashboard },
        { path: 'rules', component: RuleManager },
        { path: 'logs', component: Logs },
        { path: 'system', component: SystemStatus, meta: { requiresAdmin: true } },
        { path: 'admin/review', component: AdminReview, meta: { requiresAdmin: true } },
        { path: 'admin/account-mapping', component: AdminAccountMapping, meta: { requiresAdmin: true } },
        { path: 'admin/templates', component: AdminTemplates, meta: { requiresAdmin: true } }
      ]
    },

    // 兼容旧路由
    { path: '/monitor', redirect: '/dashboard' }
  ]
})

router.beforeEach(async (to, from, next) => {
  const needAuth = to.meta.requiresAuth !== false
  let user = null
  try {
    const resp = await authFetch('/api/me')
    if (resp.ok) {
      const data = await resp.json()
      user = data.user
    }
  } catch {}

  if (!needAuth) {
    if (user) {
      if (user.status === 'pending') return next('/pending')
      if (user.status === 'active') return next('/dashboard')
    }
    return next()
  }

  if (!user) return next('/login')

  if (user.status === 'pending') {
    if (to.meta.allowPending) return next()
    return next('/pending')
  }

  if (to.meta.requiresActive && user.status !== 'active') return next('/login')
  
  const requiresAdmin = to.matched.some(record => record.meta.requiresAdmin)
  if (requiresAdmin && user.role !== 'admin') return next('/dashboard')

  next()
})

export default router
