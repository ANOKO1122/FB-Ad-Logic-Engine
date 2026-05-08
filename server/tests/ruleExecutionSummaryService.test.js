import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockExecute = vi.fn()

vi.mock('../db/connection.js', () => ({
  default: {
    execute: (...args) => mockExecute(...args)
  }
}))

import { insertRuleExecutionSummary } from '../services/ruleExecutionSummaryService.js'

describe('ruleExecutionSummaryService', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockExecute.mockResolvedValue([{}])
  })

  it('应写入 summary_scope=account', async () => {
    await insertRuleExecutionSummary({
      runId: 'run-1',
      ruleId: 1001,
      ruleName: 'scope-account',
      accountId: 'act_1',
      userId: 1,
      ownerId: 2,
      matchedCount: 1,
      executedCount: 1,
      failedCount: 0,
      skippedCount: 0,
      status: 'matched',
      summaryScope: 'account',
      evaluatedAt: new Date('2026-01-01T00:00:00.000Z')
    })

    expect(mockExecute).toHaveBeenCalledTimes(1)
    const [sql, params] = mockExecute.mock.calls[0]
    expect(sql).toContain('summary_scope')
    expect(params[11]).toBe('account')
  })

  it('应写入 summary_scope=rollup', async () => {
    await insertRuleExecutionSummary({
      runId: 'run-2',
      ruleId: 1002,
      ruleName: 'scope-rollup',
      accountId: 'multi',
      userId: 1,
      ownerId: 2,
      matchedCount: 5,
      executedCount: 5,
      failedCount: 0,
      skippedCount: 0,
      status: 'matched',
      summaryScope: 'rollup',
      evaluatedAt: new Date('2026-01-01T00:00:00.000Z')
    })

    expect(mockExecute).toHaveBeenCalledTimes(1)
    const [sql, params] = mockExecute.mock.calls[0]
    expect(sql).toContain('summary_scope')
    expect(params[11]).toBe('rollup')
  })
})
