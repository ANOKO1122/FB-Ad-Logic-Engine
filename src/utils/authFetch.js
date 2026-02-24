/**
 * 带认证的 fetch 封装
 * 优先使用 sessionStorage 中的 token（Bearer），兼容 Cookie
 * 用于解决局域网 IP 访问时 Cookie 域不匹配导致的 401
 */

export function getStoredToken() {
  return sessionStorage.getItem('token')
}

export function setStoredToken(token) {
  if (token) {
    sessionStorage.setItem('token', token)
  } else {
    sessionStorage.removeItem('token')
  }
}

export function authFetch(url, options = {}) {
  const token = getStoredToken()
  const headers = { ...(options.headers || {}) }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return fetch(url, {
    ...options,
    headers,
    credentials: 'include'
  })
}
