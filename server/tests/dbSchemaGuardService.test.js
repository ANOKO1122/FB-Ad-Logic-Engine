import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('../utils/logger.js', () => ({
  default: mockLogger
}))

import {
  findMissingAutomationLogColumns,
  runAutomationLogsSchemaGuard
} from '../services/dbSchemaGuardService.js'

describe('dbSchemaGuardService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('能识别 automation_logs 缺失关键列', async () => {
    const execute = vi.fn().mockResolvedValue([[
      { COLUMN_NAME: 'run_id' },
      { COLUMN_NAME: 'object_type' },
      { COLUMN_NAME: 'object_id' }
    ]])

    const missing = await findMissingAutomationLogColumns(execute)
    expect(missing).toContain('object_name')
    expect(missing).toContain('preflight_mode')
    expect(missing).toContain('explanation')
  })

  it('缺列时输出告警日志', async () => {
    const execute = vi.fn().mockImplementation(async (sql, params = []) => {
      if (String(sql).includes('INFORMATION_SCHEMA.COLUMNS')) {
        if (params[0] === 'automation_logs') {
          return [[{ COLUMN_NAME: 'run_id' }, { COLUMN_NAME: 'object_type' }]]
        }
        if (params[0] === 'rule_execution_summaries') {
          return [[]]
        }
      }
      if (String(sql).includes('INFORMATION_SCHEMA.STATISTICS')) {
        return [[]]
      }
      return [[]]
    })

    const result = await runAutomationLogsSchemaGuard(execute)
    expect(result.ok).toBe(false)
    expect(mockLogger.warn).toHaveBeenCalled()
    const warnCall = mockLogger.warn.mock.calls.find(([msg]) => msg === '数据库Schema缺失关键字段或索引，可能导致审计失败或性能下降')
    expect(warnCall).toBeTruthy()
    expect(warnCall[1]).toMatchObject({
      missingColumns: expect.any(Object),
      missingIndexes: expect.any(Object)
    })
  })

  it('关键列和索引齐全时返回 ok=true', async () => {
    const execute = vi.fn().mockImplementation(async (sql, params = []) => {
      if (String(sql).includes('INFORMATION_SCHEMA.COLUMNS')) {
        if (params[0] === 'automation_logs') {
          return [[
            { COLUMN_NAME: 'run_id' },
            { COLUMN_NAME: 'object_type' },
            { COLUMN_NAME: 'object_id' },
            { COLUMN_NAME: 'object_name' },
            { COLUMN_NAME: 'preflight_mode' },
            { COLUMN_NAME: 'explanation' }
          ]]
        }
        if (params[0] === 'rule_execution_summaries') {
          return [[{ COLUMN_NAME: 'summary_scope' }]]
        }
      }
      if (String(sql).includes('INFORMATION_SCHEMA.STATISTICS')) {
        if (params[0] === 'rule_execution_summaries') return [[{ INDEX_NAME: 'idx_summary_scope' }]]
        if (params[0] === 'rule_matched_objects') {
          return [[{ INDEX_NAME: 'uq_rule_account_type_object' }, { INDEX_NAME: 'idx_account_rule_type' }]]
        }
        if (params[0] === 'daily_stats') {
          return [[{ INDEX_NAME: 'idx_daily_account_date_adset' }, { INDEX_NAME: 'idx_daily_account_date_campaign' }]]
        }
        if (params[0] === 'ad_snapshots') {
          return [[{ INDEX_NAME: 'idx_snap_account_data_date_adset' }, { INDEX_NAME: 'idx_snap_account_data_date_campaign' }]]
        }
      }
      return [[]]
    })

    const result = await runAutomationLogsSchemaGuard(execute)
    expect(result.ok).toBe(true)
    expect(result.missingColumns.automation_logs).toEqual([])
    expect(result.missingColumns.rule_execution_summaries).toEqual([])
    expect(result.missingIndexes.rule_execution_summaries).toEqual([])
  })
})

