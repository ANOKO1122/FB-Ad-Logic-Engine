// Dry Run 模式测试脚本 - 测试 Data Ingestor 服务
// 这个脚本不会调用真实的 Facebook API，只测试代码逻辑
// 按照 .cursorrules 的要求：分段代码、逐行解释

import dotenv from 'dotenv'
dotenv.config()

// ============================================
// 第一部分：导入依赖和 Mock 数据
// ============================================

// 导入要测试的函数（注意：这里只导入我们需要的函数）
import { parseActions, generateSyncSessionId } from './server/services/ingestorService.js'
import pool from './server/db/connection.js'

// Mock 数据：模拟 Facebook API 返回的 insights 数据
const mockInsights = [
  {
    ad_id: '123456789',
    ad_name: '测试广告1',
    spend: '10.50',
    ctr: '0.0250',  // 2.5%
    cpc: '0.50',
    cpm: '5.00',
    roas: '2.50',
    actions: [
      {
        action_type: 'offsite_conversion.fb_pixel_purchase',
        value: '5'
      },
      {
        action_type: 'offsite_conversion.fb_pixel_add_to_cart',
        value: '10'
      },
      {
        action_type: 'link_click',
        value: '20'
      }
    ],
    action_values: [
      {
        action_type: 'offsite_conversion.fb_pixel_purchase',
        value: '26.25'  // 收入 = 5次购买 * 平均订单价值
      }
    ]
  },
  {
    ad_id: '987654321',
    ad_name: '测试广告2',
    spend: '20.00',
    ctr: '0.0300',  // 3.0%
    cpc: '0.60',
    cpm: '6.00',
    roas: '1.80',
    actions: [
      {
        action_type: 'offsite_conversion.fb_pixel_purchase',
        value: '3'
      }
    ],
    action_values: [
      {
        action_type: 'offsite_conversion.fb_pixel_purchase',
        value: '36.00'
      }
    ]
  }
]

// ============================================
// 第二部分：测试 parseActions 函数
// ============================================

console.log('='.repeat(60))
console.log('🧪 测试 1: parseActions 函数')
console.log('='.repeat(60))

function testParseActions() {
  console.log('\n📋 测试用例 1.1: 正常解析 actions 数组')
  
  const actions1 = [
    { action_type: 'offsite_conversion.fb_pixel_purchase', value: '5' },
    { action_type: 'offsite_conversion.fb_pixel_add_to_cart', value: '10' },
    { action_type: 'link_click', value: '20' }  // 这个不应该被累加
  ]
  
  const result1 = parseActions(actions1)
  console.log('  输入:', JSON.stringify(actions1, null, 2))
  console.log('  输出:', result1)
  console.log('  预期: 5 (只返回购买次数)')
  
  // 断言验证（现在只返回购买次数，不返回加购次数）
  if (result1 === 5) {
    console.log('  ✅ 测试通过')
  } else {
    console.log('  ❌ 测试失败')
    throw new Error('parseActions 测试失败')
  }
  
  console.log('\n📋 测试用例 1.2: 空数组')
  const result2 = parseActions([])
  console.log('  输入: []')
  console.log('  输出:', result2)
  if (result2 === 0) {
    console.log('  ✅ 测试通过')
  } else {
    console.log('  ❌ 测试失败')
    throw new Error('parseActions 空数组测试失败')
  }
  
  console.log('\n📋 测试用例 1.3: null 或 undefined')
  const result3 = parseActions(null)
  const result4 = parseActions(undefined)
  console.log('  输入: null')
  console.log('  输出:', result3)
  if (result3 === 0) {
    console.log('  ✅ 测试通过')
  } else {
    console.log('  ❌ 测试失败')
    throw new Error('parseActions null 测试失败')
  }
}

// ============================================
// 第三部分：测试 generateSyncSessionId 函数
// ============================================

console.log('\n' + '='.repeat(60))
console.log('🧪 测试 2: generateSyncSessionId 函数')
console.log('='.repeat(60))

function testGenerateSyncSessionId() {
  console.log('\n📋 测试用例 2.1: 生成唯一 ID')
  
  const id1 = generateSyncSessionId()
  const id2 = generateSyncSessionId()
  
  console.log('  第一次生成:', id1)
  console.log('  第二次生成:', id2)
  console.log('  格式检查: 是否以 sync_ 开头？', id1.startsWith('sync_'))
  
  // 断言验证
  if (id1.startsWith('sync_') && id2.startsWith('sync_') && id1 !== id2) {
    console.log('  ✅ 测试通过（ID 唯一且格式正确）')
  } else {
    console.log('  ❌ 测试失败')
    throw new Error('generateSyncSessionId 测试失败')
  }
}

// ============================================
// 第四部分：测试数据转换逻辑（Dry Run）
// ============================================

console.log('\n' + '='.repeat(60))
console.log('🧪 测试 3: 数据转换逻辑（Dry Run）')
console.log('='.repeat(60))

function testDataTransformation() {
  console.log('\n📋 测试用例 3.1: 转换 mock insights 数据')
  
  // 模拟 saveSnapshotsToDb 中的数据转换逻辑
  const accountId = 'act_123456789'
  const ownerId = 1
  const syncSessionId = generateSyncSessionId()
  const syncedAt = new Date()
  const timezoneName = 'Asia/Shanghai'
  
  const transformed = mockInsights.map(insight => {
    const actions = insight.actions || []
    const purchases = parseActions(actions) // 现在只返回购买次数
    
    // 计算 ROAS（用于测试，实际不入库）
    let roas = 0
    if (Array.isArray(insight.action_values)) {
      const purchaseValue = insight.action_values.find(
        av => av.action_type === 'offsite_conversion.fb_pixel_purchase'
      )
      if (purchaseValue && purchaseValue.value) {
        const spend = parseFloat(insight.spend || 0)
        const revenue = parseFloat(purchaseValue.value || 0)
        roas = spend > 0 ? revenue / spend : 0
      }
    }
    
    if (insight.roas !== undefined) {
      roas = parseFloat(insight.roas || 0)
    }
    
    return {
      accountId: String(accountId),
      adId: String(insight.ad_id || ''),
      adName: insight.ad_name || null,
      ownerId: ownerId,
      spend: parseFloat(insight.spend || 0),
      purchases: purchases,
      roas: roas, // 仅用于测试显示，实际不入库
      actions: actions,
      syncSessionId: syncSessionId,
      syncedAt: syncedAt,
      timezoneName: timezoneName || 'UTC'
    }
  })
  
  console.log('  转换后的数据:')
  transformed.forEach((item, index) => {
    console.log(`\n  广告 ${index + 1}:`)
    console.log(`    adId: ${item.adId}`)
    console.log(`    adName: ${item.adName}`)
    console.log(`    spend: ${item.spend}`)
    console.log(`    purchases: ${item.purchases}`)
    console.log(`    roas: ${item.roas ? item.roas.toFixed(2) : 'N/A'}`)
  })
  
  // 验证数据格式
  const isValid = transformed.every(item => 
    item.accountId && 
    item.adId && 
    typeof item.spend === 'number' &&
    typeof item.purchases === 'number'
  )
  
  if (isValid) {
    console.log('\n  ✅ 数据转换测试通过（所有字段格式正确）')
  } else {
    console.log('\n  ❌ 数据转换测试失败')
    throw new Error('数据转换测试失败')
  }
  
  return transformed
}

// ============================================
// 第五部分：主测试函数
// ============================================

async function runAllTests() {
  try {
    console.log('\n🚀 开始 Dry Run 模式测试...\n')
    
    // 测试 1: parseActions
    testParseActions()
    
    // 测试 2: generateSyncSessionId
    testGenerateSyncSessionId()
    
    // 测试 3: 数据转换
    const transformed = testDataTransformation()
    
    console.log('\n' + '='.repeat(60))
    console.log('✅ 所有测试通过！')
    console.log('='.repeat(60))
    console.log('\n📊 测试总结:')
    console.log(`  - parseActions: ✅ 通过`)
    console.log(`  - generateSyncSessionId: ✅ 通过`)
    console.log(`  - 数据转换: ✅ 通过`)
    console.log(`  - 转换了 ${transformed.length} 条记录`)
    console.log('\n💡 提示: 这是 Dry Run 模式，没有写入数据库')
    console.log('   如果要测试数据库写入，请使用真实的账户ID和Token')
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message)
    console.error('错误堆栈:', error.stack)
    process.exit(1)
  } finally {
    // 关闭数据库连接
    await pool.end()
    console.log('\n🔌 数据库连接已关闭')
  }
}

// 执行测试
runAllTests()

