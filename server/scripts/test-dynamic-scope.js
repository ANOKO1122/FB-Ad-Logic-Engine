// server/scripts/test-dynamic-scope.js
// 手工触发 DynamicScopeService，按账户刷新规则的动态目标快照
import { refreshDynamicTargetsForAccount } from '../services/dynamicScopeService.js'

async function main() {
  // 允许从命令行传入账户 ID：node server/scripts/test-dynamic-scope.js act_xxx
  const accountId = process.argv[2] || 'act_1155891202142879'

  console.log('=== test-dynamic-scope ===')
  console.log('accountId =', accountId)

  try {
    const res = await refreshDynamicTargetsForAccount(accountId, {})
    console.log('\n[DynamicScope result]')
    console.log(JSON.stringify(res, null, 2))
    console.log('\n=== DONE test-dynamic-scope ===')
    process.exit(0)
  } catch (err) {
    console.error('[ERROR] refreshDynamicTargetsForAccount 出错:', err.message)
    console.error(err)
    process.exit(1)
  }
}

main()

