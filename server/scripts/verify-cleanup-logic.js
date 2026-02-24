/**
 * 验证数据清洗逻辑一致性
 * 检查所有清洗逻辑是否都统一为 spend > 0
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const filePath = join(__dirname, '../services/ingestorService.js')
const content = readFileSync(filePath, 'utf-8')

console.log('🔍 检查数据清洗逻辑一致性...\n')

// 查找所有 spend > 0 的过滤逻辑
const lines = content.split('\n')
const spendFilters = []

lines.forEach((line, index) => {
  const lineNum = index + 1
  // 查找 return spend > 0 的模式
  if (line.includes('return spend > 0') || 
      (line.includes('spend > 0') && line.includes('return'))) {
    spendFilters.push({
      line: lineNum,
      content: line.trim()
    })
  }
})

console.log(`📊 找到 ${spendFilters.length} 处 spend > 0 过滤逻辑：\n`)

spendFilters.forEach((filter, index) => {
  console.log(`${index + 1}. 第 ${filter.line} 行:`)
  console.log(`   ${filter.content}`)
  console.log('')
})

// 检查是否有不一致的过滤逻辑
const inconsistentPatterns = [
  /return spend > 0 \|\| impressions > 0/,
  /return spend > 0 \|\| linkClicks > 0/,
  /return spend > 0 \|\| hasPurchases/
]

let hasInconsistent = false
lines.forEach((line, index) => {
  inconsistentPatterns.forEach(pattern => {
    if (pattern.test(line)) {
      console.log(`⚠️  发现不一致的过滤逻辑（第 ${index + 1} 行）：`)
      console.log(`   ${line.trim()}`)
      hasInconsistent = true
    }
  })
})

if (!hasInconsistent) {
  console.log('✅ 所有清洗逻辑已统一为 spend > 0')
} else {
  console.log('\n❌ 发现不一致的过滤逻辑，需要修复')
}

console.log('\n📋 验证结果：')
console.log(`   - 找到 ${spendFilters.length} 处 spend > 0 过滤`)
console.log(`   - 不一致逻辑: ${hasInconsistent ? '❌ 有' : '✅ 无'}`)
