/**
 * 代理 URL 解析工具
 * 统一解析 HTTP_PROXY / HTTPS_PROXY，支持 socks5h、socks5、socks4、http、https
 * 设计原则：永不抛异常，解析失败返回 null，由调用方 fallback 到下一种请求方式
 */

const DEFAULT_PORT_SOCKS = 10809
const DEFAULT_PORT_HTTP = 80
const DEFAULT_PORT_HTTPS = 443

function normalizePort(val, defaultPort = DEFAULT_PORT_SOCKS) {
  if (val === '' || val === undefined || val === null) return defaultPort
  const n = typeof val === 'number' ? val : parseInt(String(val), 10)
  if (Number.isNaN(n) || n < 1 || n > 65535) return defaultPort
  return n
}

/**
 * 解析 host:port 格式，支持 IPv6 [::1]:10809
 * 不用 split(':')，因 IPv6 地址内含多个冒号
 */
function parseHostPort(v) {
  // [host]:port 格式（IPv6 bracket notation）
  const bracketMatch = v.match(/^\[([^\]]+)\]:(\d+)$/)
  if (bracketMatch) {
    return { host: bracketMatch[1], port: normalizePort(bracketMatch[2], DEFAULT_PORT_SOCKS) }
  }
  // 普通 host:port，取最后一个冒号作为分隔符
  const lastColon = v.lastIndexOf(':')
  if (lastColon > 0) {
    const host = v.slice(0, lastColon).trim()
    const portStr = v.slice(lastColon + 1).trim()
    if (host && portStr) {
      return { host, port: normalizePort(portStr, DEFAULT_PORT_SOCKS) }
    }
  }
  return null
}

/**
 * 解析代理 URL，返回 { scheme, host, port, raw }
 * 永不抛异常：任何非法字符串都 return null
 * @param {string} raw - 原始代理 URL，如 socks5h://127.0.0.1:10808
 * @returns {{ scheme: string, host: string, port: number, raw: string } | null}
 */
export function parseProxyUrl(raw) {
  if (!raw) return null
  const v = String(raw).trim()
  if (!v) return null

  // 显式协议（socks5h 由代理解析域名，与 socks5 同样按 SOCKS5 处理）
  if (v.startsWith('socks5h://') || v.startsWith('socks5://') || v.startsWith('socks4://')) {
    try {
      const u = new URL(v)
      const scheme = v.startsWith('socks4://') ? 'socks4' : 'socks5'
      return { scheme, host: u.hostname || '127.0.0.1', port: normalizePort(u.port, DEFAULT_PORT_SOCKS), raw: v }
    } catch (_) {
      return null
    }
  }
  if (v.startsWith('http://') || v.startsWith('https://')) {
    try {
      const u = new URL(v)
      const scheme = v.startsWith('https://') ? 'https' : 'http'
      const defaultPort = scheme === 'https' ? DEFAULT_PORT_HTTPS : DEFAULT_PORT_HTTP
      return { scheme, host: u.hostname || '127.0.0.1', port: normalizePort(u.port, defaultPort), raw: v }
    } catch (_) {
      return null
    }
  }

  // host:port 格式（无协议头），支持 IPv6 [::1]:10809
  if (v.includes(':')) {
    const parsed = parseHostPort(v)
    if (parsed) {
      return { scheme: 'auto', host: parsed.host, port: parsed.port, raw: v }
    }
  }

  return { scheme: 'auto', host: v || '127.0.0.1', port: DEFAULT_PORT_SOCKS, raw: v }
}

/**
 * 是否为 SOCKS 代理（socks5h / socks5 / socks4）
 */
export function isSocksProxy(proxyUrl) {
  if (!proxyUrl) return false
  const v = String(proxyUrl).trim()
  return v.startsWith('socks5h://') || v.startsWith('socks5://') || v.startsWith('socks4://')
}
