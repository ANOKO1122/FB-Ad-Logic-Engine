import { createRouter, createWebHistory } from 'vue-router'

const Login = () => import('../views/Login.vue')
const Register = () => import('../views/Register.vue')
const Pending = () => import('../views/Pending.vue')
const Dashboard = () => import('../views/Dashboard.vue')
const RuleManager = () => import('../views/RuleManager.vue') // 引入新组件
const AdminReview = () => import('../views/AdminReview.vue')
const AdminAccountMapping = () => import('../views/AdminAccountMapping.vue')

const MainLayout = () => import('../layouts/MainLayout.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: Login, meta: { requiresAuth: false } },
    { path: '/register', component: Register, meta: { requiresAuth: false } },
    { path: '/pending', component: Pending, meta: { requiresAuth: true, allowPending: true } },

    {
      path: '/',
      component: MainLayout,
      meta: { requiresAuth: true, requiresActive: true },
      children: [
        { path: '', redirect: '/dashboard' },
        { path: 'dashboard', component: Dashboard },
        { path: 'rules', component: RuleManager }, // 指向新组件
        { path: 'admin/review', component: AdminReview, meta: { requiresAdmin: true } },
        { path: 'admin/account-mapping', component: AdminAccountMapping, meta: { requiresAdmin: true } }
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
    const resp = await fetch('/api/me', { credentials: 'include' })
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
