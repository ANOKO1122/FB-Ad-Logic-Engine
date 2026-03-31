import axios from 'axios'
import crypto from 'crypto'
import logger from '../utils/logger.js'

// 统一超时时间，避免第三方接口偶发卡死拖垮回调接口。
const HTTP_TIMEOUT_MS = 10000

// 使用 axios 实例统一管理超时，后续若要加重试/代理可集中扩展。
const http = axios.create({
  timeout: HTTP_TIMEOUT_MS,
})

function getRequiredEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`缺少必需环境变量: ${name}`)
  }
  return value
}

export function generateOAuthState() {
  // 生成高熵随机串，作为一次性防伪造令牌（CSRF 防护核心）。
  return crypto.randomBytes(24).toString('hex')
}

export function buildDingTalkAuthorizeUrl(state) {
  const appKey = getRequiredEnv('DINGTALK_APP_KEY')
  const redirectUri = getRequiredEnv('DINGTALK_REDIRECT_URI')
  const scope = process.env.DINGTALK_SCOPE || 'openid'
  const authorizeBaseUrl =
    process.env.DINGTALK_OAUTH_AUTHORIZE_URL || 'https://login.dingtalk.com/oauth2/auth'

  // 统一用 URLSearchParams 组装查询参数，避免手写字符串导致编码错误。
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    response_type: 'code',
    client_id: appKey,
    scope,
    state,
    prompt: 'consent',
  })

  return `${authorizeBaseUrl}?${params.toString()}`
}

export async function exchangeCodeForUserAccessToken(code) {
  const appKey = getRequiredEnv('DINGTALK_APP_KEY')
  const appSecret = getRequiredEnv('DINGTALK_APP_SECRET')

  const payload = {
    clientId: appKey,
    clientSecret: appSecret,
    code,
    grantType: 'authorization_code',
  }

  const { data } = await http.post(
    'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
    payload
  )

  const userAccessToken = data?.accessToken || data?.access_token
  if (!userAccessToken) {
    logger.error('钉钉换取用户 accessToken 失败', { response: data })
    throw new Error('钉钉换取用户 accessToken 失败')
  }

  return userAccessToken
}

export async function getCurrentUserByUserAccessToken(userAccessToken) {
  // 官方接口对 header 兼容历史形态存在差异，这里双写提高兼容性。
  const headers = {
    Authorization: `Bearer ${userAccessToken}`,
    'x-acs-dingtalk-access-token': userAccessToken,
  }

  const { data } = await http.get('https://api.dingtalk.com/v1.0/contact/users/me', { headers })

  const unionId = data?.unionId || data?.union_id
  if (!unionId) {
    logger.error('钉钉 users/me 未返回 unionId', { response: data })
    throw new Error('钉钉 users/me 未返回 unionId')
  }

  return {
    unionId,
    openId: data?.openId || data?.open_id || null,
    mobile: data?.mobile || null,
    raw: data,
  }
}

export async function getAppAccessToken() {
  const appKey = getRequiredEnv('DINGTALK_APP_KEY')
  const appSecret = getRequiredEnv('DINGTALK_APP_SECRET')
  const { data } = await http.get('https://oapi.dingtalk.com/gettoken', {
    params: {
      appkey: appKey,
      appsecret: appSecret,
    },
  })

  if (data?.errcode !== 0 || !data?.access_token) {
    logger.error('钉钉应用 access_token 获取失败', { response: data })
    throw new Error('钉钉应用 access_token 获取失败')
  }

  return data.access_token
}

export async function getByUnionId(appAccessToken, unionId) {
  const { data } = await http.post(
    `https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(appAccessToken)}`,
    { unionid: unionId }
  )

  if (data?.errcode !== 0 || !data?.result?.userid) {
    logger.error('钉钉 getbyunionid 调用失败', { response: data, unionId })
    throw new Error('钉钉 getbyunionid 调用失败')
  }

  return {
    userId: data.result.userid,
    contactType: data.result.contact_type,
    raw: data,
  }
}

export async function getUserDetailByUserId(appAccessToken, userId) {
  const { data } = await http.post(
    `https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(appAccessToken)}`,
    { userid: userId }
  )

  if (data?.errcode !== 0 || !data?.result) {
    logger.error('钉钉 user/get 调用失败', { response: data, userId })
    throw new Error('钉钉 user/get 调用失败')
  }

  return {
    active: data.result.active === true,
    admin: data.result.admin === true,
    raw: data,
  }
}

export async function fetchDingTalkIdentityByCode(code) {
  // 这段是 M2 的“已实测链路”编排：code -> userToken -> users/me -> getbyunionid -> user/get。
  const userAccessToken = await exchangeCodeForUserAccessToken(code)
  const me = await getCurrentUserByUserAccessToken(userAccessToken)
  const appAccessToken = await getAppAccessToken()
  const unionInfo = await getByUnionId(appAccessToken, me.unionId)
  const detail = await getUserDetailByUserId(appAccessToken, unionInfo.userId)

  return {
    unionId: me.unionId,
    openId: me.openId,
    mobile: me.mobile,
    dingtalkUserId: unionInfo.userId,
    contactType: unionInfo.contactType,
    active: detail.active,
    admin: detail.admin,
    raw: {
      me: me.raw,
      unionInfo: unionInfo.raw,
      detail: detail.raw,
    },
  }
}
