import 'dotenv/config';
import { FacebookMarketingAPI } from '../index.js';
import { runHourlyStructureFullRotation } from '../services/structureSyncService.js';
import pool from '../db/connection.js';
import logger from '../utils/logger.js';

/**
 * 手动触发结构同步轮转脚本
 * 逻辑与定时任务一致：
 * 1. 检查全局锁（sync:hourly_rotation）
 * 2. 检查 API Usage 和熔断状态
 * 3. 选取优先级最高的 5 个账户（基于 structure_sync_status）
 * 4. 执行 syncAccountStructureAds（近3天数据）
 */
async function run() {
  logger.info('🚀 [Script] 开始手动触发结构轮转（同步5个账户）...');
  
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  if (!token) {
    logger.error('❌ [Script] 缺少 FACEBOOK_ACCESS_TOKEN 环境变量');
    process.exit(1);
  }

  const api = new FacebookMarketingAPI(token);

  try {
    // 调用核心轮转逻辑，参数 maxAccounts: 5
    const result = await runHourlyStructureFullRotation(api, { maxAccounts: 5 });
    
    if (result.skipped) {
      logger.warn(`⚠️ [Script] 轮转被跳过，原因: ${result.reason}`);
      if (result.reason === 'rotation_running') {
        logger.warn('   提示：可能是定时任务正在运行，或者上次运行异常退出导致锁未释放。');
        logger.warn('   如果是锁未释放，请等待 MySQL 连接超时或手动释放锁 sync:hourly_rotation');
      }
    } else {
      logger.info(`✅ [Script] 轮转执行完成`);
      logger.info(`   同步账户数: ${result.synced}`);
    }
  } catch (error) {
    logger.error('❌ [Script] 执行过程中发生未捕获错误:', error);
  } finally {
    // 显式关闭连接池，确保脚本能退出
    await pool.end();
    logger.info('👋 [Script] 脚本结束');
    process.exit(0);
  }
}

run();
