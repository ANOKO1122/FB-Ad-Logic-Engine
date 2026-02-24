// 原生SOCKS5协议实现
import net from 'net'
import tls from 'tls'
import logger from './utils/logger.js'
import { recordRequest } from './utils/tlsErrorMonitor.js'
import { parseProxyUrl } from './utils/proxyUtils.js'

export async function requestViaSocks5(targetUrl, params, socks5Url, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    try {
      // 防止重复 resolve/reject（例如：已解析成功后又触发 socket/tls error）
      let settled = false
      const safeResolve = (v) => {
        if (settled) return
        settled = true
        resolve(v)
      }
      const safeReject = (e) => {
        if (settled) return
        settled = true
        reject(e)
      }

      // 解析SOCKS5代理URL（使用统一工具，确保 socks5h 等协议解析正确）
      const info = parseProxyUrl(socks5Url)
      const proxyHost = info?.host || '127.0.0.1'
      const proxyPort = (info?.port && !Number.isNaN(info.port) && info.port >= 1 && info.port <= 65535) ? info.port : 10809
      
      // 解析目标URL
      const targetUrlObj = new URL(targetUrl)
      const targetHost = targetUrlObj.hostname
      const targetPort = parseInt(targetUrlObj.port) || 443
      
      logger.info(`🔗 通过SOCKS5代理连接: ${proxyHost}:${proxyPort} -> ${targetHost}:${targetPort}`)
      
      // 连接到SOCKS5代理服务器
      const socket = net.createConnection(proxyPort, proxyHost, () => {
        logger.info('✅ 已连接到SOCKS5代理服务器')
        
        // SOCKS5握手：发送认证方法
        // 版本5，1个方法，无认证（0x00）
        const authRequest = Buffer.from([0x05, 0x01, 0x00])
        socket.write(authRequest)
      })
      
      let authComplete = false
      let connectionComplete = false
      let dataBuffer = Buffer.alloc(0) // 数据缓冲区，处理分片数据
      
      socket.on('data', (data) => {
        try {
          // 将新数据追加到缓冲区
          dataBuffer = Buffer.concat([dataBuffer, data])
          logger.info(`📥 收到SOCKS5数据: ${data.length} 字节, 缓冲区总大小: ${dataBuffer.length} 字节`)
          logger.info(`📥 数据十六进制: ${dataBuffer.toString('hex').substring(0, 100)}`)
          
          if (!authComplete) {
            // 认证响应应该是2字节；不够就继续等待
            if (dataBuffer.length < 2) return

            const responseData = dataBuffer.subarray(0, 2)
            dataBuffer = dataBuffer.subarray(2) // 移除已处理的数据

            // 处理认证响应: VER=0x05, METHOD=0x00(无认证)
            if (responseData[0] !== 0x05) {
              const errorMsg = `SOCKS5认证响应格式错误: 期望版本5，收到 ${responseData[0]}`
              logger.error(`❌ ${errorMsg}`)
              logger.error(`❌ 响应数据: ${responseData.toString('hex')}`)
              reject(new Error(errorMsg))
              socket.destroy()
              return
            }

            if (responseData[1] !== 0x00) {
              const errorMsg = `SOCKS5认证失败: 服务器返回方法 ${responseData[1]} (0x00=无认证, 0x02=用户名密码)`
              logger.error(`❌ ${errorMsg}`)
              logger.error(`❌ 响应数据: ${responseData.toString('hex')}`)
              reject(new Error(errorMsg))
              socket.destroy()
              return
            }

            logger.info('✅ SOCKS5认证成功')
            authComplete = true

            // 发送连接请求（ATYP=0x03 域名）
            const hostBytes = Buffer.from(targetHost, 'utf-8')
            const connectRequest = Buffer.alloc(4 + 1 + hostBytes.length + 2)
            connectRequest[0] = 0x05 // 版本
            connectRequest[1] = 0x01 // CONNECT命令
            connectRequest[2] = 0x00 // 保留
            connectRequest[3] = 0x03 // 域名类型
            connectRequest[4] = hostBytes.length // 域名长度
            hostBytes.copy(connectRequest, 5)
            connectRequest.writeUInt16BE(targetPort, 5 + hostBytes.length)

            logger.info(`📤 发送SOCKS5连接请求: ${targetHost}:${targetPort}`)
            logger.info(`📤 连接请求数据: ${connectRequest.toString('hex')}`)
            socket.write(connectRequest)
            return
          } else if (!connectionComplete) {
          // 处理连接响应
          // SOCKS5连接响应至少需要4字节：版本(1) + 状态(1) + 保留(1) + 地址类型(1)
          // 但实际响应可能更长（包含绑定地址和端口）
          if (dataBuffer.length >= 4 && dataBuffer[0] === 0x05) {
            // 检查响应是否完整（需要根据地址类型判断）
            let responseLength = 4
            if (dataBuffer.length >= 4) {
              const addrType = dataBuffer[3]
              if (addrType === 0x01) {
                // IPv4地址，需要额外4字节地址 + 2字节端口 = 10字节
                responseLength = 10
              } else if (addrType === 0x03) {
                // 域名，需要1字节长度 + 域名 + 2字节端口
                if (dataBuffer.length >= 5) {
                  const domainLen = dataBuffer[4]
                  responseLength = 5 + domainLen + 2
                }
              } else if (addrType === 0x04) {
                // IPv6地址，需要额外16字节地址 + 2字节端口 = 22字节
                responseLength = 22
              }
            }
            
            // 如果响应数据不完整，等待更多数据
            if (dataBuffer.length < responseLength) {
              logger.info(`⏳ 等待更多SOCKS5响应数据: 当前 ${dataBuffer.length} 字节，需要 ${responseLength} 字节`)
              return
            }
            
            const responseData = dataBuffer.subarray(0, responseLength)
            dataBuffer = dataBuffer.subarray(responseLength) // 移除已处理的数据
            
            if (responseData[1] === 0x00) {
              logger.info('✅ SOCKS5连接建立成功')
              connectionComplete = true

              // 关键：SOCKS5 CONNECT 成功后，停止用原始 socket 的 data 监听去“消费”后续数据，
              // 否则会干扰 TLS 握手（常见现象就是：TLS 还没建立 socket 就被对端断开）。
              // 注意：CONNECT 响应后可能紧跟着 TLS 数据，我们要把“剩余数据”交给 tlsSocket
              const leftover = dataBuffer
              dataBuffer = Buffer.alloc(0)

              socket.removeAllListeners('data')
              // 清掉 SOCKS5 阶段的超时，避免握手过程中被 10s 超时强行 destroy
              socket.setTimeout(0)
              
              if (leftover.length > 0) {
                logger.info(`⚠️ SOCKS5响应后检测到 ${leftover.length} 字节后续数据，将交给TLS处理`)
              }
              
              // 在SOCKS5隧道上建立TLS连接
              // 使用setImmediate确保SOCKS5响应已完全处理
              setImmediate(() => {
                // 建立 TLS 前先暂停底层 socket，交给 tlsSocket 接管后再 resume
                try { socket.pause() } catch {}
                const tlsSocket = tls.connect({
                  socket: socket,
                  host: targetHost,
                  servername: targetHost,
                  rejectUnauthorized: false
                }, () => {
                  logger.info('✅ TLS连接建立成功，开始发送HTTP请求...')
                  try { tlsSocket.resume() } catch {}
                  
                  // 构建路径：优先使用 targetUrl 自带的 query（例如 paging.next / access_token），避免被 params 覆盖丢失
                  // 规则：
                  // 1) 如果 targetUrlObj.search 存在，直接用 pathname + search
                  // 2) 否则才用 params 生成 queryString
                  let path = targetUrlObj.pathname
                  if (targetUrlObj.search) {
                    path = targetUrlObj.pathname + targetUrlObj.search
                  } else if (params && Object.keys(params).length > 0) {
                    const queryString = new URLSearchParams(params).toString()
                    path = queryString ? `${targetUrlObj.pathname}?${queryString}` : targetUrlObj.pathname
                  }
                  
                  // 构建HTTP请求
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
                  
                  let requestLine = `${method} ${path} HTTP/1.1\r\n`
                  let headerLines = Object.entries(headers)
                    .map(([key, value]) => `${key}: ${value}\r\n`)
                    .join('')
                  const httpRequest = requestLine + headerLines + '\r\n'
                  
                  // 打码 access_token，避免日志泄露
                  const safePath = path.replace(/access_token=[^&]+/g, 'access_token=***')
                  logger.info(`📤 发送HTTP请求: ${method} ${safePath}`)
                  tlsSocket.write(httpRequest)
                  
                  if (method === 'POST' && body) {
                    const bodyStr = JSON.stringify(body)
                    logger.info(`📤 请求体大小: ${bodyStr.length} 字节`)
                    tlsSocket.write(bodyStr)
                  }
                })

                // 把 CONNECT 响应后残留的数据喂回 TLS 解析器（关键修复：否则容易 bad record mac）
                try {
                  if (leftover.length > 0) tlsSocket.unshift(leftover)
                } catch {}
                
                function decodeChunkedBody(raw) {
                  // raw 形如: <hex>\r\n<chunk>\r\n ... 0\r\n\r\n
                  let i = 0
                  let out = ''
                  while (i < raw.length) {
                    const lineEnd = raw.indexOf('\r\n', i)
                    if (lineEnd === -1) break
                    const sizeLine = raw.substring(i, lineEnd).trim()
                    // 忽略可能的 chunk extension: "65b;foo=bar"
                    const hexStr = sizeLine.split(';')[0].trim()
                    const size = parseInt(hexStr, 16)
                    if (!Number.isFinite(size)) break
                    i = lineEnd + 2
                    if (size === 0) break
                    out += raw.substring(i, i + size)
                    i += size
                    // 跳过 chunk 后的 \r\n
                    if (raw.substring(i, i + 2) === '\r\n') i += 2
                  }
                  return out
                }

                function normalizeBodyForJson(raw) {
                  if (!raw) return raw
                  const trimmed = raw.trim()
                  if (!isChunked) return trimmed
                  return decodeChunkedBody(trimmed).trim()
                }

                function tryFinalizeFromBody() {
                  if (settled) return true
                  if (!isHeadersComplete || !responseBody) return false
                  try {
                    const bodyForJson = normalizeBodyForJson(responseBody)
                    const jsonData = JSON.parse(bodyForJson)
                    logger.info('✅ JSON解析成功（由TLS错误回退路径完成）')
                    safeResolve(jsonData)
                    return true
                  } catch (parseError) {
                    logger.error('❌ JSON解析失败（TLS错误回退路径）:', parseError.message)
                    logger.error('❌ 响应数据（前1000字符）:', responseBody.substring(0, 1000))
                    safeReject(new Error(`解析响应失败: ${parseError.message}`))
                    return true
                  }
                }

                tlsSocket.on('error', (error) => {
                  // 某些代理/链路会在响应已接收后触发 TLS record 错误（常见：bad record mac）。
                  // 只要我们已经拿到了 HTTP 头/Body，就优先返回数据，避免整条请求被判失败。
                  logger.error('❌ TLS连接错误:', error.message)
                  
                  // 记录 TLS 错误（用于监控）
                  recordRequest(true)
                  
                  if (tryFinalizeFromBody()) {
                    // 虽然出现错误，但已成功解析响应，记录为成功请求
                    // 注意：这里会记录两次（一次错误，一次成功），但能准确反映"有错误但最终成功"的情况
                    recordRequest(false)
                    return
                  }
                  safeReject(new Error(`TLS连接失败: ${error.message}`))
                })
                
                // 接收HTTP响应
                let responseBuffer = Buffer.alloc(0)
                let responseBody = ''
                let isHeadersComplete = false
                let contentLength = null
                let isChunked = false
                
                tlsSocket.on('data', (chunk) => {
                  responseBuffer = Buffer.concat([responseBuffer, chunk])
                  
                  if (!isHeadersComplete) {
                    const headerEnd = responseBuffer.indexOf(Buffer.from('\r\n\r\n'))
                    if (headerEnd !== -1) {
                      isHeadersComplete = true
                      const headerText = responseBuffer.subarray(0, headerEnd).toString('utf-8')
                      const bodyStart = headerEnd + 4
                      
                      const lines = headerText.split('\r\n')
                      const statusLine = lines[0]
                      const statusMatch = statusLine.match(/HTTP\/\d\.\d\s+(\d+)\s+(.+)/)
                      if (statusMatch) {
                        const statusCode = parseInt(statusMatch[1])
                        const statusMessage = statusMatch[2]
                        logger.info(`📥 收到HTTP响应: ${statusCode} ${statusMessage}`)
                      }
                      
                      for (let i = 1; i < lines.length; i++) {
                        const colonIndex = lines[i].indexOf(':')
                        if (colonIndex !== -1) {
                          const key = lines[i].substring(0, colonIndex).trim().toLowerCase()
                          const value = lines[i].substring(colonIndex + 1).trim()
                          if (key === 'content-length') {
                            contentLength = parseInt(value)
                          }
                          if (key === 'transfer-encoding' && value.toLowerCase().includes('chunked')) {
                            isChunked = true
                          }
                        }
                      }
                      
                      if (responseBuffer.length > bodyStart) {
                        const bodyChunk = responseBuffer.subarray(bodyStart)
                        responseBody += bodyChunk.toString('utf-8')
                      }
                    }
                  } else {
                    responseBody += chunk.toString('utf-8')
                  }
                  
                  if (contentLength !== null && responseBody.length >= contentLength) {
                    responseBody = responseBody.substring(0, contentLength)
                    tlsSocket.end()
                  }
                })
                
                tlsSocket.on('end', () => {
                  logger.info(`✅ 响应接收完成，总大小: ${responseBuffer.length} 字节`)
                  try {
                    if (!responseBody) {
                      safeReject(new Error('收到空响应'))
                      return
                    }
                    const bodyForJson = normalizeBodyForJson(responseBody)
                    const jsonData = JSON.parse(bodyForJson)
                    logger.info('✅ JSON解析成功')
                    
                    // 记录成功请求（用于监控）
                    recordRequest(false)
                    
                    safeResolve(jsonData)
                  } catch (parseError) {
                    logger.error('❌ 响应数据（前1000字符）:', responseBody.substring(0, 1000))
                    safeReject(new Error(`解析响应失败: ${parseError.message}`))
                  }
                })
                
                tlsSocket.setTimeout(60000, () => {
                  logger.error('❌ TLS连接超时（60秒）')
                  tlsSocket.destroy()
                  socket.destroy()
                  safeReject(new Error('TLS连接超时'))
                })
              })
            } else {
              const errorCodes = {
                0x01: '一般SOCKS服务器失败',
                0x02: '现有规则不允许连接',
                0x03: '网络不可达',
                0x04: '主机不可达',
                0x05: '连接被拒绝',
                0x06: 'TTL过期',
                0x07: '不支持的命令',
                0x08: '不支持的地址类型'
              }
              const errorCode = data[1]
              const errorMsg = errorCodes[errorCode] || `未知错误 (0x${errorCode.toString(16)})`
              logger.error(`❌ SOCKS5连接失败: ${errorMsg}`)
              logger.error(`❌ 响应数据: ${data.toString('hex')}`)
              safeReject(new Error(`SOCKS5连接失败: ${errorMsg} (错误代码: 0x${errorCode.toString(16)})`))
              socket.destroy()
            }
          } else {
            const errorMsg = `SOCKS5连接响应格式错误: 期望版本5，收到 ${data[0]}`
            logger.error(`❌ ${errorMsg}`)
            logger.error(`❌ 响应数据: ${data.toString('hex')}`)
            safeReject(new Error(errorMsg))
            socket.destroy()
          }
        }
        } catch (error) {
          logger.error('❌ 处理SOCKS5数据时出错:', error.message)
          logger.error('❌ 错误堆栈:', error.stack)
          safeReject(new Error(`处理SOCKS5数据失败: ${error.message}`))
          socket.destroy()
        }
      })
      
      socket.on('error', (error) => {
        logger.error('❌ SOCKS5 socket错误:', error.message)
        logger.error('❌ 错误代码:', error.code)
        logger.error('❌ 错误堆栈:', error.stack)
        safeReject(new Error(`SOCKS5连接错误: ${error.message} (${error.code})`))
      })
      
      socket.on('close', (hadError) => {
        if (hadError && !authComplete && !connectionComplete) {
          logger.error('❌ SOCKS5连接意外关闭')
          safeReject(new Error('SOCKS5连接意外关闭'))
        }
      })
      
      socket.setTimeout(10000, () => {
        logger.error('❌ SOCKS5连接超时（10秒）- 未收到代理服务器响应')
        socket.destroy()
        safeReject(new Error('SOCKS5连接超时：10秒内未收到代理服务器响应'))
      })
    } catch (error) {
      reject(error)
    }
  })
}

