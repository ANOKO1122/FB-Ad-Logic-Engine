function toNum(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normalizeChildren(children) {
  if (!Array.isArray(children)) return []
  return children.map((item) => ({
    adId: item?.adId || item?.ad_id || null,
    adName: item?.adName || item?.ad_name || null,
    adsetId: item?.adsetId || item?.adset_id || item?.ad_set_id || null,
    campaignId: item?.campaignId || item?.campaign_id || null,
    status: item?.status || null,
    spend: toNum(item?.spend, 0),
    purchases: toNum(item?.purchases, 0),
    link_clicks: toNum(item?.link_clicks, 0),
    unique_link_clicks: toNum(item?.unique_link_clicks, 0),
    purchase_value: toNum(item?.purchase_value, 0),
    add_to_cart_count: toNum(item?.add_to_cart_count, 0),
    initiate_checkout_count: toNum(item?.initiate_checkout_count, 0),
    add_payment_info_count: toNum(item?.add_payment_info_count, 0)
  }))
}

export function buildAutomationLogExplanation({ rule, matchedObject, accountId }) {
  const trace = matchedObject?.aggregationTrace
  const conditionTrace = Array.isArray(matchedObject?.conditionTrace) ? matchedObject.conditionTrace : []

  if (!trace && conditionTrace.length === 0) return null

  const targetLevel = String(rule?.targetLevel || rule?.target_level || matchedObject?.objectType || 'ad').toLowerCase()
  const target = {
    objectType: matchedObject?.objectType || targetLevel,
    objectId: matchedObject?.objectId || null,
    objectName: matchedObject?.objectName || null,
    targetLevel,
    accountId: String(accountId || rule?.accountId || rule?.account_id || '')
  }

  const window = trace?.window || {
    timeWindow: trace?.timeWindow || null,
    timezoneName: trace?.timezoneName || null,
    customRange: trace?.customRange || null
  }

  const children = normalizeChildren(trace?.children)
  const aggregate = trace?.aggregate || null

  return {
    version: 1,
    target,
    window,
    input: {
      childCount: children.length,
      children
    },
    aggregate,
    conditionTrace,
    logic: {
      logicOperator: String(rule?.logicOperator || rule?.logic_operator || 'AND').toUpperCase(),
      matched: conditionTrace.length > 0 ? conditionTrace.every((c) => c?.passed !== false) : true
    }
  }
}

export function parseLogJsonField(value, fallback = null) {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}
