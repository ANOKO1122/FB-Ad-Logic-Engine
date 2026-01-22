import { createApp } from 'vue'
import App from './App.vue'
import router from './router/index.js'
import './styles/variables.css' // 引入全局 CSS 变量与基础样式

const app = createApp(App)
app.use(router) // 暂不使用 Pinia，保持最小化修改
app.mount('#app')
