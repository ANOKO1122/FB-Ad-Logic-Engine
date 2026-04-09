/**
 * 目标 ID 归一化工具
 * - 保证 act_ 前缀只有一层，避免 act_act_xxx 进入库或参与匹配
 */

/**
 * 将账户 ID 归一化为标准格式：仅一层 act_ 前缀
 * @param {string} accountId - 原始账户 ID（可能为 act_act_123 等）
 * @returns {string} act_123 形式
 */
function normalizeAccountId(accountId) {
  const raw = String(accountId ?? '').trim()
  if (!raw) return raw
  // 反复剥掉前缀 act_，避免 act_act_xxx 归一化后仍带双层前缀（旧实现只剥一次会卡在 act_act_999）
  let core = raw
  while (/^act_/i.test(core)) {
    core = core.replace(/^act_/i, '')
  }
  return core ? `act_${core}` : raw
}

/**
 * 从复合 ID "act_xxx:objId" 解析出归一化后的 (accountId, objId)
 * @param {string} compositeId
 * @returns {{ accountId: string, objId: string } | null}
 */
function parseCompositeId(compositeId) {
  const s = String(compositeId ?? '').trim()
  const idx = s.indexOf(':')
  if (idx <= 0 || idx === s.length - 1) return null
  const accountId = normalizeAccountId(s.slice(0, idx))
  const objId = s.slice(idx + 1).trim()
  if (!accountId || !objId) return null
  return { accountId, objId }
}

export { normalizeAccountId, parseCompositeId }
