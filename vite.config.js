import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',  // 允许局域网访问
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            const setCookie = proxyRes.headers['set-cookie']
            if (setCookie) {
              proxyRes.headers['set-cookie'] = setCookie.map((c) =>
                c.replace(/;\s*domain=[^;]+/gi, '')
              )
            }
          })
        }
      }
    }
  }
})
