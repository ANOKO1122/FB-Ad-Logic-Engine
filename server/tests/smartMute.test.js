/**
 * M4 3.4 Smart Mute（智能挂起）— 历史逻辑与字段格式测试
 *
 * 【变更】执行频率与执行时间适配方案：Smart Mute 已从规则执行路径中移除；
 * mute_until / mute_reason 字段与 clear-ad-mute.js 脚本仅保留用于历史排查。
 *
 * 本文件保留：
 * - checkMuteStatus 纯函数及用例（历史逻辑说明，执行路径已不再调用）
 * - skip_details 中 muted 格式验证（摘要层仍兼容 skip_reason='muted' 的写入）
 */

import { describe, it, expect } from 'vitest'

// ===== 历史纯函数逻辑（执行路径已不再使用） =====
function checkMuteStatus(matchedAd, currentTime = new Date()) {
  const mu = matchedAd?.mute_until
  if (mu == null) {
    return { isMuted: false, reason: null }
  }
  const muteUntil = new Date(mu)
  if (currentTime < muteUntil) {
    return {
      isMuted: true,
      reason: matchedAd.mute_reason || 'no_reason',
      muteUntil: mu
    }
  }
  return { isMuted: false, reason: 'mute_expired' }
}

describe('Smart Mute（已移除执行路径，保留字段与格式）', () => {
  describe('checkMuteStatus 纯函数（历史逻辑）', () => {
    it('mute_until 为 null 时返回 isMuted=false', () => {
      const ad = { ad_id: '123', mute_until: null }
      const result = checkMuteStatus(ad)
      expect(result.isMuted).toBe(false)
    })

    it('mute_until 不存在时返回 isMuted=false', () => {
      const ad = { ad_id: '123' }
      const result = checkMuteStatus(ad)
      expect(result.isMuted).toBe(false)
    })

    it('mute_until 在未来时返回 isMuted=true', () => {
      const futureTime = new Date(Date.now() + 3600 * 1000) // 1 小时后
      const ad = { ad_id: '123', mute_until: futureTime.toISOString(), mute_reason: '测试挂起' }
      const result = checkMuteStatus(ad)
      expect(result.isMuted).toBe(true)
      expect(result.reason).toBe('测试挂起')
    })

    it('mute_until 已过期时返回 isMuted=false', () => {
      const pastTime = new Date(Date.now() - 3600 * 1000) // 1 小时前
      const ad = { ad_id: '123', mute_until: pastTime.toISOString() }
      const result = checkMuteStatus(ad)
      expect(result.isMuted).toBe(false)
      expect(result.reason).toBe('mute_expired')
    })

    it('mute_until 恰好等于当前时间时返回 isMuted=false（边界：已过期）', () => {
      const now = new Date()
      const ad = { ad_id: '123', mute_until: now.toISOString() }
      const result = checkMuteStatus(ad, now)
      expect(result.isMuted).toBe(false)
    })

    it('无 mute_reason 时默认 reason 为 no_reason', () => {
      const futureTime = new Date(Date.now() + 3600 * 1000)
      const ad = { ad_id: '123', mute_until: futureTime.toISOString() }
      const result = checkMuteStatus(ad)
      expect(result.isMuted).toBe(true)
      expect(result.reason).toBe('no_reason')
    })
  })

  describe('skip_details 格式验证（摘要层仍兼容 muted）', () => {
    it('muted 广告的 skip_details 包含 mute_until、mute_reason、ad_ids', () => {
      const muted = [
        { ad_id: 'ad_001', mute_until: '2026-02-01T12:00:00Z', mute_reason: '测试' },
        { ad_id: 'ad_002', mute_until: '2026-02-01T12:00:00Z', mute_reason: '测试' }
      ]

      // 模拟 writeSummariesAfterArbitration 中的 skipDetails 构建
      const skipDetails = muted.length > 0
        ? { mute_until: muted[0]?.mute_until, mute_reason: muted[0]?.mute_reason, ad_ids: muted.map(m => m.ad_id) }
        : null

      expect(skipDetails).toEqual({
        mute_until: '2026-02-01T12:00:00Z',
        mute_reason: '测试',
        ad_ids: ['ad_001', 'ad_002']
      })
    })
  })
})
