import logger from '../utils/logger.js'

export const REQUIRED_AUTOMATION_LOG_COLUMNS = [
  'run_id',
  'object_type',
  'object_id',
  'object_name',
  'preflight_mode',
  'explanation'
]

export const REQUIRED_SUMMARY_COLUMNS = ['summary_scope']
export const REQUIRED_SUMMARY_INDEXES = ['idx_summary_scope']
export const REQUIRED_RULE_MATCHED_OBJECT_INDEXES = ['uq_rule_account_type_object', 'idx_account_rule_type']
export const REQUIRED_LEVEL_AGG_INDEXES = {
  daily_stats: ['idx_daily_account_date_adset', 'idx_daily_account_date_campaign'],
  ad_snapshots: ['idx_snap_account_data_date_adset', 'idx_snap_account_data_date_campaign']
}

async function findMissingColumns(execute, tableName, requiredColumns) {
  if (!Array.isArray(requiredColumns) || requiredColumns.length === 0) return []
  const [rows] = await execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME IN (${requiredColumns.map(() => '?').join(',')})`,
    [tableName, ...requiredColumns]
  )

  const existing = new Set(rows.map((row) => String(row.COLUMN_NAME || '').toLowerCase()))
  return requiredColumns.filter((column) => !existing.has(column))
}

async function findMissingIndexes(execute, tableName, requiredIndexes) {
  if (!Array.isArray(requiredIndexes) || requiredIndexes.length === 0) return []
  const [rows] = await execute(
    `SELECT INDEX_NAME
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME IN (${requiredIndexes.map(() => '?').join(',')})`,
    [tableName, ...requiredIndexes]
  )

  const existing = new Set(rows.map((row) => String(row.INDEX_NAME || '').toLowerCase()))
  return requiredIndexes.filter((indexName) => !existing.has(indexName))
}

export async function findMissingAutomationLogColumns(execute) {
  return findMissingColumns(execute, 'automation_logs', REQUIRED_AUTOMATION_LOG_COLUMNS)
}

export async function runAutomationLogsSchemaGuard(execute) {
  try {
    const automationMissingColumns = await findMissingColumns(execute, 'automation_logs', REQUIRED_AUTOMATION_LOG_COLUMNS)
    const summaryMissingColumns = await findMissingColumns(execute, 'rule_execution_summaries', REQUIRED_SUMMARY_COLUMNS)
    const summaryMissingIndexes = await findMissingIndexes(execute, 'rule_execution_summaries', REQUIRED_SUMMARY_INDEXES)
    const ruleMatchedMissingIndexes = await findMissingIndexes(execute, 'rule_matched_objects', REQUIRED_RULE_MATCHED_OBJECT_INDEXES)
    const dailyStatsMissingIndexes = await findMissingIndexes(execute, 'daily_stats', REQUIRED_LEVEL_AGG_INDEXES.daily_stats)
    const snapshotsMissingIndexes = await findMissingIndexes(execute, 'ad_snapshots', REQUIRED_LEVEL_AGG_INDEXES.ad_snapshots)

    const missingColumns = {
      automation_logs: automationMissingColumns,
      rule_execution_summaries: summaryMissingColumns
    }
    const missingIndexes = {
      rule_execution_summaries: summaryMissingIndexes,
      rule_matched_objects: ruleMatchedMissingIndexes,
      daily_stats: dailyStatsMissingIndexes,
      ad_snapshots: snapshotsMissingIndexes
    }

    const hasMissingColumns = Object.values(missingColumns).some((arr) => arr.length > 0)
    const hasMissingIndexes = Object.values(missingIndexes).some((arr) => arr.length > 0)

    if (hasMissingColumns || hasMissingIndexes) {
      logger.warn('数据库Schema缺失关键字段或索引，可能导致审计失败或性能下降', {
        missingColumns,
        missingIndexes,
        expectedMigrations: [
          '045_rule_matched_objects_typed_snapshot.sql',
          '046_add_level_aggregation_indexes.sql',
          '047_add_generic_object_fields_to_automation_logs.sql',
          '048_add_explanation_to_automation_logs.sql',
          '049_add_summary_scope_to_rule_execution_summaries.sql',
          '050_ensure_explanation_column_on_automation_logs.sql',
          '051_ensure_summary_scope_index.sql'
        ]
      })
      return { ok: false, missingColumns, missingIndexes }
    }

    logger.info('数据库Schema自检通过', {
      checkedTables: ['automation_logs', 'rule_execution_summaries', 'rule_matched_objects', 'daily_stats', 'ad_snapshots'],
      requiredColumns: {
        automation_logs: REQUIRED_AUTOMATION_LOG_COLUMNS,
        rule_execution_summaries: REQUIRED_SUMMARY_COLUMNS
      },
      requiredIndexes: {
        rule_execution_summaries: REQUIRED_SUMMARY_INDEXES,
        rule_matched_objects: REQUIRED_RULE_MATCHED_OBJECT_INDEXES,
        daily_stats: REQUIRED_LEVEL_AGG_INDEXES.daily_stats,
        ad_snapshots: REQUIRED_LEVEL_AGG_INDEXES.ad_snapshots
      }
    })
    return { ok: true, missingColumns, missingIndexes }
  } catch (error) {
    logger.warn('数据库Schema自检失败（跳过阻断）', {
      message: error.message
    })
    return { ok: false, missingColumns: null, missingIndexes: null, error: error.message }
  }
}

