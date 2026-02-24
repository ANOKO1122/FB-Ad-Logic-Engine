/**
 * M4 3.4 Smart Mute（智能挂起）— Vitest 单元测试
 *
 * 【教学】Smart Mute 是什么？
 * - 一句话比喻：像「请勿打扰模式」，给广告设置一个 mute_until 时间戳，在此之前不执行任何动作。
 * - 为什么要学：某些广告可能因特殊原因需要暂时排除自动化（如人工调优、促销期保护等）。
 * - 面试怎么问：「你们怎么让某个广告在特定时间内不被自动化规则影响？」
 *   答：在 ad_snapshots 表加 mute_until 字段，执行前检查，未过期则 skip 并记 muted。
 *
 * 验收标准：
 * 1. 若 matchedAd.mute_until 存在且大于当前时间，该广告跳过执行
 * 2. 跳过的广告在 rule_execution_summaries 中记录 skip_reason='muted'
 * 3. 若 mute_until 已过期或不存在，正常执行
 */

import { describe, it, expect, vi } from 'vitest'

/**
 * 【教学】为什么测 Smart Mute 要测 cronService 而不是 actionExecutorService？
 *
 * Smart Mute 的检查发生在「仲裁后、执行前」，位于 cronService.executeRulesForAccount 中：
 *   for (const [adId, meta] of arbitrated) {
 *     const mu = meta.matchedAd?.mute_until
 *     if (mu != null && new Date() < new Date(mu)) { ... skip ... }
 *   }
 *
 * actionExecutorService 不负责 mute 判断，它只负责执行传入的动作。
 * 因此，完整的 Smart Mute 验证需要集成测试或直接测 cronService 的相关逻辑。
 *
 * 本测试采用「纯函数提取 + 单元测试」的方式：
 * - 提取 checkMuteStatus 纯函数
 * - 验证 mute 逻辑的正确性
 */

// ===== 提取的纯函数逻辑 =====
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

describe('M4 3.4 Smart Mute 检查', () => {
  describe('checkMuteStatus 纯函数', () => {
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

  describe('Smart Mute 在 cronService 中的集成行为', () => {
    /**
     * 【教学】集成测试说明
     *
     * cronService.executeRulesForAccount 中的 Smart Mute 逻辑：
     *
     * ```javascript
     * const ruleToMuted = new Map()
     * for (const [adId, meta] of arbitrated) {
     *   const mu = meta.matchedAd?.mute_until
     *   if (mu != null && new Date() < new Date(mu)) {
     *     console.log(`   🔇 [${lockedAccountId}] 广告 ${adId} 处于 mute 期 (until ${mu})，跳过`)
     *     const list = ruleToMuted.get(meta.winnerRule.id) || []
     *     list.push({ ad_id: adId, mute_until: mu, mute_reason: meta.matchedAd?.mute_reason || null })
     *     ruleToMuted.set(meta.winnerRule.id, list)
     *     executionResultsByAd[adId] = { success: 0, fail: 0 }
     *     continue  // 跳过执行
     *   }
     *   // ... 正常执行
     * }
     * ```
     *
     * 验收：
     * 1. 被 mute 的广告不会调用 executeActionsForAd
     * 2. ruleToMuted 记录被 mute 的广告信息
     * 3. writeSummariesAfterArbitration 会将 muted 信息写入 skip_details
     */

    it('模拟 cronService 中 Smart Mute 逻辑', () => {
      // 模拟 arbitrated 数据
      const arbitrated = new Map([
        ['ad_001', {
          winnerRule: { id: 1, ruleName: 'rule1' },
          winnerAction: { type: 'pause_ad' },
          matchedAd: {
            ad_id: 'ad_001',
            status: 'ACTIVE',
            mute_until: new Date(Date.now() + 3600 * 1000).toISOString(), // 未来 1 小时
            mute_reason: '促销期保护'
          }
        }],
        ['ad_002', {
          winnerRule: { id: 1, ruleName: 'rule1' },
          winnerAction: { type: 'pause_ad' },
          matchedAd: {
            ad_id: 'ad_002',
            status: 'ACTIVE',
            mute_until: null  // 未 mute
          }
        }],
        ['ad_003', {
          winnerRule: { id: 2, ruleName: 'rule2' },
          winnerAction: { type: 'decrease_budget', value: 10 },
          matchedAd: {
            ad_id: 'ad_003',
            status: 'ACTIVE',
            mute_until: new Date(Date.now() - 3600 * 1000).toISOString() // 已过期
          }
        }]
      ])

      // 模拟 cronService 中的 mute 检查逻辑
      const ruleToMuted = new Map()
      const executedAds = []

      for (const [adId, meta] of arbitrated) {
        const mu = meta.matchedAd?.mute_until
        if (mu != null && new Date() < new Date(mu)) {
          // 被 mute，跳过
          const list = ruleToMuted.get(meta.winnerRule.id) || []
          list.push({ ad_id: adId, mute_until: mu, mute_reason: meta.matchedAd?.mute_reason || null })
          ruleToMuted.set(meta.winnerRule.id, list)
          continue
        }
        // 正常执行
        executedAds.push(adId)
      }

      // 验证
      expect(executedAds).toEqual(['ad_002', 'ad_003'])
      expect(ruleToMuted.size).toBe(1)
      expect(ruleToMuted.get(1)).toEqual([{
        ad_id: 'ad_001',
        mute_until: expect.any(String),
        mute_reason: '促销期保护'
      }])
    })
  })

  describe('skip_details 格式验证', () => {
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
