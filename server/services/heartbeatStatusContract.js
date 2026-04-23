// 统一心跳结果码契约。
// 这一层的职责不是执行业务，而是把“成功有数据 / 成功无数据 / 失败 / 无效跳过”口径固定下来，
// 避免后续 M2 写状态、M3 接口返回、前端展示时各自手写字符串导致语义漂移。
export const HEARTBEAT_RESULT_CODE = Object.freeze({
  SUCCESS_WITH_DATA: 'SUCCESS_WITH_DATA',
  SUCCESS_NO_DATA: 'SUCCESS_NO_DATA',
  FAILED: 'FAILED',
  SKIPPED_INVALID_ACCOUNT: 'SKIPPED_INVALID_ACCOUNT',
})

export function isHeartbeatResultCode(value) {
  return Object.values(HEARTBEAT_RESULT_CODE).includes(value)
}
