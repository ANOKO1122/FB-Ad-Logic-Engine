// Facebook Marketing API 客户端类和规则引擎类
// 注意：这个文件现在只包含业务逻辑类，不包含 Express 应用配置
import axios from 'axios'
import https from 'https'
import http from 'http'
import tls from 'tls'
import net from 'net'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { fileURLToPath } from 'url'
import { recordRequest } from './utils/tlsErrorMonitor.js'
import { dirname, join } from 'path'
import { requestViaSocks5 } from './socks5.js'
import pool from './db/connection.js'
import { requireAuth, requireActive } from './middleware/authJwt.js'
import app from './app.js'  // 导入 Express 应用对象
import { 
  parseUsageHeader, 
  sleepBasedOnUsage, 
  fetchWithTimeout,
  checkTokenError,
  recordSuccess,
  getCircuitBreakerStatus
} from './services/rateLimitService.js'
import { queryRuleData, getAccountTimezone } from './services/ruleDataService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 注意：dotenv.config() 已移到 server.js

// 代理协议探测缓存：host:port -> 'socks5' | 'http'
const proxyProtocolCache = new Map()

function parseProxyUrl(raw) {
  if (!raw) return null
  const v = String(raw).trim()

  // 显式协议
  if (v.startsWith('socks5://') || v.startsWith('socks4://')) {
    const u = new URL(v)
    return { scheme: v.startsWith('socks5://') ? 'socks5' : 'socks4', host: u.hostname, port: Number(u.port || 10809), raw: v }
  }
  if (v.startsWith('http://') || v.startsWith('https://')) {
    const u = new URL(v)
    return { scheme: 'http', host: u.hostname, port: Number(u.port || 10809), raw: v }
  }

  // host:port 或其它（默认 auto）
  if (v.includes(':')) {
    const [host, port] = v.split(':')
    return { scheme: 'auto', host: host || '127.0.0.1', port: Number(port || 10809), raw: v }
  }

  return { scheme: 'auto', host: v || '127.0.0.1', port: 10809, raw: v }
}

async function detectProxyProtocol(host, port) {
  const key = `${host}:${port}`
  const cached = proxyProtocolCache.get(key)
  if (cached) return cached

  // 先探测 SOCKS5：发送 0x05 0x01 0x00，期待返回 0x05 <method>
  const isSocks5 = await new Promise((resolve) => {
    const s = net.createConnection(port, host)
    const timer = setTimeout(() => {
      try { s.destroy() } catch {}
      resolve(false)
    }, 1500)

    s.on('connect', () => {
      try { s.write(Buffer.from([0x05, 0x01, 0x00])) } catch {}
    })
    s.on('data', (buf) => {
      clearTimeout(timer)
      const ok = buf && buf.length >= 2 && buf[0] === 0x05 && buf[1] !== 0xff
      try { s.destroy() } catch {}
      resolve(ok)
    })
    s.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })

  const protocol = isSocks5 ? 'socks5' : 'http'
  proxyProtocolCache.set(key, protocol)
  return protocol
}

// 注意：全局代理环境变量设置已移到 server.js

// 注意：Express 应用配置已移到 app.js
const FACEBOOK_API_VERSION = 'v24.0'
const FACEBOOK_API_BASE = `https://graph.facebook.com/${FACEBOOK_API_VERSION}`

// Facebook API 客户端类
class FacebookMarketingAPI {
  constructor(accessToken) {
    this.accessToken = accessToken
  }

  async getAdAccounts() {
    try {
      let url = `${FACEBOOK_API_BASE}/me/adaccounts`
      let params = {
        fields: 'id,name,account_id',
        limit: 200,
        access_token: this.accessToken
      }

      console.log('📡 请求Facebook API(分页):', url)
      console.log('📋 参数: fields=id,name,account_id, limit=200')

      const all = []
      const seen = new Set()
      let page = 0

      while (url) {
        page += 1
        const data = await this.makeRequest(url, params, 'GET')
        const pageAccounts = this.processAccountsResponse(data, `page_${page}`)
        for (const acc of pageAccounts) {
          const key = String(acc.id || acc.account_id || '').trim()
          if (!key || seen.has(key)) continue
          seen.add(key)
          all.push(acc)
        }

        // 下一页：paging.next 通常是完整 URL（自带 query），此时 params 置空避免重复拼接
        url = data?.paging?.next || null
        params = {} // next URL 已包含必要参数
      }

      console.log(`✅ 分页汇总后广告账户数: ${all.length}`)
      return all
      
    } catch (error) {
      console.error('❌ 获取广告账户失败:', error.message)
      console.error('❌ 错误堆栈:', error.stack)
      throw new Error(`网络连接失败: ${error.message}. 请检查网络连接、防火墙或代理设置。`)
    }
  }
  
  processAccountsResponse(data, method = '') {
    if (data.error) {
      console.error('❌ Facebook API错误:', JSON.stringify(data.error, null, 2))
      throw new Error(`Facebook API错误: ${data.error.message} (错误代码: ${data.error.code || 'N/A'}, 类型: ${data.error.type || 'N/A'})`)
    }
    
    const accounts = (data.data || []).map(account => ({
      id: account.id || account.account_id,
      name: account.name || `广告账户 ${account.account_id || account.id}`,
      account_id: account.account_id || account.id
    }))
    
    const methodText = method ? `（使用${method}）` : ''
    console.log(`✅ 成功获取 ${accounts.length} 个广告账户${methodText}`)
    return accounts
  }

  /**
   * 获取账户时区（两步拉取：流派2）
   * 为什么需要这个函数？
   * - Facebook API 的账户时区是最可靠的来源（比数据库配置更准确）
   * - 在拉取 insights 前先获取时区，确保 time_range 计算与账户时区对齐
   * - 写入时把 timezone_name 落库，便于后续"数据时区优先"查询
   * 
   * @param {string} accountId - Facebook 账户ID
   * @returns {Promise<string>} 账户时区（如 'Asia/Shanghai'），失败时返回 'UTC'
   * 
   * @example
   * const timezone = await facebookApi.getAccountTimezone('act_123')
   * // 返回: 'Asia/Shanghai'
   */
  async getAccountTimezone(accountId) {
    try {
      // 第1-3行：构造请求 URL 和参数
      // Facebook Graph API：/{account_id}?fields=timezone_name
      // 注意：accountId 需要包含 'act_' 前缀
      const url = `${FACEBOOK_API_BASE}/${accountId}`
      const params = {
        fields: 'timezone_name',
        access_token: this.accessToken
      }
      
      console.log(`📡 获取账户 ${accountId} 的时区...`)
      
      // 第4-5行：发送请求
      const data = await this.makeRequest(url, params, 'GET')
      
      // 第6-7行：检查错误
      if (data.error) {
        console.warn(`⚠️  获取账户 ${accountId} 时区失败:`, data.error.message)
        return 'UTC'  // 失败时返回默认时区
      }
      
      // 第8-10行：提取时区名称
      const timezoneName = data.timezone_name || 'UTC'
      console.log(`✅ 账户 ${accountId} 时区: ${timezoneName}`)
      
      return timezoneName
    } catch (error) {
      // 第11-12行：如果请求失败，记录警告但返回默认时区（优雅降级）
      console.warn(`⚠️  获取账户 ${accountId} 时区失败，使用默认 UTC:`, error.message)
      return 'UTC'
    }
  }

  // 通用请求方法：尝试多种方式发送请求，包括代理
  // @param {string} url - 请求 URL
  // @param {Object} params - 请求参数
  // @param {string} method - HTTP 方法（GET/POST）
  // @param {Object|null} body - 请求体（POST 请求）
  // @param {Object} options - 选项：{ returnHeaders: boolean, timeout: number }
  // @returns {Promise<Object|{data: Object, headers: Object}>} 响应数据或包含响应头的对象
  async makeRequest(url, params, method = 'GET', body = null, options = {}) {
    const { returnHeaders = false, timeout = 45000 } = options
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
    
    // 检查 Token 熔断器状态（使用静态导入，避免动态导入导致的问题）
    const breakerStatus = getCircuitBreakerStatus()
    if (breakerStatus.isLocked) {
      throw new Error('Token 已失效，系统已自动锁定。请检查 Token 配置并手动重置熔断器。')
    }

    // 方法1: 如果配置了代理，则先探测该端口到底是 SOCKS5 还是 HTTP 代理，避免 protocol mismatch
    if (proxyUrl) {
      const info = parseProxyUrl(proxyUrl)
      if (info) {
        let scheme = info.scheme
        if (scheme === 'auto') {
          scheme = await detectProxyProtocol(info.host, info.port)
          console.log(`🔎 代理协议探测结果: ${info.host}:${info.port} => ${scheme}`)
        }

        if (scheme === 'socks5' || scheme === 'socks4') {
          const socksUrl = info.raw.startsWith('socks') ? info.raw : `socks5://${info.host}:${info.port}`
          try {
            console.log(`🔄 使用SOCKS代理: ${socksUrl}`)
            return await requestViaSocks5(url, params, socksUrl, method, body)
          } catch (socks5Error) {
            console.warn('⚠️ 原生SOCKS实现失败:', socks5Error.message)
            // 只有在明确是 socks URL 时才允许 socks-proxy-agent 兜底，避免对 HTTP 端口造成 protocol mismatch
            try {
              console.log(`🔄 尝试使用socks-proxy-agent: ${socksUrl}`)
              const agent = new SocksProxyAgent(socksUrl, { timeout: timeout })
              const config = { params, httpsAgent: agent, httpAgent: agent, timeout: timeout }
              
              const requestPromise = method === 'POST' 
                ? axios.post(url, body, config) 
                : axios.get(url, config)
              
              const resp = await fetchWithTimeout(requestPromise, timeout)
              
              // 检查 Token 错误
              if (resp.data?.error) {
                checkTokenError(resp.data)
              } else {
                recordSuccess()
              }
              
              // 解析响应头并动态休眠（如果返回响应头）
              if (returnHeaders && resp.headers) {
                const usageHeader = resp.headers['x-business-use-case-usage'] || resp.headers['x-business-use-case-usage'.toLowerCase()]
                if (usageHeader) {
                  const usageInfo = parseUsageHeader(usageHeader)
                  await sleepBasedOnUsage(usageInfo)
                }
              }
              
              console.log('✅ socks-proxy-agent 请求成功')
              return returnHeaders ? { data: resp.data, headers: resp.headers } : resp.data
            } catch (socksError) {
              // 检查是否是 Token 错误
              checkTokenError(socksError)
              console.warn('⚠️ socks-proxy-agent 也失败:', socksError.message)
              throw socksError
            }
          }
        } else {
          // HTTP 代理：优先 CONNECT 隧道 / https-proxy-agent
          try {
            console.log('🔄 使用HTTP代理（CONNECT隧道）...')
            return await this.requestViaHttpProxy(url, params, `http://${info.host}:${info.port}`, method, body)
          } catch (proxyError) {
            console.warn('⚠️ HTTP代理隧道失败:', proxyError.message)
          }
        }
      }
    }
    
    // 方法3: 尝试使用axios with HTTP代理agent
    if (proxyUrl && !proxyUrl.includes('socks5://') && !proxyUrl.includes('socks4://')) {
      try {
        let httpProxyUrl = proxyUrl
        if (!httpProxyUrl.startsWith('http://') && !httpProxyUrl.startsWith('https://')) {
          httpProxyUrl = `http://${httpProxyUrl}`
        }
        const agent = new HttpsProxyAgent(httpProxyUrl)
        const config = {
          params,
          httpsAgent: agent,
          httpAgent: agent,
          timeout: timeout
        }
        
        const requestPromise = method === 'POST' 
          ? axios.post(url, body, config) 
          : axios.get(url, config)
        
        const response = await fetchWithTimeout(requestPromise, timeout)
        
        // 检查 Token 错误
        if (response.data?.error) {
          checkTokenError(response.data)
        } else {
          recordSuccess()
        }
        
        // 解析响应头并动态休眠（如果返回响应头）
        if (returnHeaders && response.headers) {
          const usageHeader = response.headers['x-business-use-case-usage'] || response.headers['x-business-use-case-usage'.toLowerCase()]
          if (usageHeader) {
            const usageInfo = parseUsageHeader(usageHeader)
            await sleepBasedOnUsage(usageInfo)
          }
        }
        
        return returnHeaders ? { data: response.data, headers: response.headers } : response.data
      } catch (httpError) {
        console.warn('⚠️ HTTP代理agent失败:', httpError.message)
      }
    }
    
    // 方法4: 尝试使用原生fetch（Node.js 18+，会自动使用系统代理）
    if (typeof fetch !== 'undefined') {
      try {
        const queryString = new URLSearchParams(params).toString()
        const fullUrl = `${url}?${queryString}`
        console.log('🔄 尝试使用原生fetch（自动使用系统代理）...')
        
        const fetchOptions = {
          method: method,
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(timeout)
        }
        if (method === 'POST' && body) {
          fetchOptions.headers['Content-Type'] = 'application/json'
          fetchOptions.body = JSON.stringify(body)
        }
        
        const fetchPromise = fetch(fullUrl, fetchOptions)
        const response = await fetchWithTimeout(fetchPromise, timeout)
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          checkTokenError(errorData)
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }
        
        const data = await response.json()
        
        // 检查 Token 错误
        if (data?.error) {
          checkTokenError(data)
        } else {
          recordSuccess()
        }
        
        // 解析响应头并动态休眠（如果返回响应头）
        if (returnHeaders && response.headers) {
          const usageHeader = response.headers.get('x-business-use-case-usage')
          if (usageHeader) {
            const usageInfo = parseUsageHeader(usageHeader)
            await sleepBasedOnUsage(usageInfo)
          }
        }
        
        return returnHeaders ? { data, headers: Object.fromEntries(response.headers.entries()) } : data
      } catch (fetchError) {
        console.warn('⚠️ 原生fetch失败:', fetchError.message)
      }
    }
    
    // 方法5: 最后尝试直接使用axios（不配置agent，依赖系统代理）
    console.log('🔄 尝试使用axios（依赖系统代理）...')
    const config = {
      params,
      timeout: timeout
    }
    
    const requestPromise = method === 'POST' 
      ? axios.post(url, body, config) 
      : axios.get(url, config)
    
    const response = await fetchWithTimeout(requestPromise, timeout)
    
    // 检查 Token 错误
    if (response.data?.error) {
      checkTokenError(response.data)
    } else {
      recordSuccess()
    }
    
    // 解析响应头并动态休眠（如果返回响应头）
    if (returnHeaders && response.headers) {
      const usageHeader = response.headers['x-business-use-case-usage'] || response.headers['x-business-use-case-usage'.toLowerCase()]
      if (usageHeader) {
        const usageInfo = parseUsageHeader(usageHeader)
        await sleepBasedOnUsage(usageInfo)
      }
    }
    
    return returnHeaders ? { data: response.data, headers: response.headers } : response.data
  }

  // 使用原生HTTP模块通过代理发送请求（最可靠的方法）
  async requestViaHttpProxy(targetUrl, params, proxyUrl, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      try {
        // 解析代理URL
        let proxyHost = '127.0.0.1'
        let proxyPort = 10809
        
        if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
          const urlObj = new URL(proxyUrl)
          proxyHost = urlObj.hostname
          proxyPort = parseInt(urlObj.port) || 10809
        } else if (proxyUrl.includes(':')) {
          const parts = proxyUrl.split(':')
          proxyHost = parts[0]
          proxyPort = parseInt(parts[1]) || 10809
        }
        
        // 解析目标URL
        const targetUrlObj = new URL(targetUrl)
        const targetHost = targetUrlObj.hostname
        const targetPort = targetUrlObj.port || 443
        
        console.log(`🔗 通过HTTP代理建立隧道: ${proxyHost}:${proxyPort} -> ${targetHost}:${targetPort}`)
        
        // 构建查询字符串和路径
        const queryString = new URLSearchParams(params).toString()
        const path = queryString ? `${targetUrlObj.pathname}?${queryString}` : targetUrlObj.pathname
        
        // 连接到代理服务器，使用CONNECT方法建立隧道
        console.log(`📡 正在连接到代理服务器 ${proxyHost}:${proxyPort}...`)
        const proxyReq = http.request({
          host: proxyHost,
          port: proxyPort,
          method: 'CONNECT',
          path: `${targetHost}:${targetPort}`,
          headers: {
            'Host': `${targetHost}:${targetPort}`,
            'Proxy-Connection': 'keep-alive',
            'Connection': 'keep-alive'
          },
          timeout: 10000
        }, (proxyRes) => {
          console.log(`📥 收到代理响应: ${proxyRes.statusCode} ${proxyRes.statusMessage}`)
          
          // 检查代理响应状态
          if (proxyRes.statusCode !== 200) {
            let errorBody = ''
            proxyRes.on('data', (chunk) => { errorBody += chunk })
            proxyRes.on('end', () => {
              console.error(`❌ 代理连接失败: ${proxyRes.statusCode} ${proxyRes.statusMessage}`)
              if (errorBody) {
                console.error(`❌ 错误详情: ${errorBody}`)
              }
              reject(new Error(`代理连接失败: ${proxyRes.statusCode} ${proxyRes.statusMessage}${errorBody ? ' - ' + errorBody : ''}`))
            })
            return
          }
          
          console.log('✅ 代理隧道建立成功')
          
          // 确保socket已准备好（CONNECT响应后，socket就是原始TCP连接）
          const tunnelSocket = proxyRes.socket
          
          // 监听socket错误
          tunnelSocket.on('error', (error) => {
            console.error('❌ 隧道socket错误:', error.message)
            reject(new Error(`隧道连接错误: ${error.message}`))
          })
          
          // 等待socket完全准备好（确保CONNECT响应已完全处理）
          // 使用setImmediate确保在下一个事件循环中执行
          setImmediate(() => {
            try {
              console.log('🔐 开始建立TLS连接...')
              
              // 在原始socket上建立TLS连接
              const tlsSocket = tls.connect({
                socket: tunnelSocket,
                host: targetHost,
                servername: targetHost,
                rejectUnauthorized: false
              }, () => {
                console.log('✅ TLS连接建立成功，开始发送HTTP请求...')
                
                // TLS连接建立后，发送HTTP请求
                const headers = {
                  'Host': targetHost,
                  'Accept': 'application/json',
                  'User-Agent': 'Node.js Facebook Marketing API Client',
                  'Connection': 'close'
                }
                
                if (method === 'POST' && body) {
                  headers['Content-Type'] = 'application/json'
                  const bodyStr = JSON.stringify(body)
                  headers['Content-Length'] = Buffer.byteLength(bodyStr)
                }
                
                // 构建HTTP请求（确保格式正确）
                let requestLine = `${method} ${path} HTTP/1.1\r\n`
                let headerLines = Object.entries(headers)
                  .map(([key, value]) => `${key}: ${value}\r\n`)
                  .join('')
                const httpRequest = requestLine + headerLines + '\r\n'
                
                console.log(`📤 发送HTTP请求: ${method} ${path}`)
                console.log(`📤 请求头大小: ${httpRequest.length} 字节`)
                
                // 先发送请求头
                tlsSocket.write(httpRequest)
                
                // 如果是POST请求，发送body
                if (method === 'POST' && body) {
                  const bodyStr = JSON.stringify(body)
                  console.log(`📤 请求体大小: ${bodyStr.length} 字节`)
                  tlsSocket.write(bodyStr)
                }
              })
              
              tlsSocket.on('error', (error) => {
                console.error('❌ TLS连接错误:', error.message)
                console.error('❌ 错误堆栈:', error.stack)
                
                // 记录 TLS 错误（用于监控）
                recordRequest(true)
                
                reject(new Error(`TLS连接失败: ${error.message}`))
              })
              
              // 接收HTTP响应 - 使用更可靠的方法
              let responseBuffer = Buffer.alloc(0)
              let responseHeaders = {}
              let responseBody = ''
              let isHeadersComplete = false
              let contentLength = null
              let isChunked = false
              
              tlsSocket.on('data', (chunk) => {
                responseBuffer = Buffer.concat([responseBuffer, chunk])
                
                if (!isHeadersComplete) {
                  // 查找HTTP响应头结束位置（\r\n\r\n）
                  const headerEnd = responseBuffer.indexOf(Buffer.from('\r\n\r\n'))
                  if (headerEnd !== -1) {
                    isHeadersComplete = true
                    const headerText = responseBuffer.subarray(0, headerEnd).toString('utf-8')
                    const bodyStart = headerEnd + 4
                    
                    // 解析响应头
                    const lines = headerText.split('\r\n')
                    const statusLine = lines[0]
                    const statusMatch = statusLine.match(/HTTP\/\d\.\d\s+(\d+)\s+(.+)/)
                    if (statusMatch) {
                      const statusCode = parseInt(statusMatch[1])
                      const statusMessage = statusMatch[2]
                      console.log(`📥 收到HTTP响应: ${statusCode} ${statusMessage}`)
                    }
                    
                    // 解析其他响应头
                    for (let i = 1; i < lines.length; i++) {
                      const colonIndex = lines[i].indexOf(':')
                      if (colonIndex !== -1) {
                        const key = lines[i].substring(0, colonIndex).trim().toLowerCase()
                        const value = lines[i].substring(colonIndex + 1).trim()
                        responseHeaders[key] = value
                        
                        if (key === 'content-length') {
                          contentLength = parseInt(value)
                        } else if (key === 'transfer-encoding' && value.toLowerCase() === 'chunked') {
                          isChunked = true
                        }
                      }
                    }
                    
                    // 提取响应体（如果有）
                    if (responseBuffer.length > bodyStart) {
                      const bodyChunk = responseBuffer.subarray(bodyStart)
                      responseBody += bodyChunk.toString('utf-8')
                    }
                  }
                } else {
                  // 继续接收响应体
                  responseBody += chunk.toString('utf-8')
                }
                
                // 如果知道内容长度，检查是否接收完成
                if (contentLength !== null && responseBody.length >= contentLength) {
                  responseBody = responseBody.substring(0, contentLength)
                  tlsSocket.end()
                }
              })
              
              tlsSocket.on('end', () => {
                console.log(`✅ 响应接收完成，总大小: ${responseBuffer.length} 字节，响应体: ${responseBody.length} 字节`)
                try {
                  if (!responseBody) {
                    console.error('❌ 收到空响应体')
                    reject(new Error('收到空响应'))
                    return
                  }
                  
                  // 尝试解析JSON
                  const jsonData = JSON.parse(responseBody)
                  console.log('✅ JSON解析成功')
                  
                  // 记录成功请求（用于监控）
                  recordRequest(false)
                  
                  resolve(jsonData)
                } catch (parseError) {
                  console.error('❌ JSON解析失败:', parseError.message)
                  console.error('❌ 响应数据（前1000字符）:', responseBody.substring(0, 1000))
                  reject(new Error(`解析响应失败: ${parseError.message}`))
                }
              })
              
              tlsSocket.setTimeout(60000, () => {
                console.error('❌ TLS连接超时（60秒）')
                tlsSocket.destroy()
                tunnelSocket.destroy()
                reject(new Error('TLS连接超时'))
              })
            } catch (error) {
              console.error('❌ 建立TLS连接时出错:', error.message)
              reject(error)
            }
          })
        })
        
        proxyReq.on('error', (error) => {
          console.error('❌ 代理请求错误:', error.message)
          console.error('❌ 错误代码:', error.code)
          console.error('❌ 错误堆栈:', error.stack)
          reject(new Error(`代理连接错误: ${error.message} (${error.code})`))
        })
        
        proxyReq.on('timeout', () => {
          console.error('❌ 代理连接超时（10秒）- timeout事件触发')
          proxyReq.destroy()
          reject(new Error('代理连接超时'))
        })
        
        // 添加socket连接事件监听
        proxyReq.on('socket', (socket) => {
          console.log('🔌 Socket已分配')
          socket.on('connect', () => {
            console.log('✅ Socket已连接到代理服务器')
          })
          socket.on('error', (error) => {
            console.error('❌ Socket错误:', error.message)
          })
          socket.on('timeout', () => {
            console.error('❌ Socket超时')
          })
        })
        
        proxyReq.setTimeout(10000, () => {
          console.error('❌ 代理连接超时（setTimeout触发）- 10秒内未收到响应')
          proxyReq.destroy()
          reject(new Error('代理连接超时：10秒内未收到代理服务器响应'))
        })
        
        console.log(`📤 发送CONNECT请求到代理: ${targetHost}:${targetPort}`)
        console.log(`📤 CONNECT请求路径: ${targetHost}:${targetPort}`)
        proxyReq.end()
      } catch (error) {
        reject(error)
      }
    })
  }

  async getAds(adAccountId) {
    try {
      const url = `${FACEBOOK_API_BASE}/${adAccountId}/ads`
      const params = {
        // 增加层级/状态字段，前端可展示更完整的广告详情
        fields: 'id,name,status,effective_status,configured_status,adset_id,campaign_id,creative{id,name}',
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, params, 'GET')
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return data.data || []
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`获取广告列表失败: ${error.message}`)
    }
  }

  async getAdInsights(adAccountId, timeRange = null, options = {}) {
    try {
      const url = `${FACEBOOK_API_BASE}/${adAccountId}/insights`
      // 支持动态层级：ad / adset / campaign（默认 ad）
      const level = options?.level || 'ad'
      const params = {
        // 增加 campaign / adset 层级信息，做到"广告层级广告详情"监控
        // 注意：这里保持"轻量字段"，避免超时；购买/漏斗等深度指标走 /api/roi
        fields: 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,impressions,clicks,spend,ctr,cpc,cpm',
        // 关键：默认 Graph API insights 返回的是 account 级别汇总；必须指定 level 才会返回对应层级数据
        level: level,
        // 优化性能：每页最多 200 条（Facebook API 允许的最大值），减少分页请求次数
        limit: 200,
        access_token: this.accessToken
      }
      
      if (timeRange?.since && timeRange?.until) {
        params.time_range = JSON.stringify({
          since: timeRange.since,
          until: timeRange.until
        })
      } else if (timeRange?.preset) {
        // 与广告管理工具口径更接近的预设时间范围（today / yesterday / last_7d / last_30d 等）
        params.date_preset = timeRange.preset
      } else {
        // 默认使用 today，避免“最近24小时”与 Ads Manager（通常按天）口径不一致
        params.date_preset = 'today'
      }

      // 对齐 Ads Manager 归因口径
      if (options?.useAccountAttributionSetting) {
        params.use_account_attribution_setting = true
      }
      if (Array.isArray(options?.actionAttributionWindows) && options.actionAttributionWindows.length > 0) {
        params.action_attribution_windows = options.actionAttributionWindows
      }

      // 处理分页：Facebook Insights API 可能返回多页数据
      // 为什么需要分页？账户下可能有大量广告，单次请求可能只返回部分数据
      const allInsights = []
      let currentUrl = url
      let currentParams = params
      
      while (currentUrl) {
        const data = await this.makeRequest(currentUrl, currentParams, 'GET')
        
        if (data.error) {
          throw new Error(`Facebook API Error: ${data.error.message}`)
        }

        // 添加当前页的数据
        const pageInsights = (data.data || []).map((item) => ({
          campaign_id: item.campaign_id,
          campaign_name: item.campaign_name,
          adset_id: item.adset_id,
          adset_name: item.adset_name,
          ad_id: item.ad_id,
          ad_name: item.ad_name,
          impressions: parseInt(item.impressions || '0'),
          clicks: parseInt(item.clicks || '0'),
          spend: parseFloat(item.spend || '0'),
          ctr: parseFloat(item.ctr || '0'),
          cpc: parseFloat(item.cpc || '0'),
          cpm: parseFloat(item.cpm || '0'),
          date_start: item.date_start,
          date_stop: item.date_stop
        }))
        
        allInsights.push(...pageInsights)
        
        // 检查是否有下一页
        currentUrl = data.paging?.next || null
        // 下一页是完整 URL，后续请求不用 params（next 已带 token），但为了安全仍带 token
        currentParams = { access_token: this.accessToken }
      }

      return allInsights
    } catch (error) {
      if (error.response?.data?.error) {
        throw new Error(`Facebook API Error: ${error.response.data.error.message}`)
      }
      throw error
    }
  }

  // 只统计 purchase（购买）作为转化（与需求一致）
  extractPurchaseCount(actions) {
    if (!actions || !Array.isArray(actions)) return 0
    const conversionActions = actions.filter((a) => {
      if (!a || !a.action_type) return false
      const t = String(a.action_type).toLowerCase()
      return t.includes('purchase')
    })
    return conversionActions.reduce((sum, a) => {
      const v = parseInt(a?.value || '0')
      return sum + (Number.isNaN(v) ? 0 : v)
    }, 0)
  }

  // 从数组中“选择一个最合适”的 action 值（避免重复 action_type 叠加导致倍率异常）
  pickActionValue(actions, { exact = [], contains = [] } = {}) {
    if (!actions || !Array.isArray(actions)) return 0
    const norm = (s) => String(s || '').toLowerCase()
    const list = actions
      .filter(a => a && a.action_type != null)
      .map(a => ({ type: norm(a.action_type), raw: a }))

    // 1) 精确匹配优先
    for (const t of exact.map(norm)) {
      const hit = list.find(x => x.type === t)
      if (hit) {
        const v = parseInt(hit.raw?.value || '0')
        return Number.isNaN(v) ? 0 : v
      }
    }

    // 2) 包含匹配兜底（取第一个命中的“优先级”项）
    for (const sub of contains.map(norm)) {
      const hit = list.find(x => x.type.includes(sub))
      if (hit) {
        const v = parseInt(hit.raw?.value || '0')
        return Number.isNaN(v) ? 0 : v
      }
    }

    // 3) 如果只有一个匹配项，返回它；多个匹配项避免相加，取最大值（更接近 Ads Manager 单一口径）
    if (contains.length > 0) {
      const hits = list.filter(x => contains.some(sub => x.type.includes(norm(sub))))
      if (hits.length === 1) {
        const v = parseInt(hits[0].raw?.value || '0')
        return Number.isNaN(v) ? 0 : v
      }
      if (hits.length > 1) {
        let mx = 0
        for (const h of hits) {
          const v = parseInt(h.raw?.value || '0')
          if (!Number.isNaN(v)) mx = Math.max(mx, v)
        }
        return mx
      }
    }

    return 0
  }

  pickActionAmount(actionValues, { exact = [], contains = [] } = {}) {
    if (!actionValues || !Array.isArray(actionValues)) return 0
    const norm = (s) => String(s || '').toLowerCase()
    const list = actionValues
      .filter(a => a && a.action_type != null)
      .map(a => ({ type: norm(a.action_type), raw: a }))

    for (const t of exact.map(norm)) {
      const hit = list.find(x => x.type === t)
      if (hit) {
        const v = parseFloat(hit.raw?.value || '0')
        return Number.isNaN(v) ? 0 : v
      }
    }

    for (const sub of contains.map(norm)) {
      const hit = list.find(x => x.type.includes(sub))
      if (hit) {
        const v = parseFloat(hit.raw?.value || '0')
        return Number.isNaN(v) ? 0 : v
      }
    }

    if (contains.length > 0) {
      const hits = list.filter(x => contains.some(sub => x.type.includes(norm(sub))))
      if (hits.length === 1) {
        const v = parseFloat(hits[0].raw?.value || '0')
        return Number.isNaN(v) ? 0 : v
      }
      if (hits.length > 1) {
        let mx = 0
        for (const h of hits) {
          const v = parseFloat(h.raw?.value || '0')
          if (!Number.isNaN(v)) mx = Math.max(mx, v)
        }
        return mx
      }
    }

    return 0
  }

  // 购买次数：优先使用最常见的 purchase 口径（避免把多个 purchase 变体加总）
  extractPurchaseCount(actions) {
    return this.pickActionValue(actions, {
      exact: [
        'offsite_conversion.fb_pixel_purchase',
        'purchase'
      ],
      contains: [
        'fb_pixel_purchase',
        '.purchase',
        'purchase'
      ]
    })
  }

  // 购买金额：同上逻辑（action_values）
  extractPurchaseAmount(actionValues) {
    return this.pickActionAmount(actionValues, {
      exact: [
        'offsite_conversion.fb_pixel_purchase',
        'purchase'
      ],
      contains: [
        'fb_pixel_purchase',
        '.purchase',
        'purchase'
      ]
    })
  }

  // cost_per_action_type：从数组里挑选某个 action_type 的官方“单次费用”
  pickCostPerActionType(costArr, { exact = [], contains = [] } = {}) {
    if (!costArr || !Array.isArray(costArr)) return null
    const norm = (s) => String(s || '').toLowerCase()
    const list = costArr
      .filter(a => a && a.action_type != null)
      .map(a => ({ type: norm(a.action_type), raw: a }))

    for (const t of exact.map(norm)) {
      const hit = list.find(x => x.type === t)
      if (hit) {
        const v = parseFloat(hit.raw?.value || '0')
        return Number.isNaN(v) ? null : v
      }
    }
    for (const sub of contains.map(norm)) {
      const hit = list.find(x => x.type.includes(sub))
      if (hit) {
        const v = parseFloat(hit.raw?.value || '0')
        return Number.isNaN(v) ? null : v
      }
    }
    return null
  }

  // 像素事件（网站）action_type 的“最常用”映射：用于对齐 Ads Manager 的「网站购物/加购/结账/支付信息」
  pixelActionTypes(eventKey) {
    const k = String(eventKey || '').toLowerCase()
    // 说明：
    // - Ads Manager 里“网站购物”通常对应 offsite_conversion.fb_pixel_purchase
    // - 同时保留少量兜底（purchase / omni_purchase 等）避免不同账户配置差异
    if (k === 'purchase') return {
      exact: ['offsite_conversion.fb_pixel_purchase', 'purchase', 'omni_purchase'],
      contains: ['fb_pixel_purchase', '.purchase', 'purchase']
    }
    if (k === 'add_to_cart') return {
      exact: ['offsite_conversion.fb_pixel_add_to_cart', 'add_to_cart'],
      contains: ['fb_pixel_add_to_cart', 'add_to_cart']
    }
    if (k === 'initiate_checkout') return {
      exact: ['offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout'],
      contains: ['fb_pixel_initiate_checkout', 'initiate_checkout']
    }
    if (k === 'add_payment_info') return {
      exact: ['offsite_conversion.fb_pixel_add_payment_info', 'add_payment_info'],
      contains: ['fb_pixel_add_payment_info', 'add_payment_info']
    }
    return { exact: [eventKey], contains: [eventKey] }
  }

  isInvalidFieldError(e) {
    const msg = String(e?.message || '')
    return (
      msg.toLowerCase().includes('nonexisting summary field') ||
      msg.toLowerCase().includes('unknown') ||
      msg.toLowerCase().includes('invalid') ||
      msg.toLowerCase().includes('unsupported') ||
      msg.toLowerCase().includes('field') && msg.toLowerCase().includes('does not exist')
    )
  }

  // ROI 深度指标：购买/加购/结账/支付 + 购买金额 + 独立链接点击（unique_actions 里提取 link_click）
  async getAdInsightsWithROI(adAccountId, timeRange = null, options = {}) {
    const url = `${FACEBOOK_API_BASE}/${adAccountId}/insights`
    const level = options?.level || 'ad'
    // 根据层级调整字段：adset/campaign 层级需要包含对应 id/name
    const idFields = level === 'adset' ? 'adset_id,adset_name' : (level === 'campaign' ? 'campaign_id,campaign_name' : 'ad_id,ad_name')
    const baseFields = `${idFields},actions,action_values,unique_actions,cost_per_action_type`
    const extraFields = 'cost_per_unique_link_click,cost_per_unique_inline_link_click,unique_inline_link_clicks'
    const params = {
      fields: `${baseFields},${extraFields}`,
      level: level,
      access_token: this.accessToken
    }
    if (timeRange?.since && timeRange?.until) {
      params.time_range = JSON.stringify({ since: timeRange.since, until: timeRange.until })
    } else if (timeRange?.preset) {
      params.date_preset = timeRange.preset
    } else {
      params.date_preset = 'today'
    }
    if (options?.useAccountAttributionSetting) params.use_account_attribution_setting = true
    if (Array.isArray(options?.actionAttributionWindows) && options.actionAttributionWindows.length) {
      params.action_attribution_windows = options.actionAttributionWindows
    }

    let data
    try {
      data = await this.makeRequest(url, params, 'GET')
      if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
    } catch (e) {
      // 有些账号/版本对部分字段不支持：降级为“最稳字段集”，保证接口可用
      if (this.isInvalidFieldError(e)) {
        const fallbackParams = { ...params, fields: baseFields }
        data = await this.makeRequest(url, fallbackParams, 'GET')
        if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
      } else {
        throw e
      }
    }

    return (data.data || []).map(item => {
      // 根据层级确定主键字段
      const idKey = level === 'adset' ? 'adset_id' : (level === 'campaign' ? 'campaign_id' : 'ad_id')
      const idValue = String(item[idKey] || '')
      return {
        [idKey]: idValue,
        // counts / values
        purchases: this.pickActionValue(item.actions, this.pixelActionTypes('purchase')),
        purchase_value: this.pickActionAmount(item.action_values, this.pixelActionTypes('purchase')),
        add_to_cart: this.pickActionValue(item.actions, this.pixelActionTypes('add_to_cart')),
        initiate_checkout: this.pickActionValue(item.actions, this.pixelActionTypes('initiate_checkout')),
        add_payment_info: this.pickActionValue(item.actions, this.pixelActionTypes('add_payment_info')),
        unique_link_clicks: this.pickActionValue(item.unique_actions, { exact: ['link_click'], contains: ['link_click'] }),

        // 官方费用字段（用于更贴近 Ads Manager）
        cpa: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('purchase')),
        cp_atc: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('add_to_cart')),
        cp_ic: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('initiate_checkout')),
        cp_api: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('add_payment_info')),

        // uCPC：Ads Manager “单次链接点击费用-独立用户”优先用官方 cost_per_unique_*（不同账户可能落在 link_click 或 inline_link_click）
        ucpc: (() => {
          const a = parseFloat(item?.cost_per_unique_link_click || '')
          if (!Number.isNaN(a) && a > 0) return a
          const b = parseFloat(item?.cost_per_unique_inline_link_click || '')
          if (!Number.isNaN(b) && b > 0) return b
          return null
        })(),
        unique_inline_link_clicks: (() => {
          const v = parseInt(item?.unique_inline_link_clicks || '0')
          return Number.isNaN(v) ? null : v
        })()
      }
    })
  }

  async startRoiAsyncJob(adAccountId, timeRange = null, options = {}) {
    const url = `${FACEBOOK_API_BASE}/${adAccountId}/insights`
    const level = options?.level || 'ad'
    // 根据层级调整字段：adset/campaign 层级需要包含对应 id/name
    const idFields = level === 'adset' ? 'adset_id,adset_name' : (level === 'campaign' ? 'campaign_id,campaign_name' : 'ad_id,ad_name')
    const baseFields = `${idFields},actions,action_values,unique_actions,cost_per_action_type`
    // 注意：cost_per_unique_link_click 在某些 report-run 场景会导致 (#100) nonexisting summary field，
    // 会让 /{report_run_id}/insights 直接 400，从而前端一直轮询失败。这里异步任务不请求它，避免“卡死”。
    const extraFields = 'cost_per_unique_inline_link_click,unique_inline_link_clicks'
    const params = {
      fields: `${baseFields},${extraFields}`,
      level: level,
      async: true,
      access_token: this.accessToken
    }
    if (timeRange?.since && timeRange?.until) {
      params.time_range = JSON.stringify({ since: timeRange.since, until: timeRange.until })
    } else if (timeRange?.preset) {
      params.date_preset = timeRange.preset
    } else {
      params.date_preset = 'today'
    }
    if (options?.useAccountAttributionSetting) params.use_account_attribution_setting = true
    if (Array.isArray(options?.actionAttributionWindows) && options.actionAttributionWindows.length) {
      params.action_attribution_windows = options.actionAttributionWindows
    }

    try {
      const data = await this.makeRequest(url, params, 'POST', null)
      if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
      return data.report_run_id || data.id
    } catch (e) {
      if (this.isInvalidFieldError(e)) {
        const fallbackParams = { ...params, fields: baseFields }
        const data = await this.makeRequest(url, fallbackParams, 'POST', null)
        if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
        return data.report_run_id || data.id
      }
      throw e
    }
  }

  async getReportRunStatus(reportRunId) {
    const url = `${FACEBOOK_API_BASE}/${reportRunId}`
    const params = { fields: 'async_status,async_percent_completion', access_token: this.accessToken }
    const data = await this.makeRequest(url, params, 'GET')
    if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
    const percent = parseInt(data.async_percent_completion || '0')
    return { status: data.async_status, percent: Number.isNaN(percent) ? 0 : percent }
  }

  async getReportRunInsightsAll(reportRunId) {
    let url = `${FACEBOOK_API_BASE}/${reportRunId}/insights`
    // report-run 的 insights 拉取：显式指定 fields，避免 FB 尝试返回某些“不存在的 summary 字段”导致 400
    const baseFields = 'ad_id,actions,action_values,unique_actions,cost_per_action_type'
    const extraFields = 'cost_per_unique_inline_link_click,unique_inline_link_clicks'
    const params = { limit: 500, fields: `${baseFields},${extraFields}`, access_token: this.accessToken }
    const rows = []
    while (url) {
      let data
      try {
        data = await this.makeRequest(url, params, 'GET')
        if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
      } catch (e) {
        // 若 report-run 不支持 extraFields，则降级回 baseFields，至少拿到购买/漏斗/官方 CPA
        if (this.isInvalidFieldError(e)) {
          const fallbackParams = { ...params, fields: baseFields }
          data = await this.makeRequest(url, fallbackParams, 'GET')
          if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`)
        } else {
          throw e
        }
      }
      rows.push(...(data.data || []))
      url = data.paging?.next || null
      // 下一页是完整 URL，后续请求不用 params（next 已带 token），但为了安全仍带 token
      params.access_token = this.accessToken
    }
    return rows
  }

  extractRoiFromInsights(rows, level = 'ad') {
    const out = {}
    // 根据层级确定主键字段
    const idKey = level === 'adset' ? 'adset_id' : (level === 'campaign' ? 'campaign_id' : 'ad_id')
    for (const item of rows || []) {
      const id = String(item[idKey] || '')
      if (!id) continue
      out[id] = {
        [idKey]: id,
        purchases: this.pickActionValue(item.actions, this.pixelActionTypes('purchase')),
        purchase_value: this.pickActionAmount(item.action_values, this.pixelActionTypes('purchase')),
        add_to_cart: this.pickActionValue(item.actions, this.pixelActionTypes('add_to_cart')),
        initiate_checkout: this.pickActionValue(item.actions, this.pixelActionTypes('initiate_checkout')),
        add_payment_info: this.pickActionValue(item.actions, this.pixelActionTypes('add_payment_info')),
        unique_link_clicks: this.pickActionValue(item.unique_actions, { exact: ['link_click'], contains: ['link_click'] }),

        cpa: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('purchase')),
        cp_atc: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('add_to_cart')),
        cp_ic: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('initiate_checkout')),
        cp_api: this.pickCostPerActionType(item.cost_per_action_type, this.pixelActionTypes('add_payment_info')),
        ucpc: (() => {
          const a = parseFloat(item?.cost_per_unique_link_click || '')
          if (!Number.isNaN(a) && a > 0) return a
          const b = parseFloat(item?.cost_per_unique_inline_link_click || '')
          if (!Number.isNaN(b) && b > 0) return b
          return null
        })(),
        unique_inline_link_clicks: (() => {
          const v = parseInt(item?.unique_inline_link_clicks || '0')
          return Number.isNaN(v) ? null : v
        })()
      }
    }
    return out
  }

  async pauseAd(adId) {
    try {
      const url = `${FACEBOOK_API_BASE}/${adId}`
      const params = {
        status: 'PAUSED',
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, params, 'POST', null)
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return !data.error
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`暂停广告失败: ${error.message}`)
    }
  }

  async activateAd(adId) {
    try {
      const url = `${FACEBOOK_API_BASE}/${adId}`
      const params = {
        status: 'ACTIVE',
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, params, 'POST', null)
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return !data.error
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`激活广告失败: ${error.message}`)
    }
  }

  async getAdsetBudget(adsetId) {
    try {
      const url = `${FACEBOOK_API_BASE}/${adsetId}`
      const params = {
        fields: 'daily_budget,lifetime_budget,budget_remaining',
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, params, 'GET')
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return parseFloat(data.daily_budget || data.lifetime_budget || '0')
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`获取广告组预算失败: ${error.message}`)
    }
  }

  async updateAdsetBudget(adsetId, newBudget, isDaily = true) {
    try {
      const url = `${FACEBOOK_API_BASE}/${adsetId}`
      const field = isDaily ? 'daily_budget' : 'lifetime_budget'
      const params = {
        [field]: newBudget,
        access_token: this.accessToken
      }
      const data = await this.makeRequest(url, params, 'POST', null)
      if (data.error) {
        throw new Error(`Facebook API Error: ${data.error.message}`)
      }
      return !data.error
    } catch (error) {
      if (error.message.includes('Facebook API Error')) {
        throw error
      }
      throw new Error(`更新广告组预算失败: ${error.message}`)
    }
  }
}

// 规则引擎类
class RuleEngine {
  constructor(api) {
    this.api = api
    // 第1行：保存 Facebook API 客户端（用于执行动作，如暂停广告、调整预算）
    // 注意：虽然规则评估改为从数据库查询，但动作执行仍需要调用 Facebook API
  }

  /**
   * 评估规则（增强版：支持从数据库查询数据、目标筛选、AND/OR 逻辑）
   * @param {Object} rule - 规则对象（包含 conditions, logic_operator, target_level, target_ids, timezone_name 等）
   * @param {string|Array} accountIdOrInsights - Facebook 账户ID（新版本）或 insights 数组（旧版本，兼容）
   * @param {Array} insightsOrAds - 可选：insights 数组（旧版本）或 ads 数组（旧版本，兼容）
   * @param {Array} ads - 可选：ads 数组（旧版本，兼容）
   * @returns {Promise<boolean|Array>} 旧版本返回 boolean，新版本返回匹配的广告数据数组
   * 
   * 【增强功能】
   * 1. 支持从数据库查询数据（完全离线）
   * 2. 支持 target_level 和 target_ids 筛选
   * 3. 支持 AND/OR 逻辑运算符
   * 4. 支持时间窗口（time_window）
   * 
   * 【向后兼容】
   * - 如果第一个参数是字符串（accountId），使用新版本（从数据库查询）
   * - 如果第一个参数是数组（insights），使用旧版本（从 Facebook API 数据评估）
   */
  async evaluateRule(rule, accountIdOrInsights, insightsOrAds = null, ads = null) {
    // 第1-5行：判断调用方式（新版本还是旧版本）
    // 如果第一个参数是字符串，说明是新版本（传入 accountId）
    // 如果第一个参数是数组，说明是旧版本（传入 insights）
    const isNewVersion = typeof accountIdOrInsights === 'string'
    
    if (!isNewVersion) {
      // 旧版本：使用 Facebook API 返回的数据（向后兼容）
      return this.evaluateRuleLegacy(rule, accountIdOrInsights, insightsOrAds)
    }

    // 新版本：从数据库查询数据
    const accountId = accountIdOrInsights
    const insights = null  // 新版本不使用 insights
    const adsParam = null  // 新版本不使用 ads
    // 第2-3行：检查规则是否启用（如果未启用，直接返回空数组）
    if (!rule.enabled) {
      return []
    }

    // 第4-5行：获取账户时区（用于时间窗口计算）
    // 如果规则中指定了 timezone_name，使用规则的时区；否则从数据库查询
    const timezoneName = rule.timezone_name || await getAccountTimezone(accountId)

    // 第6-20行：根据 target_level 和 target_ids 筛选目标广告ID
    // target_level: 'ad' | 'adset' | 'campaign'
    // target_ids: JSON 数组，存放目标 ID 列表
    let targetAdIds = []
    
    if (rule.target_level && rule.target_ids && Array.isArray(rule.target_ids) && rule.target_ids.length > 0) {
      // 如果指定了 target_level 和 target_ids，使用指定的目标
      if (rule.target_level === 'ad') {
        // 目标层级是广告，直接使用 target_ids
        targetAdIds = rule.target_ids.map(id => String(id))
      } else {
        // 目标层级是广告组或广告系列，需要查询对应的广告ID
        // TODO: 实现从 adset_id 或 campaign_id 查询 ad_id 的逻辑
        // 暂时使用兼容方案：如果提供了 ads 参数，从中筛选
        if (ads && Array.isArray(ads)) {
          targetAdIds = ads
            .filter(ad => {
              if (rule.target_level === 'adset') {
                return rule.target_ids.includes(String(ad.adset_id || ''))
              } else if (rule.target_level === 'campaign') {
                return rule.target_ids.includes(String(ad.campaign_id || ''))
              }
              return false
            })
            .map(ad => String(ad.id || ad.ad_id || ''))
            .filter(id => id)
        }
      }
    } else {
      // 如果没有指定 target_ids，查询账户下所有广告（从数据库）
      // 从 ad_snapshots 表查询该账户下的所有广告ID（取最新的快照）
      try {
        // 使用 GROUP BY 获取每个广告的最新快照（兼容所有 MySQL 版本）
        const [rows] = await pool.execute(`
          SELECT s.ad_id
          FROM ad_snapshots s
          INNER JOIN (
            SELECT ad_id, MAX(synced_at) as max_synced_at
            FROM ad_snapshots
            WHERE account_id = ?
            GROUP BY ad_id
          ) t
          ON s.ad_id = t.ad_id AND s.synced_at = t.max_synced_at
          WHERE s.account_id = ?
        `, [accountId, accountId])
        
        targetAdIds = rows.map(row => String(row.ad_id || '')).filter(id => id)
      } catch (error) {
        console.error(`❌ 查询账户下所有广告ID失败 (accountId: ${accountId}):`, error.message)
        // 如果查询失败，返回空数组（不抛错，保证系统可用性）
        return []
      }
    }

    if (targetAdIds.length === 0) {
      // 如果没有目标广告，返回空数组
      return []
    }

    // 第21-35行：从数据库查询数据（使用 ruleDataService）
    // 注意：每个条件可能有不同的 time_window，需要分别查询
    // 为了简化，我们使用第一个条件的 time_window（如果所有条件都有 time_window）
    const timeWindow = this.getTimeWindowFromConditions(rule.conditions) || 'today'
    
    let ruleData = []
    try {
      // 使用 ruleDataService 查询数据（完全离线，不调用 Facebook API）
      // 阶段A修复：queryRuleData 现在返回 { data, warnings }，需要解构
      const result = await queryRuleData(accountId, targetAdIds, timeWindow, timezoneName)
      ruleData = result.data || result  // 兼容旧格式（如果返回的是数组）
    } catch (error) {
      // 如果数据库查询失败，记录错误并返回空数组（不抛错，保证系统可用性）
      console.error(`❌ 规则数据查询失败 (accountId: ${accountId}, rule: ${rule.ruleName || rule.id}):`, error.message)
      return []
    }
    
    // 第36-50行：评估每个广告是否满足规则条件
    // 根据 logic_operator 选择不同的评估方法（AND 或 OR）
    const matchedAds = []
    
    // 确保 ruleData 是数组（兼容旧格式）
    const dataArray = Array.isArray(ruleData) ? ruleData : []
    
    for (const adData of dataArray) {
      // 评估条件（支持 AND/OR 逻辑）
      const conditionsMet = this.evaluateConditions(rule.conditions, adData, rule.logic_operator || 'AND')
      
      if (conditionsMet) {
        // 如果满足条件，添加到匹配列表
        matchedAds.push({
          ad_id: adData.ad_id,
          ad_name: adData.ad_name,
          ad_set_id: adData.ad_set_id,  // 用于预算调整动作
          metrics: {
            spend: adData.spend,
            purchases: adData.purchases,
            cpc: adData.cpc,
            roas: adData.roas,
            cpa: adData.cpa,
            // ... 其他指标
          }
        })
      }
    }

    // 第51行：返回匹配的广告列表
    return matchedAds
  }

  /**
   * 评估规则（旧版本：使用 Facebook API 返回的数据，向后兼容）
   * @param {Object} rule - 规则对象
   * @param {Array} insights - Facebook API 返回的 insights
   * @param {Array} ads - Facebook API 返回的 ads
   * @returns {Promise<boolean>} 是否有广告满足条件
   */
  async evaluateRuleLegacy(rule, insights, ads) {
    // 第1行：检查规则是否启用
    if (!rule.enabled) return false

    // 第2-10行：遍历所有 insights，评估每个广告
    for (const insight of insights) {
      const ad = ads.find(a => a.id === insight.ad_id)
      if (!ad) continue

      // 检查所有条件是否满足（使用 AND 逻辑，旧版本不支持 OR）
      const conditionsMet = rule.conditions.every(condition => {
        return this.evaluateCondition(condition, insight)
      })

      if (conditionsMet) {
        // 执行所有操作（使用旧版本的 executeActions）
        await this.executeActionsLegacy(rule.actions, ad, insight)
        return true
      }
    }

    return false
  }

  /**
   * 执行动作（旧版本：向后兼容）
   * @param {Array} actions - 动作数组
   * @param {Object} ad - 广告对象（包含 id, adset_id 等）
   * @param {Object} insight - 洞察数据
   */
  async executeActionsLegacy(actions, ad, insight) {
    for (const action of actions) {
      try {
        switch (action.type) {
          case 'pause_ad':
            await this.api.pauseAd(ad.id)
            break
          case 'activate_ad':
            await this.api.activateAd(ad.id)
            break
          case 'increase_budget':
          case 'decrease_budget':
            await this.adjustBudget(ad.adset_id, action)
            break
        }
      } catch (error) {
        console.error(`执行操作失败: ${action.type}`, error)
      }
    }
  }

  /**
   * 从条件数组中提取时间窗口（用于数据查询）
   * @param {Array} conditions - 条件数组
   * @returns {string} 时间窗口类型（'today' | 'yesterday' | 'last_3_days' | 'last_7_days' | 'lifetime'）
   * 
   * 【为什么需要这个方法？】
   * - 每个条件可能有不同的 time_window
   * - 为了简化，我们使用第一个条件的 time_window（如果所有条件都有 time_window）
   * - 如果条件没有 time_window，默认使用 'today'
   */
  getTimeWindowFromConditions(conditions) {
    // 第1-2行：如果条件数组为空，返回默认值 'today'
    if (!conditions || conditions.length === 0) {
      return 'today'
    }

    // 第3-4行：查找第一个有 time_window 的条件
    // 如果所有条件都有 time_window，使用第一个条件的 time_window
    for (const condition of conditions) {
      if (condition.time_window) {
        return condition.time_window
      }
    }

    // 第5行：如果所有条件都没有 time_window，返回默认值 'today'
    return 'today'
  }

  /**
   * 评估所有条件（支持 AND/OR 逻辑）
   * @param {Array} conditions - 条件数组
   * @param {Object} adData - 广告数据（来自数据库查询）
   * @param {string} logicOperator - 逻辑运算符：'AND' | 'OR'（默认 'AND'）
   * @returns {boolean} 是否满足所有条件（AND）或至少一个条件（OR）
   * 
   * 【为什么需要这个方法？】
   * - 支持 AND 逻辑：所有条件都必须满足（使用 Array.every()）
   * - 支持 OR 逻辑：至少一个条件满足（使用 Array.some()）
   * - 规则配置中增加 logic_operator 字段（'AND' | 'OR'）
   */
  evaluateConditions(conditions, adData, logicOperator = 'AND') {
    // 第1-2行：如果条件数组为空，返回 true（没有条件，视为满足）
    if (!conditions || conditions.length === 0) {
      return true
    }

    // 第3-10行：根据 logic_operator 选择不同的评估方法
    // AND：所有条件都必须满足（使用 Array.every()）
    // OR：至少一个条件满足（使用 Array.some()）
    if (logicOperator === 'OR') {
      // OR 逻辑：至少一个条件满足
      return conditions.some(condition => this.evaluateCondition(condition, adData))
    } else {
      // AND 逻辑（默认）：所有条件都必须满足
      return conditions.every(condition => this.evaluateCondition(condition, adData))
    }
  }

  /**
   * 评估单个条件（增强版：支持时间窗口）
   * @param {Object} condition - 条件对象 { metric, operator, value, time_window }
   * @param {Object} adData - 广告数据（来自数据库查询，已包含时间窗口数据）
   * @returns {boolean} 是否满足条件
   * 
   * 【增强功能】
   * - 支持 time_window 参数（虽然数据已经按 time_window 查询，这里保留兼容性）
   * - 支持新的指标（roas, cpa, purchases 等）
   */
  evaluateCondition(condition, adData) {
    // 第1行：获取指标值（从 adData 中提取）
    const metricValue = this.getMetricValue(condition.metric, adData)
    
    // 第2-15行：根据操作符评估条件
    // 支持的操作符：gt, lt, eq, gte, lte, ne（不等于）
    switch (condition.operator) {
      case 'gt':
        return metricValue > condition.value
      case 'lt':
        return metricValue < condition.value
      case 'eq':
        return metricValue === condition.value
      case 'ne':
        return metricValue !== condition.value
      case 'gte':
        return metricValue >= condition.value
      case 'lte':
        return metricValue <= condition.value
      default:
        // 如果操作符不支持，返回 false（保守策略）
        console.warn(`⚠️  不支持的操作符: ${condition.operator}`)
        return false
    }
  }

  /**
   * 获取指标值（增强版：支持新字段）
   * @param {string} metric - 指标名称（如 'spend', 'purchases', 'roas', 'cpa' 等）
   * @param {Object} adData - 广告数据（来自数据库查询或 Facebook API）
   * @returns {number} 指标值（如果不存在，返回 0 或 null）
   * 
   * 【增强功能】
   * - 支持新字段：roas, cpa, purchases, purchase_value, ucpc, add_to_cart_cost 等
   * - 兼容旧字段：ctr, cpc, spend, conversions, clicks, impressions, cpm
   * - 防御性编程：如果字段不存在，返回 0（避免 NaN 传播）
   */
  getMetricValue(metric, adData) {
    // 第1-15行：支持新字段（来自数据库查询）
    // 这些字段在 ruleDataService 中已经计算好，直接使用
    switch (metric) {
      // 绝对值指标
      case 'spend':
        return parseFloat(adData.spend || 0)
      case 'purchases':
        return parseInt(adData.purchases || 0)
      case 'purchase_value':
        return parseFloat(adData.purchase_value || 0)
      case 'link_clicks':
        return parseInt(adData.link_clicks || 0)
      case 'unique_link_clicks':
        return parseInt(adData.unique_link_clicks || 0)
      
      // 单价/比率类指标
      case 'cpc':
        return adData.cpc != null ? parseFloat(adData.cpc) : 0
      case 'roas':
        return adData.roas != null ? parseFloat(adData.roas) : 0
      case 'cpa':
        return adData.cpa != null ? parseFloat(adData.cpa) : 0
      case 'ucpc':
        return adData.ucpc != null ? parseFloat(adData.ucpc) : 0
      case 'add_to_cart_cost':
        return adData.add_to_cart_cost != null ? parseFloat(adData.add_to_cart_cost) : 0
      case 'checkout_cost':
        return adData.checkout_cost != null ? parseFloat(adData.checkout_cost) : 0
      case 'payment_cost':
        return adData.payment_cost != null ? parseFloat(adData.payment_cost) : 0
      
      // 兼容旧字段（来自 Facebook API）
      case 'ctr':
        return parseFloat(adData.ctr || 0)
      case 'conversions':
        // conversions 兼容 purchases（购买次数）
        return parseInt(adData.conversions || adData.purchases || 0)
      case 'clicks':
        // clicks 兼容 link_clicks
        return parseInt(adData.clicks || adData.link_clicks || 0)
      case 'impressions':
        return parseInt(adData.impressions || 0)
      case 'cpm':
        return parseFloat(adData.cpm || 0)
      
      default:
        // 如果指标不支持，返回 0（保守策略，避免 NaN 传播）
        console.warn(`⚠️  不支持的指标: ${metric}`)
        return 0
    }
  }

  /**
   * 执行动作（增强版：使用 ad_set_id 执行预算调整）
   * @param {Array} actions - 动作数组
   * @param {Object} matchedAd - 匹配的广告数据（包含 ad_id, ad_set_id 等）
   * @returns {Promise<Array>} 执行结果数组
   * 
   * 【增强功能】
   * - 使用 ad_set_id 执行预算调整（从数据库查询的数据中获取 ad_set_id）
   * - 支持 Dry Run 模式（is_simulation）
   * - 错误处理：单个动作失败不影响其他动作
   */
  async executeActions(actions, matchedAd, isSimulation = false) {
    // 第1-2行：如果动作数组为空，直接返回
    if (!actions || actions.length === 0) {
      return []
    }

    // 第3-4行：初始化结果数组，用于记录每个动作的执行结果
    const results = []

    // 第5-25行：遍历所有动作，逐个执行
    for (const action of actions) {
      try {
        // 第6-7行：如果是 Dry Run 模式，只记录日志，不执行真实动作
        if (isSimulation) {
          console.log(`[Dry Run] 广告 ${matchedAd.ad_id} 将执行动作: ${action.type}`, action)
          results.push({ action, status: 'simulated', success: true })
          continue
        }

        // 第8-20行：根据动作类型执行不同的操作
        switch (action.type) {
          case 'pause_ad':
            // 暂停广告（使用 ad_id）
            await this.api.pauseAd(matchedAd.ad_id)
            results.push({ action, status: 'executed', success: true })
            break
          
          case 'activate_ad':
            // 激活广告（使用 ad_id）
            await this.api.activateAd(matchedAd.ad_id)
            results.push({ action, status: 'executed', success: true })
            break
          
          case 'increase_budget':
          case 'decrease_budget':
            // 调整预算（使用 ad_set_id，从数据库查询的数据中获取）
            // 注意：ad_set_id 在 ruleDataService 查询时已经包含在返回数据中
            if (matchedAd.ad_set_id) {
              await this.adjustBudget(matchedAd.ad_set_id, action)
              results.push({ action, status: 'executed', success: true })
            } else {
              // 如果 ad_set_id 不存在，记录错误
              console.error(`❌ 无法调整预算：广告 ${matchedAd.ad_id} 没有 ad_set_id`)
              results.push({ action, status: 'failed', success: false, error: 'ad_set_id 不存在' })
            }
            break
          
          default:
            // 如果动作类型不支持，记录警告
            console.warn(`⚠️  不支持的动作类型: ${action.type}`)
            results.push({ action, status: 'skipped', success: false, error: '不支持的动作类型' })
        }
      } catch (error) {
        // 第21-22行：如果动作执行失败，记录错误但不中断其他动作
        console.error(`❌ 执行动作失败: ${action.type} (广告: ${matchedAd.ad_id})`, error.message)
        results.push({ action, status: 'failed', success: false, error: error.message })
      }
    }

    // 第23行：返回所有动作的执行结果
    return results
  }

  /**
   * 调整预算（增强版：使用 ad_set_id）
   * @param {string} adsetId - 广告组ID（从数据库查询的数据中获取）
   * @param {Object} action - 动作对象 { type: 'increase_budget' | 'decrease_budget', value: number }
   * @returns {Promise<void>}
   * 
   * 【增强功能】
   * - 使用 ad_set_id 执行预算调整（不需要额外查询 Facebook API）
   * - 支持百分比调整（value 为百分比，如 20 表示增加 20%）
   * - 支持预算上限护栏（max_daily_budget）
   */
  async adjustBudget(adsetId, action) {
    // 第1行：获取当前预算（需要调用 Facebook API）
    const currentBudget = await this.api.getAdsetBudget(adsetId)
    
    // 第2行：初始化新预算
    let newBudget

    // 第3-10行：根据动作类型和 value 计算新预算
    if (action.value !== undefined) {
      // 如果指定了 value，按百分比调整
      if (action.type === 'increase_budget') {
        newBudget = currentBudget * (1 + action.value / 100) // 百分比增加
      } else {
        newBudget = currentBudget * (1 - action.value / 100) // 百分比减少
      }
    } else {
      // 如果没有指定 value，默认调整 10%
      newBudget = action.type === 'increase_budget' 
        ? currentBudget * 1.1 
        : currentBudget * 0.9
    }

    // 第11-13行：预算上限护栏（如果规则中指定了 max_daily_budget）
    // 确保新预算不超过上限
    if (action.max_daily_budget !== undefined) {
      newBudget = Math.min(newBudget, action.max_daily_budget)
    }

    // 第14行：更新预算（保留两位小数）
    await this.api.updateAdsetBudget(adsetId, Math.round(newBudget * 100) / 100)
  }
}

// API 路由
// 注意：这些路由只在 app 对象存在时注册（避免测试时的循环依赖问题）
if (app) {
// 获取广告账户列表（按登录用户隔离）
app.get('/api/accounts', requireAuth, requireActive, async (req, res) => {
  const startTime = Date.now()
  try {
    console.log('')
    console.log('='.repeat(50))
    console.log('📥 收到请求: GET /api/accounts')
    console.log('👤 当前用户:', req.user.username, '| 角色:', req.user.role, '| 负责人:', req.user.owner_name || '无')
    console.log('⏰ 时间:', new Date().toLocaleString('zh-CN'))
    
    const token = process.env.FACEBOOK_ACCESS_TOKEN
    if (!token) {
      console.error('❌ FACEBOOK_ACCESS_TOKEN 未配置')
      return res.status(401).json({ error: 'Facebook访问令牌未配置，请检查.env文件' })
    }

    console.log('✅ Token已配置')
    console.log('🔑 Token前10位:', token.substring(0, 10) + '...')
    console.log('🔑 Token长度:', token.length)
    
    console.log('🔍 开始获取广告账户列表...')
    const api = new FacebookMarketingAPI(token)
    const allAccounts = await api.getAdAccounts()

    let filteredAccounts = allAccounts
    if (req.user.role === 'admin') {
      // 管理员看全部
      filteredAccounts = allAccounts
    } else if (req.user.owner_id) {
      const [rows] = await pool.execute(
        `SELECT fb_account_id FROM account_mappings WHERE owner_id = ? AND is_active = 1`,
        [req.user.owner_id]
      )

      const normalize = (id) => String(id || '').toLowerCase().trim().replace(/^act_/, '')
      const allowed = new Set(rows.map(r => normalize(r.fb_account_id)))
      filteredAccounts = allAccounts.filter(acc => allowed.has(normalize(acc.id || acc.account_id)))
    } else {
      filteredAccounts = []
    }
    
    const duration = Date.now() - startTime
    console.log(`✅ 成功返回 ${filteredAccounts.length} 个账户 (耗时: ${duration}ms)`)
    console.log('📋 账户列表:')
    filteredAccounts.forEach((acc, index) => {
      console.log(`   ${index + 1}. ${acc.name} (${acc.id})`)
    })
    console.log('='.repeat(50))
    console.log('')
    
    res.json({ accounts: filteredAccounts })
  } catch (error) {
    const duration = Date.now() - startTime
    console.error('❌ 获取账户列表失败 (耗时: ' + duration + 'ms)')
    console.error('❌ 错误消息:', error.message)
    console.error('❌ 错误堆栈:', error.stack)
    console.log('='.repeat(50))
    console.log('')
    
    res.status(500).json({ 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    })
  }
})

// 获取广告列表
app.get('/api/ads', requireAuth, requireActive, async (req, res) => {
  try {
    const { account_id } = req.query
    if (!account_id) {
      return res.status(400).json({ error: '缺少account_id参数' })
    }

    const token = process.env.FACEBOOK_ACCESS_TOKEN
    if (!token) {
      return res.status(401).json({ error: 'Facebook访问令牌未配置' })
    }

    const api = new FacebookMarketingAPI(token)
    const ads = await api.getAds(account_id)
    res.json({ ads })
  } catch (error) {
    console.error('获取广告列表失败:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取广告洞察数据
app.get('/api/insights', requireAuth, requireActive, async (req, res) => {
  try {
    const { account_id, since, until, preset, use_account_attribution_setting, action_attribution_windows } = req.query
    if (!account_id) {
      return res.status(400).json({ error: '缺少account_id参数' })
    }

    const token = process.env.FACEBOOK_ACCESS_TOKEN
    if (!token) {
      return res.status(401).json({ error: 'Facebook访问令牌未配置' })
    }

    const api = new FacebookMarketingAPI(token)
    const timeRange = (since && until) ? { since, until } : (preset ? { preset } : null)
    const opts = {
      // 你已移除前端“对齐 Ads Manager”开关：这里默认开启对齐（未显式传参时按 true）
      useAccountAttributionSetting: (use_account_attribution_setting == null || String(use_account_attribution_setting).trim() === '')
        ? true
        : String(use_account_attribution_setting || '').toLowerCase() === 'true',
      actionAttributionWindows: typeof action_attribution_windows === 'string' && action_attribution_windows.trim()
        ? action_attribution_windows.split(',').map(s => s.trim()).filter(Boolean)
        : undefined
    }
    // 兼容旧版：如果 FacebookMarketingAPI.getAdInsights 还不支持 opts，也不会报错（多余参数会被忽略）
    const insights = await api.getAdInsights(account_id, timeRange, opts)
    res.json({ insights, meta: { timeRange: timeRange || { preset: 'today' }, attribution: opts } })
  } catch (error) {
    console.error('获取洞察数据失败:', error)
    res.status(500).json({ error: error.message })
  }
})

// ROI 深度指标接口（购买/加购/结账/支付/独立点击）- 支持 sync/async
const ROI_JOB_TTL_MS = 5 * 60 * 1000
const roiJobCache = new Map() // key -> { createdAt, resultByAdId?, reportRunId? }

app.get('/api/roi', requireAuth, requireActive, async (req, res) => {
  try {
    const { account_id, preset, since, until, force, level, use_account_attribution_setting, action_attribution_windows } = req.query
    if (!account_id) return res.status(400).json({ error: '缺少 account_id 参数', code: 'MISSING_PARAM' })

    const token = process.env.FACEBOOK_ACCESS_TOKEN
    if (!token) return res.status(401).json({ error: 'Facebook访问令牌未配置', code: 'TOKEN_MISSING' })

    const api = new FacebookMarketingAPI(token)
    const timeRange = (since && until) ? { since, until } : (preset ? { preset } : { preset: 'today' })
    // 层级参数：ad / adset / campaign（默认 ad）
    const validLevels = ['ad', 'adset', 'campaign']
    const requestLevel = validLevels.includes(level) ? level : 'ad'
    const opts = {
      level: requestLevel,
      // 你已移除前端“对齐 Ads Manager”开关：这里默认开启对齐（未显式传参时按 true）
      useAccountAttributionSetting: (use_account_attribution_setting == null || String(use_account_attribution_setting).trim() === '')
        ? true
        : String(use_account_attribution_setting || '').toLowerCase() === 'true',
      actionAttributionWindows: typeof action_attribution_windows === 'string' && action_attribution_windows.trim()
        ? action_attribution_windows.split(',').map(s => s.trim()).filter(Boolean)
        : undefined
    }

    const forceLatest = String(force || '') === '1'
    const key = `roi|${String(account_id)}|${requestLevel}|${timeRange.preset || ''}|${timeRange.since || ''}|${timeRange.until || ''}|${opts.useAccountAttributionSetting ? 'acct' : ''}|${(opts.actionAttributionWindows || []).join('.')}`
    const now = Date.now()
    const cached = roiJobCache.get(key)

    if (!forceLatest && cached && (now - cached.createdAt) < ROI_JOB_TTL_MS) {
      if (cached.resultByAdId) return res.json({ roiByAdId: cached.resultByAdId, cached: true, mode: 'cache' })
      if (cached.reportRunId) return res.status(202).json({ report_run_id: cached.reportRunId, status: 'RUNNING', percent: 0, cached: true, mode: 'async' })
    }

    // 先尝试同步
    try {
      const rows = await api.getAdInsightsWithROI(String(account_id), timeRange, opts)
      const roiById = {}
      const idKey = requestLevel === 'adset' ? 'adset_id' : (requestLevel === 'campaign' ? 'campaign_id' : 'ad_id')
      for (const r of rows) {
        const id = String(r[idKey] || '')
        if (id) roiById[id] = r
      }
      roiJobCache.set(key, { createdAt: now, resultByAdId: roiById, reportRunId: null })
      return res.json({ roiByAdId: roiById, mode: 'sync' })
    } catch (e) {
      // 同步失败：降级异步
      const runId = await api.startRoiAsyncJob(String(account_id), timeRange, opts)
      roiJobCache.set(key, { createdAt: now, resultByAdId: null, reportRunId: runId })
      return res.status(202).json({ report_run_id: runId, status: 'RUNNING', percent: 0, mode: 'async' })
    }
  } catch (e) {
    console.error('获取 ROI 数据失败:', e)
    res.status(500).json({ error: e.message, code: 'ROI_ERROR' })
  }
})

app.get('/api/roi/result', requireAuth, requireActive, async (req, res) => {
  try {
    const { report_run_id } = req.query
    if (!report_run_id) return res.status(400).json({ error: '缺少 report_run_id 参数', code: 'MISSING_PARAM' })

    const token = process.env.FACEBOOK_ACCESS_TOKEN
    if (!token) return res.status(401).json({ error: 'Facebook访问令牌未配置', code: 'TOKEN_MISSING' })

    const api = new FacebookMarketingAPI(token)
    const st = await api.getReportRunStatus(String(report_run_id))
    // FB 这里的 async_status 有时是 "Job Completed" / "Job Running" 等文本，
    // 即使 percent=100，也可能短暂未就绪；统一用 “包含 completed” 判定更稳。
    const statusText = String(st.status || '')
    const isCompleted = statusText.toLowerCase().includes('completed')
    if (st.percent < 100 || !isCompleted) {
      return res.status(202).json({ report_run_id, status: st.status, percent: st.percent })
    }

    try {
      // 从请求参数获取 level（如果 report_run_id 对应的任务有记录 level）
      const { level: reportLevel } = req.query
      const validLevels = ['ad', 'adset', 'campaign']
      const requestLevel = validLevels.includes(reportLevel) ? reportLevel : 'ad'
      const rows = await api.getReportRunInsightsAll(String(report_run_id))
      const roiByAdId = api.extractRoiFromInsights(rows, requestLevel)
      return res.json({ report_run_id, status: 'COMPLETED', percent: 100, roiByAdId })
    } catch (e) {
      // 常见：报告还没完全可读，Graph 会返回 “not completed yet” 或类似信息
      const msg = String(e?.message || '')
      if (msg.toLowerCase().includes('not completed') || msg.toLowerCase().includes('not completed yet')) {
        return res.status(202).json({ report_run_id, status: st.status, percent: st.percent })
      }
      throw e
    }
  } catch (e) {
    console.error('获取 ROI 异步结果失败:', e)
    res.status(500).json({ error: e.message, code: 'ROI_RESULT_ERROR' })
  }
})

// 优先级2任务：查询离线数据（从数据库查询，返回 meta 字段）
// GET /api/rule-data?account_id=act_xxx&ad_ids=ad1,ad2&time_window=today&custom_range={"since":"2026-01-14","until":"2026-01-20"}
app.get('/api/rule-data', requireAuth, requireActive, async (req, res) => {
  try {
    const { account_id, ad_ids, time_window, custom_range } = req.query
    
    if (!account_id) {
      return res.status(400).json({ error: '缺少 account_id 参数' })
    }
    
    // 解析 ad_ids（支持逗号分隔的字符串或单个字符串）
    let adIds = null
    if (ad_ids) {
      if (typeof ad_ids === 'string' && ad_ids.includes(',')) {
        adIds = ad_ids.split(',').map(id => id.trim()).filter(Boolean)
      } else {
        adIds = ad_ids
      }
    }
    
    // 解析 time_window（默认 'today'）
    const timeWindow = time_window || 'today'
    
    // 解析 custom_range（如果提供）
    let customRange = null
    if (custom_range) {
      try {
        customRange = typeof custom_range === 'string' ? JSON.parse(custom_range) : custom_range
      } catch (error) {
        return res.status(400).json({ error: 'custom_range 格式无效，必须是有效的 JSON 对象' })
      }
    }
    
    // 获取账户时区（自动从数据库获取）
    const accountTimezone = await getAccountTimezone(account_id)
    
    // 数据时区优先（混合方案C）：如果是 today 查询，优先使用快照时区
    let dataTimezoneUsed = accountTimezone
    if (timeWindow === 'today' && adIds) {
      const { getDataTimezone } = await import('./services/ruleDataService.js')
      try {
        dataTimezoneUsed = await getDataTimezone(account_id, adIds, accountTimezone)
      } catch (error) {
        console.warn(`⚠️  获取数据时区失败，使用账户时区 ${accountTimezone}:`, error.message)
        dataTimezoneUsed = accountTimezone
      }
    }
    
    // 计算时间窗口（用于生成 meta 字段）
    const { calculateTimeWindow } = await import('./utils/timeWindow.js')
    const timeWindowResult = calculateTimeWindow(timeWindow, dataTimezoneUsed, customRange)
    
    // 查询数据
    // 阶段A修复：queryRuleData 现在返回 { data, warnings }，需要解构
    const result = await queryRuleData(account_id, adIds, timeWindow, null, customRange)
    const data = result.data || result  // 兼容旧格式（如果返回的是数组）
    const serviceWarnings = result.warnings || []  // 从 queryRuleData 获取 warnings
    
    // 构建 meta 字段
    // 合并 timeWindowResult.warnings 和 serviceWarnings（降级策略产生的 warnings）
    const allWarnings = [...(timeWindowResult.warnings || []), ...serviceWarnings]
    
    const meta = {
      account_timezone: accountTimezone,
      display_timezone: dataTimezoneUsed,
      data_timezone_used: dataTimezoneUsed,
      range: {
        start: {
          local: timeWindowResult.start.toFormat('yyyy-MM-dd HH:mm:ss'),
          utc: timeWindowResult.start.toUTC().toFormat('yyyy-MM-dd HH:mm:ss'),
          iso: timeWindowResult.start.toISO()
        },
        end: {
          local: timeWindowResult.end.toFormat('yyyy-MM-dd HH:mm:ss'),
          utc: timeWindowResult.end.toUTC().toFormat('yyyy-MM-dd HH:mm:ss'),
          iso: timeWindowResult.end.toISO()
        },
        days: Math.ceil(timeWindowResult.end.diff(timeWindowResult.start, 'days').days)
      },
      warnings: allWarnings
    }
    
    res.json({ data, meta })
  } catch (error) {
    console.error('查询规则数据失败:', error)
    res.status(500).json({ error: error.message })
  }
})

// 执行自动规则
app.post('/api/execute-rules', async (req, res) => {
  try {
    const { account_id, rules } = req.body
    
    if (!account_id) {
      return res.status(400).json({ error: '缺少account_id参数' })
    }

    const token = process.env.FACEBOOK_ACCESS_TOKEN
    if (!token) {
      return res.status(401).json({ error: 'Facebook访问令牌未配置' })
    }

    const api = new FacebookMarketingAPI(token)
    
    // 获取当前数据
    const insights = await api.getAdInsights(account_id)
    const ads = await api.getAds(account_id)

    // 关键：规则中的 conversions 需要与“购买口径”一致
    // 这里用 ROI 深度接口拿 purchases，并写回 insight.conversions，避免 /api/insights 过重（actions 超时）
    try {
      const roiRows = await api.getAdInsightsWithROI(String(account_id), { preset: 'today' })
      const purchasesByAdId = new Map(roiRows.map(r => [String(r.ad_id), Number(r.purchases || 0)]))
      for (const it of insights) {
        const adId = String(it.ad_id || '')
        if (!adId) continue
        it.conversions = purchasesByAdId.get(adId) ?? 0
      }
    } catch (e) {
      console.warn('⚠️ 规则执行：ROI 补齐失败，将使用 conversions=0 继续评估:', e?.message || e)
      for (const it of insights) it.conversions = it.conversions ?? 0
    }

    // 执行规则
    const ruleEngine = new RuleEngine(api)
    const results = []
    
    for (const rule of rules || []) {
      const executed = await ruleEngine.evaluateRule(rule, insights, ads)
      results.push({ rule_id: rule.id, executed })
    }

    res.json({ results })
  } catch (error) {
    console.error('执行规则失败:', error)
    res.status(500).json({ error: error.message })
  }
})

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '服务器运行正常',
    timestamp: new Date().toISOString(),
    token_configured: !!process.env.FACEBOOK_ACCESS_TOKEN,
    token_length: process.env.FACEBOOK_ACCESS_TOKEN ? process.env.FACEBOOK_ACCESS_TOKEN.length : 0
  })
})

// 诊断端点 - 测试Token和API连接
// 代理连接测试端点
app.get('/api/test-proxy', async (req, res) => {
  try {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
    
    if (!proxyUrl) {
      return res.json({ 
        success: false, 
        message: '未配置代理',
        proxy: null
      })
    }
    
    // 解析代理URL
    let proxyHost = '127.0.0.1'
    let proxyPort = 10809
    let socks5Url = proxyUrl
    
    if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
      const urlObj = new URL(proxyUrl)
      proxyHost = urlObj.hostname
      proxyPort = parseInt(urlObj.port) || 10809
      socks5Url = `socks5://${proxyHost}:${proxyPort}`
    } else if (proxyUrl.includes(':')) {
      const parts = proxyUrl.split(':')
      proxyHost = parts[0]
      proxyPort = parseInt(parts[1]) || 10809
      socks5Url = `socks5://${proxyHost}:${proxyPort}`
    }
    
    // 测试TCP连接
    return new Promise((resolve) => {
      const socket = net.createConnection(proxyPort, proxyHost, () => {
        console.log(`✅ 成功连接到代理服务器 ${proxyHost}:${proxyPort}`)
        socket.destroy()
        resolve(res.json({
          success: true,
          message: '代理服务器连接成功',
          proxy: {
            host: proxyHost,
            port: proxyPort,
            socks5Url: socks5Url
          }
        }))
      })
      
      socket.on('error', (error) => {
        console.error(`❌ 代理服务器连接失败: ${error.message}`)
        resolve(res.json({
          success: false,
          message: `代理服务器连接失败: ${error.message}`,
          error: error.code,
          proxy: {
            host: proxyHost,
            port: proxyPort,
            socks5Url: socks5Url
          }
        }))
      })
      
      socket.setTimeout(5000, () => {
        socket.destroy()
        resolve(res.json({
          success: false,
          message: '代理服务器连接超时（5秒）',
          proxy: {
            host: proxyHost,
            port: proxyPort,
            socks5Url: socks5Url
          }
        }))
      })
    })
  } catch (error) {
    res.json({
      success: false,
      message: error.message,
      error: error.stack
    })
  }
})

app.get('/api/debug', async (req, res) => {
  try {
    const token = process.env.FACEBOOK_ACCESS_TOKEN
    const debugInfo = {
      server: {
        status: 'running',
        port: PORT,
        timestamp: new Date().toISOString()
      },
      token: {
        configured: !!token,
        length: token ? token.length : 0,
        preview: token ? token.substring(0, 10) + '...' : 'not set'
      },
      test: null
    }

    if (token) {
      try {
        // 测试Token是否有效
        const testUrl = `${FACEBOOK_API_BASE}/me?access_token=${token}`
        const response = await axios.get(testUrl, { timeout: 30000 })
        const data = response.data
        
        if (data.error) {
          debugInfo.test = {
            success: false,
            error: data.error
          }
        } else {
          debugInfo.test = {
            success: true,
            user_id: data.id,
            name: data.name
          }
        }
      } catch (error) {
        debugInfo.test = {
          success: false,
          error: error.message
        }
      }
    }

    res.json(debugInfo)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

} // 结束 if (app) 条件块

// 注意：服务器启动逻辑已移到 server.js
// 这个文件现在只包含业务逻辑类（FacebookMarketingAPI, RuleEngine）和 API 路由

// 导出类，供其他模块使用（如 cronService.js）
export { FacebookMarketingAPI, RuleEngine }

