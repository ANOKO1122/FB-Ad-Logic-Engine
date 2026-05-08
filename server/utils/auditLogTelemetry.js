import logger from './logger.js'

function safeJsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
  } catch {
    return null
  }
}

function objectKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value)
    : []
}

export function serializeDbError(error) {
  return {
    errorName: error?.name || null,
    errorMessage: error?.message || String(error || ''),
    code: error?.code || null,
    errno: error?.errno ?? null,
    sqlState: error?.sqlState || null,
    sqlMessage: error?.sqlMessage || null,
    stack: error?.stack || null
  }
}

export function summarizeAuditPayload({ actionPayload, metricsSnapshot, explanation }) {
  return {
    actionPayloadKeys: objectKeys(actionPayload),
    actionPayloadSize: safeJsonSize(actionPayload),
    metricsSnapshotKeys: objectKeys(metricsSnapshot),
    metricsSnapshotSize: safeJsonSize(metricsSnapshot),
    explanationKeys: objectKeys(explanation),
    explanationSize: safeJsonSize(explanation)
  }
}

export function extractFbError(error) {
  const fbError = error?.response?.data?.error || error?.body?.error || null
  return {
    fbErrorCode: fbError?.code ?? null,
    fbErrorSubcode: fbError?.error_subcode ?? null,
    fbErrorType: fbError?.type || null,
    httpStatus: error?.response?.status ?? null
  }
}

export function logAuditInsertSuccess(context = {}) {
  logger.info('automation_logs.insert.success', {
    operation: 'automation_logs.insert.success',
    ...context
  })
}

export function logAuditInsertFailure({ context = {}, payload = {}, error }) {
  logger.error('⚠️ 写入审计日志失败', {
    operation: 'automation_logs.insert',
    ...context,
    ...summarizeAuditPayload(payload),
    ...serializeDbError(error)
  })
}

export function logFbActionSuccess(context = {}) {
  logger.info('fb_action.execute.success', {
    operation: 'fb_action.execute.success',
    ...context
  })
}

export function logFbActionFailure({ context = {}, error }) {
  logger.error('fb_action.execute.fail', {
    operation: 'fb_action.execute.fail',
    ...context,
    ...extractFbError(error),
    ...serializeDbError(error)
  })
}

