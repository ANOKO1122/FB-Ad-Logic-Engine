// 快速检查 token 是否过期
const token = ""

// 解码 payload（中间部分）
const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())

console.log('Token 信息:')
console.log('签发时间 (iat):', new Date(payload.iat * 1000).toLocaleString('zh-CN'))
console.log('过期时间 (exp):', new Date(payload.exp * 1000).toLocaleString('zh-CN'))
console.log('当前时间:', new Date().toLocaleString('zh-CN'))
console.log('是否过期:', new Date() > new Date(payload.exp * 1000))
console.log('剩余时间（秒）:', Math.max(0, payload.exp - Math.floor(Date.now() / 1000)))
