// 测试脚本：验证 Ingestor 是否正确提取原始计数字段
// 注意：这是 Dry Run 测试，不会实际调用 Facebook API

import { 
  extractPurchaseValue, 
  extractActionCount 
} from './server/services/ingestorService.js'

// 测试 1：提取 purchase_value
console.log('=== 测试 1：提取 purchase_value ===')
const mockActionValues = [
  { action_type: 'offsite_conversion.fb_pixel_purchase', value: '150.50' },
  { action_type: 'other_action', value: '10' }
]
const purchaseValue = extractPurchaseValue(mockActionValues)
console.log(`✅ purchase_value: ${purchaseValue} (期望: 150.5)`)

// 测试 2：提取 add_to_cart_count
console.log('\n=== 测试 2：提取 add_to_cart_count ===')
const mockActions = [
  { action_type: 'offsite_conversion.fb_pixel_add_to_cart', value: '5' },
  { action_type: 'other_action', value: '10' }
]
const addToCartCount = extractActionCount(mockActions, [
  'offsite_conversion.fb_pixel_add_to_cart',
  'add_to_cart'
])
console.log(`✅ add_to_cart_count: ${addToCartCount} (期望: 5)`)

// 测试 3：防御性编程测试（空数组）
console.log('\n=== 测试 3：防御性编程测试（空数组） ===')
const emptyPurchaseValue = extractPurchaseValue([])
const emptyActionCount = extractActionCount([], ['test'])
console.log(`✅ 空数组 purchase_value: ${emptyPurchaseValue} (期望: 0)`)
console.log(`✅ 空数组 action_count: ${emptyActionCount} (期望: 0)`)

// 测试 4：防御性编程测试（null/undefined）
console.log('\n=== 测试 4：防御性编程测试（null/undefined） ===')
const nullPurchaseValue = extractPurchaseValue(null)
const nullActionCount = extractActionCount(null, ['test'])
console.log(`✅ null purchase_value: ${nullPurchaseValue} (期望: 0)`)
console.log(`✅ null action_count: ${nullActionCount} (期望: 0)`)

console.log('\n✅ 所有测试完成！')

