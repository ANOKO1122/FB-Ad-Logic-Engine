# 规则管理：广告系列 + CBO — 整体验证清单

按顺序执行即可完成整体验证。

---

## 一、前置：迁移与单测

1. **执行迁移 020**（若未执行过）
   ```bash
   mysql -u 你的用户名 -p 你的数据库名 < server/db/migrations/020_add_campaign_id_to_ad_snapshots.sql
   ```
   验证：`mysql` 里执行 `DESCRIBE ad_snapshots;`，应看到 `campaign_id` 列。

2. **跑单测**
   ```bash
   npm test
   ```
   应全部通过（含 actionExecutor、preFlight 等）。

---

## 二、数据层：campaign_id 有值

1. **触发一次 Today 同步**（项目根目录）
   ```bash
   node -e "import('./server/services/cronService.js').then(m=>m.manualSyncToday())"
   ```

2. **查库确认**
   ```sql
   SELECT ad_id, campaign_id, ad_set_id, data_date, synced_at
   FROM ad_snapshots
   WHERE account_id = 'act_你的账户ID'
   ORDER BY synced_at DESC LIMIT 20;
   ```
   最新一批行的 `campaign_id` 应有值（非 NULL）。

---

## 三、规则匹配：广告系列规则能匹配到广告

1. 启动后端 + 前端，登录规则管理。
2. 创建或使用一条规则：
   - 目标层级选 **「广告系列 (Campaign)」**；
   - 选一个你知道下面有广告的系列；
   - 条件简单即可（如花费 > 0）；
   - 动作可先选「仅模拟」或「暂停广告」等。
3. 保存后点 **「运行此规则」**。
4. 看**后端控制台日志**：
   - 应出现类似：`规则限定目标广告系列: 1 个，包含广告: N 个`（N ≥ 1）；
   - **不应**再出现「查询 campaign 下的广告ID失败」或「匹配 0 个广告」。

---

## 四、执行层：ABO / CBO 行为与日志

- **ABO**：规则作用在「广告组有预算」的广告上，执行**增加/减少预算**后，日志里应出现与「广告组」相关的成功信息。
- **CBO**：规则作用在「只有系列预算、广告组无预算」的广告上，执行**增加/减少预算**后，日志里应出现「广告系列(CBO)」相关成功信息（如「成功增加/减少预算 (广告系列(CBO))」）。

（若你当前账户没有 CBO 系列，可只验证 ABO + 上面第三步的「广告系列规则能匹配到广告」即代表链路通。）

---

## 五、UI：CBO 提示

1. 规则管理 → **新建规则** 或 **编辑规则**。
2. 在「4. 执行动作 (Then)」里添加 **「增加预算」** 或 **「减少预算」**。
3. 应立刻在区块顶部出现蓝色竖条提示框：
   - **若规则作用对象属于 CBO（优势+系列预算），执行增减预算时将调整整个广告系列预算，影响该系列下所有广告组。**
4. 删掉所有预算类动作后，该提示应消失。

---

## 六、编辑回显（未同步兜底）

1. 选一条**仅在 ad_snapshots 有、structure_ads 暂无**的广告作为规则目标（或先删 structure_ads 里该条再测）。
2. 保存规则后点 **「编辑规则」**。
3. 已选对象应显示**名称或 id**，而不是「id (未同步)」。

---

**总结**：做完一～三即可确认「广告系列规则 + campaign_id 写入 + 匹配」全链路；四确认执行层 ABO/CBO；五、六确认 UI 提示和编辑回显。单测通过 + 二～五（及可选六）通过即整体验证完成。

---

## 七、后续验收口径（补齐与回填）

- **写入时补齐**与**历史回填脚本**已保留，作为数据层稳定保障。
- **正式验收口径**（发布/上线前必验）：见 [验收口径_campaign_adset_补齐与回填.md](./验收口径_campaign_adset_补齐与回填.md)。
  - 今日 ad_snapshots 缺失统计为 0；
  - 近 7 天 ad_snapshots / daily_stats 缺失行回填后为 0；
  - campaign 聚合（今日与多天）不再 Empty set。
