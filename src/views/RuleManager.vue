<template>
  <div class="rule-page">
    <!-- 免责提示 Banner -->
    <div class="disclaimer-banner">
      <span class="icon">⚠️</span>
      <div class="text">
        <strong>安全提示：</strong>
        在 Facebook 后台手动开启被系统关闭的广告前，请先在本系统<strong>暂停相关规则</strong>，避免被再次自动关闭。
      </div>
    </div>

    <!-- 顶部操作栏 -->
    <div class="header-actions">
      <h2>自动化规则</h2>
      <div class="actions">
        <div v-if="isAdminFromRules" ref="ownerDropdownRef" class="owner-filter-wrap">
          <div
            class="owner-filter-trigger"
            role="button"
            tabindex="0"
            aria-haspopup="listbox"
            :aria-expanded="ownerFilterOpen"
            title="不选表示全部负责人；可多选筛选"
            @click="ownerFilterOpen = !ownerFilterOpen"
            @keydown.enter.prevent="ownerFilterOpen = !ownerFilterOpen"
            @keydown.space.prevent="ownerFilterOpen = !ownerFilterOpen"
          >
            <div class="owner-filter-trigger-text">
              <span class="owner-filter-label-inline">负责人:</span>
              <span class="owner-filter-value">{{ ownerFilterDisplayValue }}</span>
            </div>
            <div class="owner-filter-trigger-actions">
              <button
                v-if="selectedOwnerIds.length > 0"
                type="button"
                class="owner-filter-clear"
                aria-label="清除筛选"
                @click.stop="clearOwnerFilter"
              >
                <span aria-hidden="true">×</span>
              </button>
              <span class="owner-filter-chevron" :class="{ open: ownerFilterOpen }">▼</span>
            </div>
          </div>
          <Transition name="owner-dropdown">
            <div v-show="ownerFilterOpen" class="owner-filter-panel" role="listbox">
              <div
                class="owner-filter-option owner-filter-option-clear"
                role="option"
                @click.stop="clearOwnerFilter"
              >
                清除筛选 (全选)
              </div>
              <div
                class="owner-filter-option"
                :class="{ selected: includeNoOwner }"
                role="option"
                :aria-selected="includeNoOwner"
                @click.stop="toggleNoOwnerOption"
              >
                <span class="owner-filter-checkbox" :class="{ selected: includeNoOwner }">
                  <span v-show="includeNoOwner" class="owner-filter-check">✓</span>
                </span>
                <span class="owner-filter-option-label">无（管理员创建）</span>
              </div>
              <div
                v-for="o in ownersList"
                :key="o.id"
                class="owner-filter-option"
                :class="{ selected: selectedOwnerIds.includes(o.id) }"
                role="option"
                :aria-selected="selectedOwnerIds.includes(o.id)"
                @click.stop="toggleOwnerOption(o.id)"
              >
                <span class="owner-filter-checkbox" :class="{ selected: selectedOwnerIds.includes(o.id) }">
                  <span v-show="selectedOwnerIds.includes(o.id)" class="owner-filter-check">✓</span>
                </span>
                <span class="owner-filter-option-label">{{ o.owner_name || o.ownerName || o.id }}</span>
              </div>
            </div>
          </Transition>
        </div>
        <template v-if="rules.length > 0">
          <button type="button" class="btn secondary small" @click="collapseAllRuleCards">全部折叠</button>
          <button type="button" class="btn secondary small" @click="expandAllRuleCards">全部展开</button>
        </template>
        <template v-if="!bulkMode && rules.length > 0">
          <button type="button" class="btn secondary" @click="enterBulkMode">
            <span class="icon">☐</span> 批量添加账户
          </button>
        </template>
        <template v-if="bulkMode">
          <span class="bulk-counter">已选 {{ selectedCount }} 条</span>
          <button type="button" class="btn secondary small" @click="toggleSelectAllRules">
            {{ selectedCount === rules.length ? '取消全选' : '全选' }}
          </button>
          <button type="button" class="btn secondary small" @click="exitBulkMode">取消选择</button>
          <button type="button" class="btn" :disabled="selectedCount === 0" @click="openBatchModal">
            <span class="icon">+</span> 为已选规则添加账户
          </button>
        </template>
        <button class="btn" @click="openCreateRule">
          <span class="icon">+</span> 新建规则
        </button>
      </div>
    </div>

    <!-- 规则列表 (Grid 布局) -->
    <div v-if="rules.length === 0" class="empty-rules">
      <div class="empty-icon">⚡</div>
      <h3>暂无自动化规则</h3>
      <p>规则可以帮你 24 小时监控广告，自动止损或扩量。</p>
      <div class="empty-actions">
        <button class="btn" @click="openCreateRule">创建第一条规则</button>
        <button
          v-if="showBootstrapButton"
          class="btn secondary"
          :disabled="bootstrapLoading"
          @click="bootstrapFromTemplates"
        >
          {{ bootstrapLoading ? '生成中...' : '一键生成常用模板规则' }}
        </button>
      </div>
      <p v-if="showBootstrapButton" class="empty-note">将生成 disabled 的半成品规则，请补全账户与配置后再启用。</p>
      <div v-if="bootstrapFeedback.text" class="empty-feedback" :class="bootstrapFeedback.type">
        {{ bootstrapFeedback.text }}
      </div>
    </div>

    <div v-else class="rules-grid">
      <div 
        v-for="r in rules" 
        :key="r.id" 
        class="rule-card"
        :class="{ disabled: !r.enabled }"
        @click="onCardClick(r, $event)"
      >
        <div class="card-header">
          <label v-if="bulkMode" class="rule-select-checkbox" :class="{ checked: selectedRuleIds.includes(r.id) }" @click.stop="toggleRuleSelection(r.id)">
            <span class="rule-select-box" :class="{ checked: selectedRuleIds.includes(r.id) }">
              <span v-show="selectedRuleIds.includes(r.id)" class="rule-select-check">✓</span>
            </span>
          </label>
          <div class="card-header-titles">
            <h3 class="rule-name">
              {{ r.name }}
              <span v-if="r.conditionsVersion === 2" class="badge-dnf">DNF/多组</span>
            </h3>
            <button
              type="button"
              class="btn-text card-expand-toggle"
              :aria-expanded="isRuleCardExpanded(r.id)"
              :aria-label="isRuleCardExpanded(r.id) ? '收起规则详情' : '展开规则详情'"
              @click.stop="toggleRuleCardExpand(r.id)"
            >
              {{ isRuleCardExpanded(r.id) ? '收起详情' : '展开详情' }}
              <span class="card-expand-chevron" :class="{ open: isRuleCardExpanded(r.id) }" aria-hidden="true">▼</span>
            </button>
          </div>
          <div class="switch-wrapper">
            <label class="switch">
              <input type="checkbox" :checked="r.enabled" @change="toggleRule(r, $event.target.checked)">
              <span class="slider round"></span>
            </label>
          </div>
        </div>

        <div class="card-body">
          <!-- 显示规则作用的账户 -->
          <div v-if="r.accountId" class="section account-info">
            <span class="label">📊 账户:</span>
            <span class="account-id">{{ r.accountId }}</span>
          </div>
          <div v-if="isAdminFromRules" class="section owner-info">
            <span class="label">负责人:</span>
            <span class="owner-name">{{ r.ownerName || '未分配' }}</span>
          </div>
          <div class="section dynamic-meta">
            <span class="label">动态筛选：</span>
            <span class="pill" :class="r.useDynamicScope ? 'dynamic-on' : 'dynamic-off'">
              {{ r.useDynamicScope ? '已开启' : '已关闭' }}
            </span>
            <span v-if="r.useDynamicScope" class="pill" :class="dynamicStatusClass(r.dynamicScopeStatus)">
              {{ dynamicStatusLabel(r.dynamicScopeStatus) }}
            </span>
            <span v-if="r.useDynamicScope && r.matchedCount != null" class="muted" style="margin-left: 6px;">当前生效 {{ r.matchedCount }} 个对象</span>
          </div>
          <div v-if="r.excludeSummaryText" class="hint">
            {{ r.excludeSummaryText }}
          </div>
          <div class="section">
            <span class="label">IF (当满足以下条件时):</span>
            <div class="conditions-list">
              <div v-for="(c, idx) in visibleConditionsForCard(r)" :key="idx" class="pill condition">
                <span v-if="r.conditionsVersion === 2 && c._groupIndex" class="muted">组{{ c._groupIndex }}: </span>
                {{ metricLabel(c.metric) }} {{ opLabel(c.operator) }} {{ c.value }}
                <span v-if="c.time_window" class="muted">({{ timeWindowLabel(c.time_window, c) }})</span>
              </div>
            </div>
            <p
              v-if="!isRuleCardExpanded(r.id) && extraCondGroupsCount(r) > 0"
              class="cond-more-hint"
            >
              另有 {{ extraCondGroupsCount(r) }} 组条件未显示，点击「展开详情」查看全部。
            </p>
          </div>

          <div class="arrow">↓</div>

          <div class="section">
            <span class="label">THEN (执行操作):</span>
            <div class="actions-list">
              <div v-for="(a, idx) in r.actions" :key="idx" class="pill action" :class="getActionClass(a.type)">
                {{ actionLabel(a.type) }}
                <span v-if="a.type === 'set_dynamic_budget'" class="val">{{ formatDynamicBudgetValue(a) }}</span>
                <span v-if="a.value != null && (a.type === 'increase_budget' || a.type === 'decrease_budget' || a.type === 'set_budget')" class="val">{{ formatBudgetValue(a) }}</span>
              </div>
            </div>
          </div>
          <div class="section execution-meta">
            <span class="label">执行频率：</span><span class="muted">{{ formatIntervalDisplay(r.executionIntervalMinutes ?? 15) }}</span>
            <span class="label">执行时间：</span><span class="muted">{{ formatExecutionTimeDisplay(r.executionTimeWindows) }}</span>
          </div>
        </div>

        <div class="card-footer">
          <button class="btn-text" @click="refreshDynamicScopeForRule(r)" :disabled="refreshingRuleId === r.id || !r.id">
            {{ refreshingRuleId === r.id ? '重算中...' : '重算动态范围' }}
          </button>
          <button class="btn-text" @click="runThisRule(r)" :disabled="runningRuleId === r.id">
            {{ runningRuleId === r.id ? '执行中...' : '运行此规则' }}
          </button>
          <button class="btn-text" @click="openEditRule(r)">编辑</button>
          <button class="btn-text danger" @click="deleteRule(r)">删除</button>
        </div>
      </div>
    </div>

    <!-- 规则编辑模态框 -->
    <div v-if="showRuleModal" class="modal-overlay" @click="showRuleModal = false">
      <div class="modal-content wide" @click.stop>
        <div class="modal-header">
          <h3>{{ editingRuleId ? '编辑规则' : '新建规则' }}</h3>
          <button class="close-btn" @click="showRuleModal = false">×</button>
        </div>

        <div class="modal-body">
          <!-- 区块1：基本信息 -->
          <div class="section-block">
            <h4 class="section-title">1. 基本信息</h4>
            <div class="form-row">
              <div class="form-group flex-2">
                <label>规则名称</label>
                <input v-model="ruleForm.name" placeholder="例如：亏损严重自动关停" class="input-text" />
              </div>
              <div class="form-group flex-1">
                <label>模拟运行 (Dry Run)</label>
                <div class="switch-wrapper">
                  <label class="switch">
                    <input type="checkbox" v-model="ruleForm.isSimulation">
                    <span class="slider round"></span>
                  </label>
                  <span class="switch-label">{{ ruleForm.isSimulation ? '🧪 仅模拟日志' : '⚡ 真实执行' }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 区块2：作用对象 -->
          <div class="section-block">
            <h4 class="section-title">2. 作用对象 (Where)</h4>
            <div class="form-group">
              <label>广告账户（可多选）</label>
              <div class="form-row">
                <select v-model="accountToAdd" class="select account-add-select" :disabled="accountLoading" @change="onAddAccount">
                  <option value="">添加账户</option>
                  <option v-for="a in accountsFilteredForAdd" :key="a.id" :value="a.id">
                    {{ a.name }} ({{ a.id }})
                  </option>
                </select>
                <button class="btn secondary" @click="loadAccounts" :disabled="accountLoading">
                  {{ accountLoading ? '加载中...' : '刷新账户' }}
                </button>
                <button class="btn secondary" @click="selectAllAccounts" :disabled="accountLoading || !accounts.length">
                  全选账户
                </button>
                <button class="btn secondary" @click="clearAllAccounts" :disabled="!selectedAccountIds.length">
                  清空账户
                </button>
                <button class="btn secondary" @click="refreshScopeItemsWithSync" :disabled="selectedAccountIds.length !== 1 || scopeLoading" title="仅在选择一个广告账户时可刷新列表（触发该账户结构同步）">
                  {{ scopeLoading ? '加载中...' : '刷新列表' }}
                </button>
              </div>
              <div v-if="selectedAccountIds.length" class="selected-accounts-tags">
                <span v-for="aid in selectedAccountIds" :key="aid" class="tag account-tag">
                  {{ accountLabel(aid) }}
                  <button type="button" class="tag-remove" aria-label="移除" @click="removeAccount(aid)">×</button>
                </span>
              </div>
              <div class="hint">仅展示你有权限的账户；多选后下方列表为多账户合并结果</div>
              <div v-if="accountError" class="alert error">{{ accountError }}</div>
            </div>
            <div class="form-group">
              <label>目标层级</label>
              <div class="radio-group">
                <label v-for="opt in levelOptions" :key="opt.value" class="radio-label">
                  <input type="radio" v-model="ruleForm.targetLevel" :value="opt.value">
                  {{ opt.label }}
                </label>
              </div>
            </div>

            <div class="form-group">
              <label>动态筛选</label>
              <div class="form-row dynamic-scope-row">
                <div class="switch-wrapper">
                  <label class="switch">
                    <input type="checkbox" v-model="ruleForm.useDynamicScope">
                    <span class="slider round"></span>
                  </label>
                  <span class="switch-label">{{ ruleForm.useDynamicScope ? '开启（按监控范围自动更新目标）' : '关闭（仅使用手动勾选目标）' }}</span>
                </div>
                <div class="dynamic-max-wrap" v-if="ruleForm.useDynamicScope">
                  <label>动态匹配上限</label>
                  <input
                    v-model.number="ruleForm.maxDynamicMatches"
                    type="number"
                    min="1"
                    max="5000"
                    class="input-number"
                  />
                </div>
              </div>
            </div>

            <!-- 监控范围条件（可选）：按条件自动勾选下方列表中的对象 -->
            <div
              class="form-group scope-condition-block"
              :class="{ 'scope-condition-block-disabled': isScopeConditionsDisabled }"
            >
              <label>监控范围条件（可选）</label>
              <div class="hint scope-condition-hint">根据下方条件自动勾选匹配的对象；不填则需手动勾选。</div>
              <div v-if="isScopeConditionsDisabled" class="hint scope-condition-disabled-tip">
                未开启动态筛选时，监控范围条件不生效。请开启动态筛选或手动勾选目标对象。
              </div>
              <div class="conditions-container scope-condition-rows">
                <div
                  v-for="(row, idx) in scopeConditionRows"
                  :key="row.id"
                  class="condition-row scope-condition-row"
                >
                  <span v-if="idx > 0" class="join-label">AND</span>
                  <span v-else class="join-placeholder"></span>
                  <select
                    v-model="row.field"
                    class="select scope-field-select"
                    :disabled="isScopeConditionsDisabled"
                    @change="onScopeConditionFieldChange(row)"
                  >
                    <option value="name">名称</option>
                    <option value="status">状态</option>
                    <option value="created_within">创建时间段</option>
                  </select>
                  <select
                    v-model="row.operator"
                    class="select scope-operator-select"
                    :disabled="isScopeConditionsDisabled || row.field === 'created_within'"
                  >
                    <template v-if="row.field === 'name'">
                      <option value="include">包含</option>
                      <option value="exclude">不包含</option>
                    </template>
                    <template v-else-if="row.field === 'created_within'">
                      <option value="include">包含</option>
                    </template>
                    <template v-else>
                      <option value="equals">等于</option>
                      <option value="not_equals">不等于</option>
                    </template>
                  </select>
                  <template v-if="row.field === 'name'">
                    <input
                      v-model.trim="row.value"
                      type="text"
                      class="input-text scope-value-input"
                      placeholder="请输入名称 (例: 优化师_项目)"
                      :disabled="isScopeConditionsDisabled"
                      :class="{ 'input-error': !isScopeConditionsDisabled && scopeConditionRowError(row) }"
                    />
                  </template>
                  <template v-else-if="row.field === 'created_within'">
                    <select
                      v-model="row.value"
                      class="select scope-value-select"
                      :disabled="isScopeConditionsDisabled"
                      :class="{ 'input-error': !isScopeConditionsDisabled && scopeConditionRowError(row) }"
                    >
                      <option value="">请选择</option>
                      <option value="24">近 24 小时内</option>
                      <option value="48">近 48 小时内</option>
                      <option value="72">近 72 小时内</option>
                      <option value="custom">自定义小时内</option>
                    </select>
                    <input
                      v-if="row.value === 'custom'"
                      v-model.number="row.customHours"
                      type="number"
                      min="1"
                      max="720"
                      class="input-text scope-value-input scope-custom-hours"
                      placeholder="请输入小时数 (1–720)"
                      :disabled="isScopeConditionsDisabled"
                      :class="{ 'input-error': !isScopeConditionsDisabled && scopeConditionRowError(row) }"
                    />
                  </template>
                  <template v-else>
                    <select
                      v-model="row.value"
                      class="select scope-value-select"
                      :disabled="isScopeConditionsDisabled"
                      :class="{ 'input-error': !isScopeConditionsDisabled && scopeConditionRowError(row) }"
                    >
                      <option value="">请选择</option>
                      <option value="active_only">所有投放中</option>
                      <option value="paused_only">所有已暂停</option>
                      <option value="active_and_paused">所有投放中和已暂停</option>
                    </select>
                  </template>
                  <button
                    v-if="scopeConditionRows.length > 1"
                    type="button"
                    class="btn-icon danger"
                    title="删除"
                    :disabled="isScopeConditionsDisabled"
                    @click="removeScopeConditionRow(idx)"
                  >×</button>
                  <div v-if="!isScopeConditionsDisabled && scopeConditionRowError(row)" class="scope-row-error">{{ scopeConditionRowError(row) }}</div>
                </div>
                <button
                  v-if="scopeConditionRows.length < SCOPE_CONDITION_MAX_ROWS"
                  type="button"
                  class="link-add-scope link-add-scope-button"
                  :disabled="isScopeConditionsDisabled"
                  @click="addScopeConditionRow"
                >添加监控范围 ({{ scopeConditionRows.length }}/{{ SCOPE_CONDITION_MAX_ROWS }})</button>
                <span v-else class="hint">已达 {{ SCOPE_CONDITION_MAX_ROWS }} 条上限</span>
                <div v-if="scopeApplyMessage" class="scope-apply-row">
                  <span class="scope-apply-message">{{ scopeApplyMessage }}</span>
                </div>
              </div>
            </div>

            <div class="form-group">
              <label>选择目标对象（可多选）</label>
              <div v-if="!ruleForm.useDynamicScope" class="scope-filters">
                <input
                  v-model="scopeSearch"
                  class="input-text"
                  placeholder="搜索名称或ID"
                />
              </div>
              <div v-if="!selectedAccountIds.length" class="empty-hint">请先选择至少一个广告账户</div>
              <template v-else>
                <!-- 开启动态：仅展示当前匹配数，不可勾选目标（做法 A） -->
                <div v-if="ruleForm.useDynamicScope" class="scope-list">
                  <div class="scope-dynamic-summary">当前匹配 {{ ruleForm.matchedCount ?? 0 }} 个对象（按监控条件实时计算，无需选择目标）</div>
                </div>
                <!-- 关闭动态：完整搜索、勾选、同步/全选/清空、加载更多 -->
                <div v-else class="scope-list">
                  <div class="scope-actions">
                    <span>已选 {{ ruleForm.targetIds.length }} 个</span>
                    <div class="scope-buttons">
                      <button v-if="showSyncButton" class="btn-tiny btn-sync-highlight" @click="syncConfigFromMatch" :disabled="isApplyingScopeConditions">同步</button>
                      <button class="btn-tiny" @click="selectAllScope" :disabled="!canSelectAll || isApplyingScopeConditions">全选</button>
                      <button class="btn-tiny" @click="clearScopeSelection" :disabled="!ruleForm.targetIds.length || isApplyingScopeConditions">清空</button>
                    </div>
                  </div>
                  <div v-if="syncJustDoneMessage" class="sync-just-done-hint">{{ syncJustDoneMessage }}</div>
                  <div v-if="ruleForm.targetIds.length" class="selected-preview">
                    <span v-for="id in selectedTargetPreview" :key="id" class="tag" :class="{ 'tag-missing': resolvedSelectedMap.get(String(id))?.missing, 'tag-invalid': invalidIdSet.has(String(id)) }">
                      <span v-if="invalidIdSet.has(String(id))">{{ resolvedSelectedMap.get(String(id))?.name || id }} [已失效/未同步]</span>
                      <span v-else-if="resolvedSelectedMap.get(String(id))?.name">
                        {{ resolvedSelectedMap.get(String(id)).name }}
                      </span>
                      <span v-else-if="resolvedSelectedMap.get(String(id))?.missing">{{ id }} (未同步)</span>
                      <span v-else-if="!scopeLoadedIdSet.has(String(id))">[已勾选] 未加载数据 (ID: {{ id }})</span>
                      <span v-else>{{ id }}</span>
                    </span>
                    <span v-if="ruleForm.targetIds.length > selectedTargetPreview.length" class="muted">
                      还有 {{ ruleForm.targetIds.length - selectedTargetPreview.length }} 个
                    </span>
                  </div>
                  <div v-if="missingSelectedCount > 0" class="hint">
                    注意：有 {{ missingSelectedCount }} 个已选对象未出现在当前列表中（可能未加载到当前页或已被删除），但仍会保留在规则里。
                  </div>
                  <div v-if="scopeLoading" class="loading">正在加载列表...</div>
                  <div v-else-if="!filteredScopeItems.length" class="empty-hint">暂无可选对象</div>
                  <div v-else class="scope-items">
                    <label v-for="item in filteredScopeItems" :key="scopeItemKey(item)" class="scope-item" :class="{ 'scope-item-active': item.effective_status === 'ACTIVE', 'scope-item-paused': item.effective_status === 'PAUSED' }">
                      <input type="checkbox" :value="scopeItemValue(item)" v-model="ruleForm.targetIds">
                      <span class="name">{{ item.name || '-' }}</span>
                      <span class="id">{{ item.id }}</span>
                      <span v-if="selectedAccountIds.length > 1" class="account-badge">{{ item.account_id || '' }}</span>
                    </label>
                  </div>
                  <div v-if="scopePagingAfter" class="scope-more">
                    <button class="btn-tiny" @click="loadMoreScopeItems" :disabled="scopeLoading">
                      {{ scopeLoading ? '加载中...' : '加载更多' }}
                    </button>
                  </div>
                </div>
              </template>
            </div>

            <div class="form-group">
              <label>排除名单（可选）</label>
              <div class="hint">命中的对象会从最终作用范围中剔除（公式：最终 = 动态 ∪ 手动 - 排除）</div>
              <div class="scope-filters">
                <input
                  v-model="excludeScopeSearch"
                  class="input-text"
                  placeholder="搜索名称或ID"
                />
              </div>
              <div v-if="!selectedAccountIds.length" class="empty-hint">请先选择至少一个广告账户并加载列表</div>
              <div v-else class="scope-list">
                <div class="scope-actions">
                  <span>已排除 {{ ruleForm.excludeTargetIds.length }} 个</span>
                  <div class="scope-buttons">
                    <button class="btn-tiny" @click="selectAllExcludeScope" :disabled="!canSelectAllExclude">全选</button>
                    <button class="btn-tiny" @click="clearExcludeScopeSelection" :disabled="!ruleForm.excludeTargetIds.length">清空</button>
                  </div>
                </div>
                <div v-if="excludeAreaLoading" class="loading">正在加载列表...</div>
                <div v-else-if="!filteredExcludeScopeItems.length" class="empty-hint">暂无可选对象</div>
                <div v-else class="scope-items">
                  <label v-for="item in filteredExcludeScopeItems" :key="`exclude-${scopeItemKey(item)}`" class="scope-item" :class="{ 'scope-item-active': item.effective_status === 'ACTIVE', 'scope-item-paused': item.effective_status === 'PAUSED' }">
                    <input type="checkbox" :value="scopeItemValue(item)" v-model="ruleForm.excludeTargetIds">
                    <span class="name">{{ item.name || '-' }}</span>
                    <span class="id">{{ item.id }}</span>
                    <span v-if="selectedAccountIds.length > 1" class="account-badge">{{ item.account_id || '' }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- 区块3：触发条件（2.3.1 方案B：线性列表 + 全局时间窗口） -->
          <div class="section-block">
            <div class="section-header">
              <h4 class="section-title">3. 触发条件 (When)</h4>
              <div class="template-actions">
                <button
                  v-for="t in templates"
                  :key="t.id"
                  class="btn-tiny"
                  @click="applyTemplate(t)"
                >
                  {{ t.name }}
                </button>
              </div>
            </div>
            <div class="hint" style="margin-bottom: 12px;">本规则所有条件共用同一时间窗口</div>

            <!-- 比值类指标口径提示（TASKS 2.3 前端口径防呆） -->
            <div v-if="ratioMetricTip" class="ratio-tip">
              <span class="icon">💡</span>
              <span v-html="ratioMetricTip"></span>
              <button
                v-if="zeroClickTemplate"
                type="button"
                class="btn-tiny"
                @click="applyTemplate(zeroClickTemplate)"
              >
                改用空耗模板
              </button>
            </div>

            <!-- 全局时间窗口 -->
            <div class="form-group">
              <label>时间窗口</label>
              <div class="when-time-row">
                <select v-model="whenTimeWindow" class="select window-select" @change="onWhenTimeWindowChange">
                  <option value="today">今天</option>
                  <option value="yesterday">昨天</option>
                  <option value="last_3_days">近3天</option>
                  <option value="last_3_days_excluding_today">近3天（不含今天）</option>
                  <option value="last_5_days">近5天</option>
                  <option value="last_5_days_excluding_today">近5天（不含今天）</option>
                  <option value="last_7_days">近7天</option>
                  <option value="last_7_days_excluding_today">近7天（不含今天）</option>
                  <option value="lifetime">至今为止</option>
                  <option value="custom_range">自定义范围</option>
                </select>
                <template v-if="whenTimeWindow === 'custom_range'">
                  <input
                    type="date"
                    v-model="(whenCustomRange ||= getDefaultWhenCustomRange()).since"
                    class="input-date"
                    title="起始日期"
                  />
                  <span class="date-sep">至</span>
                  <input
                    type="date"
                    v-model="(whenCustomRange ||= getDefaultWhenCustomRange()).until"
                    class="input-date"
                    title="截止日期"
                  />
                </template>
              </div>
            </div>

            <!-- 线性条件列表：第2行起显示 AND/OR -->
            <div class="conditions-container">
              <div v-for="(line, idx) in whenLines" :key="idx" class="condition-row when-line-row">
                <select
                  v-if="idx > 0"
                  v-model="line.join"
                  class="select join-select"
                  title="与上一条件的逻辑关系"
                >
                  <option value="AND">AND</option>
                  <option value="OR">OR</option>
                </select>
                <span v-else class="join-placeholder"></span>
                <select v-model="line.metric" class="select metric-select">
                  <option v-for="opt in conditionMetricOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
                <select v-model="line.operator" class="select operator-select">
                  <option value="gt">大于 (>)</option>
                  <option value="lt">小于 (<)</option>
                  <option value="gte">大于等于 (≥)</option>
                  <option value="lte">小于等于 (≤)</option>
                  <option value="eq">等于 (=)</option>
                </select>
                <input type="number" v-model.number="line.value" class="input-number" step="0.01" />
                <button class="btn-icon danger" @click="removeWhenLine(idx)" title="删除">×</button>
              </div>
              <button class="btn-add" @click="addWhenLine">+ 添加条件</button>
            </div>
          </div>

          <!-- 区块4：执行动作 -->
          <div class="section-block">
            <h4 class="section-title">4. 执行动作 (Then)</h4>
            <p v-if="hasBudgetAction" class="cbo-hint">
              💡 若规则作用对象属于 <strong>CBO（优势+系列预算）</strong>，执行增减预算时将调整整个广告系列预算，影响该系列下所有广告组。
            </p>
            <div v-for="(a, idx) in ruleForm.actions" :key="idx" class="action-row">
              <select v-model="a.type" class="select action-select" @change="onActionTypeChange(a)">
                <option value="pause_ad">⏸ 暂停目标</option>
                <option value="activate_ad">▶️ 启用目标</option>
                <option value="increase_budget">💰 增加预算</option>
                <option value="decrease_budget">💸 减少预算</option>
                <option value="set_budget">📌 设置预算为固定值</option>
                <option value="set_dynamic_budget">📈 设置动态预算值</option>
              </select>
              <template v-if="a.type.includes('budget')">
                <template v-if="a.type === 'set_dynamic_budget'">
                  <select v-model="a.metric" class="select action-unit-select" title="公式指标">
                    <option v-for="opt in dynamicBudgetMetricOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                  </select>
                  <input
                    type="number"
                    v-model.number="a.multiplier"
                    class="input-number"
                    placeholder="30"
                    min="0.01"
                    max="9999"
                    step="0.01"
                  />
                  <span class="action-unit">× $</span>
                  <span class="action-hint">（公式结果会直接设置为目标预算）</span>
                  <label class="budget-cap-label">预算下限（美元，可选）</label>
                  <input
                    type="number"
                    :value="a.min_daily_budget != null ? (a.min_daily_budget / 100) : ''"
                    @input="onMinBudgetInput($event, a)"
                    class="input-number budget-cap-input"
                    placeholder="不填则不限制"
                    min="1"
                    step="0.01"
                  />
                  <label class="budget-cap-label">预算上限（美元，可选）</label>
                  <input
                    type="number"
                    :value="a.max_daily_budget != null ? (a.max_daily_budget / 100) : ''"
                    @input="onMaxBudgetInput($event, a)"
                    class="input-number budget-cap-input"
                    placeholder="不填则不限制"
                    min="1"
                    step="0.01"
                  />
                  <span class="action-hint">（实际调整广告组或广告系列预算）</span>
                </template>
                <template v-else>
                <select v-if="a.type !== 'set_budget'" v-model="a.value_unit" class="select action-unit-select" title="调整单位">
                  <option value="percent">百分比</option>
                  <option value="usd">固定金额</option>
                </select>
                <input
                  v-if="a.type === 'set_budget'"
                  type="number"
                  v-model.number="a.value"
                  class="input-number"
                  placeholder="30"
                  min="0.01"
                  max="9999"
                  step="0.01"
                />
                <input
                  v-else-if="(a.value_unit || 'percent') === 'percent'"
                  type="number"
                  v-model.number="a.value"
                  class="input-number"
                  placeholder="10"
                  min="1"
                  max="100"
                  step="1"
                />
                <input
                  v-else
                  type="number"
                  v-model.number="a.value"
                  class="input-number"
                  placeholder="5"
                  min="0.01"
                  max="9999"
                  step="0.01"
                />
                <span class="action-unit">{{ a.type === 'set_budget' || (a.value_unit || 'percent') === 'usd' ? '$' : '%' }}</span>
                <span class="action-hint">{{ a.type === 'set_budget' ? '（设置为固定美元）' : ((a.value_unit || 'percent') === 'usd' ? '（按美元增减）' : '（按百分比增减）') }}</span>
                <template v-if="a.type === 'increase_budget'">
                  <label class="budget-cap-label">预算上限（美元，可选）</label>
                  <input
                    type="number"
                    :value="a.max_daily_budget != null ? (a.max_daily_budget / 100) : ''"
                    @input="onMaxBudgetInput($event, a)"
                    class="input-number budget-cap-input"
                    placeholder="不填则不限制"
                    min="1"
                    step="0.01"
                  />
                </template>
                <template v-else-if="a.type === 'decrease_budget'">
                  <label class="budget-cap-label">预算下限（美元，可选）</label>
                  <input
                    type="number"
                    :value="a.min_daily_budget != null ? (a.min_daily_budget / 100) : ''"
                    @input="onMinBudgetInput($event, a)"
                    class="input-number budget-cap-input"
                    placeholder="不填则不限制"
                    min="1"
                    step="0.01"
                  />
                </template>
                </template>
              </template>
              <span v-else class="placeholder">-</span>
              <button class="btn-icon danger" @click="ruleForm.actions.splice(idx, 1)">×</button>
            </div>
            <button class="btn-add" @click="addAction">+ 添加操作</button>
          </div>

          <!-- 区块5：执行频率与执行时间（文档：执行频率与执行时间 — 适配方案） -->
          <div class="section-block">
            <h4 class="section-title">5. 执行频率与执行时间</h4>
            <p class="muted">每个广告触发本规则后，至少间隔以下时间才会再次触发；执行时间未指定则全天允许。</p>
            <div class="form-row">
              <label class="label">执行频率（每广告）</label>
              <select v-model="ruleForm.executionIntervalPreset" class="select">
                <option v-for="p in INTERVAL_PRESETS" :key="p.value" :value="p.value">{{ p.label }}</option>
              </select>
              <input
                v-if="ruleForm.executionIntervalPreset === 'custom'"
                type="number"
                v-model.number="ruleForm.executionIntervalHoursCustom"
                class="input-number"
                placeholder="小时数"
                min="0.1"
                max="720"
                step="0.5"
              />
              <span v-if="ruleForm.executionIntervalPreset === 'custom'" class="muted">小时</span>
            </div>
            <div class="form-row">
              <label class="label">允许执行时间（北京时间）</label>
              <label><input type="radio" :value="true" v-model="executionTimeAllDay"> 全天</label>
              <label><input type="radio" :value="false" v-model="executionTimeAllDay"> 指定时间段</label>
            </div>
            <div v-if="!executionTimeAllDay" class="execution-time-range">
              <div class="execution-time-row">
                <label class="label">开始时间</label>
                <TimePicker24 v-model="executionTimeStart" />
              </div>
              <div class="execution-time-row">
                <label class="label">结束时间</label>
                <TimePicker24 v-model="executionTimeEnd" />
              </div>
              <p class="execution-time-hint muted">可只填一个时段；24 小时制。结束时间早于开始时间表示到次日（如 20:00–05:00 表示当晚 20:00 至次日 05:00）。</p>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn secondary" @click="showRuleModal = false">取消</button>
          <button class="btn" @click="saveRule" :disabled="isApplyingScopeConditions">保存规则</button>
        </div>
      </div>
    </div>

    <!-- 批量添加账户弹窗 -->
    <div v-if="showBatchModal" class="modal-overlay" @click="closeBatchModal">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h3>批量添加账户</h3>
          <button class="close-btn" @click="closeBatchModal">×</button>
        </div>
        <div class="modal-body">
          <p class="batch-hint">
            已选 <strong>{{ selectedCount }}</strong> 条规则，选择要追加的广告账户。不会替换已有账户。
          </p>

          <div v-if="batchAccounts.length > 0" class="batch-accounts-grid">
            <label
              v-for="acc in batchAccounts"
              :key="acc.id"
              class="batch-account-item"
              :class="{ checked: batchAccountIds.includes(acc.id) }"
              @click.stop="toggleBatchAccount(acc.id)"
            >
              <span class="batch-account-checkbox" :class="{ checked: batchAccountIds.includes(acc.id) }">
                <span v-show="batchAccountIds.includes(acc.id)">✓</span>
              </span>
              <span class="batch-account-name">{{ acc.name }}</span>
              <span class="batch-account-id">{{ acc.id }}</span>
            </label>
          </div>
          <div v-else-if="!batchError" class="batch-empty">加载账户列表中...</div>

          <div v-if="batchAccounts.length > 0" class="batch-select-actions">
            <button type="button" class="btn-text" @click="selectAllBatchAccounts">全选</button>
            <button type="button" class="btn-text" @click="clearBatchAccounts">清空</button>
          </div>

          <!-- 结果展示 -->
          <div v-if="batchResult" class="batch-result">
            <div class="batch-result-title" :class="batchResult.summary.failed > 0 ? 'warn' : 'ok'">
              {{ batchResult.summary.failed > 0 ? '⚠️ 部分完成' : '✅ 批量添加完成' }}
            </div>
            <div class="batch-summary">
              <span class="batch-stat">请求 <strong>{{ batchResult.summary.requested }}</strong> 条</span>
              <span class="batch-stat batch-stat-ok">新增 <strong>{{ batchResult.summary.updated }}</strong> 条</span>
              <span class="batch-stat">未变 <strong>{{ batchResult.summary.unchanged }}</strong> 条</span>
              <span v-if="batchResult.summary.failed > 0" class="batch-stat batch-stat-err">失败 <strong>{{ batchResult.summary.failed }}</strong> 条</span>
              <span v-if="batchResult.summary.pendingDataRules > 0" class="batch-stat batch-stat-pending">
                待结构同步后生效 <strong>{{ batchResult.summary.pendingDataRules }}</strong> 条
              </span>
            </div>
          </div>
          <div v-if="batchError" class="alert error">{{ batchError }}</div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn secondary" @click="closeBatchModal">取消</button>
          <button
            type="button"
            class="btn"
            :disabled="batchAccountIds.length === 0 || batchSaving"
            @click="submitBatchAddAccounts"
          >
            {{ batchSaving ? '提交中...' : '确认追加' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { authFetch } from '../utils/authFetch.js'
import facebookApi from '../services/facebookApi'
import {
  linesToV2Groups,
  v2ToLines,
  v1ToLines,
  createDefaultWhenLine,
  getDefaultWhenCustomRange
} from '../utils/conditionsTransform'
import TimePicker24 from '../components/TimePicker24.vue'

export default {
  name: 'RuleManager',
  components: { TimePicker24 },
  setup() {
    const rules = ref([])
    const templates = ref([])
    const showRuleModal = ref(false)
    const editingRuleId = ref(null)
    /** 规则列表接口返回的 isAdmin，用于显示负责人筛选与卡片负责人信息 */
    const isAdminFromRules = ref(false)
    /** 负责人列表（仅管理员可见，用于下拉多选） */
    const ownersList = ref([])
    /** 选中的负责人 ID 列表，空表示「全部负责人」 */
    const selectedOwnerIds = ref([])
    /** 是否同时筛选「管理员创建」的规则（卡片负责人显示为“无”） */
    const includeNoOwner = ref(false)
    /** 负责人筛选下拉是否展开 */
    const ownerFilterOpen = ref(false)
    /** 负责人下拉容器（用于点击外部关闭） */
    const ownerDropdownRef = ref(null)

    /** 批量模式：是否处于手动多选规则卡片状态 */
    const bulkMode = ref(false)
    /** 批量模式：已勾选的规则 ID 列表 */
    const selectedRuleIds = ref([])
    /** 批量模式选中计数 */
    const selectedCount = computed(() => selectedRuleIds.value.length)

    /** 批量添加账户弹窗 */
    const showBatchModal = ref(false)
    /** 批量弹窗内可选账户列表 */
    const batchAccounts = ref([])
    /** 批量弹窗内已选账户 ID */
    const batchAccountIds = ref([])
    /** 批量提交中 */
    const batchSaving = ref(false)
    /** 批量提交结果 */
    const batchResult = ref(null)
    /** 批量提交错误 */
    const batchError = ref('')

    /** 进入批量多选模式 */
    const enterBulkMode = () => {
      selectedRuleIds.value = []
      bulkMode.value = true
    }

    /** 退出批量多选模式，清空所有选中状态 */
    const exitBulkMode = () => {
      bulkMode.value = false
      selectedRuleIds.value = []
    }

    /** 切换某条规则的选中状态 */
    const toggleRuleSelection = (ruleId) => {
      const idx = selectedRuleIds.value.indexOf(ruleId)
      if (idx >= 0) {
        selectedRuleIds.value.splice(idx, 1)
      } else {
        selectedRuleIds.value.push(ruleId)
      }
    }

    /** 全选 / 取消全选：已全部选中时清空，否则选入当前列表所有规则 */
    const toggleSelectAllRules = () => {
      if (selectedCount.value === rules.value.length) {
        selectedRuleIds.value = []
      } else {
        selectedRuleIds.value = rules.value.map(r => r.id)
      }
    }

    /** 批量模式下点击整张卡片切换选中；排除按钮/开关/输入框等交互元素 */
    const onCardClick = (rule, event) => {
      if (!bulkMode.value) return
      if (event.target.closest('button, input, select, textarea, label, a')) return
      toggleRuleSelection(rule.id)
    }

    /** 打开批量添加账户弹窗 */
    const openBatchModal = async () => {
      if (selectedCount.value === 0) return
      batchError.value = ''
      batchResult.value = null
      batchAccountIds.value = []
      batchAccounts.value = []
      showBatchModal.value = true
      try {
        batchAccounts.value = await facebookApi.getAdAccounts()
      } catch (e) {
        batchError.value = `加载账户失败：${e.message}`
      }
    }

    /** 关闭批量添加账户弹窗 */
    const closeBatchModal = () => {
      showBatchModal.value = false
      batchAccountIds.value = []
      batchResult.value = null
      batchError.value = ''
    }

    /** 切换批量弹窗内的账户选择 */
    const toggleBatchAccount = (accountId) => {
      const idx = batchAccountIds.value.indexOf(accountId)
      if (idx >= 0) {
        batchAccountIds.value.splice(idx, 1)
      } else {
        batchAccountIds.value.push(accountId)
      }
    }

    /** 全选批量弹窗内账户 */
    const selectAllBatchAccounts = () => {
      batchAccountIds.value = batchAccounts.value.map(a => a.id)
    }

    /** 清空批量弹窗内账户选择 */
    const clearBatchAccounts = () => {
      batchAccountIds.value = []
    }

    /** 提交批量添加账户 */
    const submitBatchAddAccounts = async () => {
      if (batchAccountIds.value.length === 0 || selectedRuleIds.value.length === 0) return
      batchSaving.value = true
      batchError.value = ''
      batchResult.value = null
      try {
        const resp = await authFetch('/api/rules/batch/add-accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ruleIds: selectedRuleIds.value,
            accountIds: batchAccountIds.value
          })
        })
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error || '批量添加失败')
        batchResult.value = data
        // 成功后重新加载规则列表
        await loadRules()
      } catch (e) {
        batchError.value = e.message || '批量添加失败'
      } finally {
        batchSaving.value = false
      }
    }

    /** 规则列表卡片折叠：localStorage key 按用户隔离 */
    const CARD_EXPAND_STORAGE_PREFIX = 'fb_rule_cards_expanded_v1:'
    const currentUserId = ref(null)
    /** 已展开的规则 id；未列入视为折叠（默认全部折叠） */
    const expandedRuleIds = ref([])

    const running = ref(false)
    const runningRuleId = ref(null)
    const refreshingRuleId = ref(null)
    const bootstrapLoading = ref(false)
    const bootstrapFeedback = ref({ type: 'info', text: '' })
    const rulesLoaded = ref(false)
    
    const levelOptions = [
      { label: '广告 (Ad)', value: 'ad' },
      { label: '广告组 (AdSet)', value: 'adset' },
      { label: '广告系列 (Campaign)', value: 'campaign' }
    ]

    const createEmptyRule = () => ({
      name: '',
      enabled: true,
      isSimulation: false,
      targetLevel: 'ad',
      targetIds: [],
      excludeTargetIds: [],
      logicOperator: 'AND',
      timezoneName: 'UTC',
      conditions: [],
      actions: [],
      executionIntervalMinutes: 15,
      executionIntervalPreset: '15m',
      executionIntervalHoursCustom: null,
      executionTimeWindows: [],
      useDynamicScope: true,
      maxDynamicMatches: 1000,
      matchedCount: null,
      invalidIds: [],
      lastMatchedHistory: null
    })

    const INTERVAL_PRESETS = [
      { value: '15m', label: '15 分钟', minutes: 15 },
      { value: '30m', label: '30 分钟', minutes: 30 },
      { value: '60m', label: '1 小时', minutes: 60 },
      { value: '180m', label: '3 小时', minutes: 180 },
      { value: '360m', label: '6 小时', minutes: 360 },
      { value: 'custom', label: '自定义（小时）', minutes: null }
    ]
    const mapMinutesToPreset = (minutes) => {
      const m = Number(minutes)
      const found = INTERVAL_PRESETS.find(p => p.minutes === m)
      return found ? found.value : 'custom'
    }

    // 表单数据
    const ruleForm = ref(createEmptyRule())
    const accounts = ref([])
    const accountLoading = ref(false)
    const accountError = ref('')
    const selectedAccountIds = ref([])
    const accountToAdd = ref('') // 用于「添加账户」下拉，选完后加入 selectedAccountIds 并清空
    const scopeItems = ref([])
    const scopeSearch = ref('')
    const excludeScopeSearch = ref('') // 排除名单独立搜索，与目标区 scopeSearch 分离（做法 A）
    const scopeIncludePaused = ref(true)  // 固定为 true：默认显示开启+暂停，不再提供状态下拉
    const scopeLoading = ref(false)
    const scopeReady = ref(false)
    const scopeRequestId = ref(0)
    const scopePagingAfter = ref(null)
    /** 排除区有关键词时独立请求结果（q+limit=50，无 after）；无关键词时用 scopeItems */
    const excludeScopeItems = ref([])
    const excludeScopeLoading = ref(false)
    const excludeRequestId = ref(0)
    const resolvedSelectedMap = ref(new Map()) // id -> {id,name,...}
    // 监控范围条件（作用对象区）：名称/状态 多行 AND，用于按条件勾选下方列表
    const SCOPE_CONDITION_MAX_ROWS = 3
    const createDefaultScopeConditionRow = () => ({
      id: `scope-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      field: 'name',
      operator: 'include',
      value: '',
      customHours: null  // 创建时间段选「自定义」时的小时数（1–720）
    })
    const scopeConditionRows = ref([createDefaultScopeConditionRow()])
    const scopeApplyMessage = ref('') // 应用条件后的提示，如「已勾选 N 个对象」
    const syncJustDoneMessage = ref('') // 点击「同步」后的引导：请点击保存规则以使更改永久生效
    const isApplyingScopeConditions = ref(false) // 为 true 时 watch(scopeSearch) 不触发
    /** 执行时间（北京时间）：全天 vs 指定时段，与 ruleForm.executionTimeWindows 双向同步 */
    const executionTimeAllDay = ref(true)
    const executionTimeStart = ref('09:00')
    const executionTimeEnd = ref('18:00')
    const BASE_METRIC_OPTIONS = [
      { value: 'spend', label: '花费' },
      { value: 'roas', label: 'ROAS' },
      { value: 'cpa', label: '单次购买花费（CPA）' },
      { value: 'cpc', label: 'CPC（花费/链接点击）' },
      { value: 'add_to_cart_cost', label: '单次加购花费' },
      { value: 'checkout_cost', label: '单次结账花费' },
      { value: 'payment_cost', label: '单次添加支付信息花费' },
      { value: 'purchases', label: '购买次数' },
      { value: 'link_clicks', label: '链接点击' },
      { value: 'add_to_cart_count', label: '加购次数' },
      { value: 'initiate_checkout_count', label: '结账次数' },
      { value: 'add_payment_info_count', label: '添加支付信息次数' }
    ]
    const AVG_PURCHASES_METRIC = { value: 'purchases_avg_after_create', label: '多天购买次数平均数' }
    const conditionMetricOptions = computed(() =>
      ruleForm.value.targetLevel === 'ad'
        ? [...BASE_METRIC_OPTIONS, AVG_PURCHASES_METRIC]
        : BASE_METRIC_OPTIONS
    )
    const dynamicBudgetMetricOptions = computed(() =>
      ruleForm.value.targetLevel === 'ad'
        ? [...BASE_METRIC_OPTIONS, AVG_PURCHASES_METRIC]
        : BASE_METRIC_OPTIONS
    )
    /** 监控范围条件对应的 API 过滤：后端 SQL 只返回匹配项 */
    const scopeStatusFilter = ref('')   // '' | active_only | paused_only | active_and_paused
    const scopeStatusExcludeFilter = ref('') // 状态「不等于」时传：ACTIVE | PAUSED | ACTIVE,PAUSED
    const scopeNameExclude = ref('')   // 名称不包含关键词
    const scopeCreatedWithinHours = ref(null) // 创建时间段：近 N 小时内（数字或 null），传给后端 scope_created_within_hours
    /** 结构列表每页条数上限（首屏与加载更多共用） */
    const SCOPE_PAGE_LIMIT = 500
    /** 搜索模式单页条数（q 非空时 limit=50、after=null，不展示加载更多） */
    const SCOPE_SEARCH_LIMIT = 50
    // 2.3.1 方案B：线性条件列表状态（全局时间窗口 + whenLines）
    const whenLines = ref([])            // [{ join, metric, operator, value }]，首行 join=null
    const whenTimeWindow = ref('today')  // 全局 time_window
    const whenCustomRange = ref(null)    // { since, until } | null

    const isEditing = computed(() => !!editingRuleId.value)
    const hasBudgetAction = computed(() =>
      (ruleForm.actions || []).some(a => ['increase_budget', 'decrease_budget', 'set_dynamic_budget'].includes(a.type)))
    const zeroClickTemplate = computed(() => templates.value.find(t => t.slug === 'zero_click') || null)

    /** 负责人筛选：触发器显示文案（未选=全部，已选=负责人名 + 可选"无"） */
    const ownerFilterDisplayValue = computed(() => {
      const parts = []
      if (selectedOwnerIds.value.length > 0) {
        const names = ownersList.value
          .filter(o => selectedOwnerIds.value.includes(o.id))
          .map(o => o.owner_name || o.ownerName || String(o.id))
        if (names.length > 0) parts.push(names.join(', '))
      }
      if (includeNoOwner.value) parts.push('管理员创建')
      return parts.length > 0 ? parts.join(' + ') : '全部 (不选=全部)'
    })
    /** 一键铺底按钮展示口径：仅非管理员、空规则列表时展示（按当前 owner 维度） */
    const showBootstrapButton = computed(() => rulesLoaded.value && !isAdminFromRules.value && rules.value.length === 0)

    const persistExpandedRuleIds = () => {
      const uid = currentUserId.value
      if (uid == null || !Number.isFinite(Number(uid))) return
      try {
        localStorage.setItem(
          CARD_EXPAND_STORAGE_PREFIX + String(uid),
          JSON.stringify(expandedRuleIds.value)
        )
      } catch (_) {
        /* 配额或其它 */
      }
    }

    const hydrateExpandedRuleIds = () => {
      const uid = currentUserId.value
      if (uid == null || !Number.isFinite(Number(uid))) return
      try {
        const raw = localStorage.getItem(CARD_EXPAND_STORAGE_PREFIX + String(uid))
        if (!raw) {
          expandedRuleIds.value = []
          return
        }
        const arr = JSON.parse(raw)
        expandedRuleIds.value = Array.isArray(arr)
          ? arr.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
          : []
      } catch (_) {
        expandedRuleIds.value = []
      }
    }

    const isRuleCardExpanded = (ruleId) => {
      const id = Number(ruleId)
      if (!Number.isFinite(id) || id < 1) return false
      return expandedRuleIds.value.includes(id)
    }

    const toggleRuleCardExpand = (ruleId) => {
      const id = Number(ruleId)
      if (!Number.isFinite(id) || id < 1) return
      const next = [...expandedRuleIds.value]
      const i = next.indexOf(id)
      if (i >= 0) next.splice(i, 1)
      else next.push(id)
      expandedRuleIds.value = next
    }

    const collapseAllRuleCards = () => {
      expandedRuleIds.value = []
    }

    const expandAllRuleCards = () => {
      expandedRuleIds.value = rules.value
        .map((r) => Number(r.id))
        .filter((id) => Number.isFinite(id) && id > 0)
    }

    /** 折叠态 v2 仅第一组 IF；展开或 v1 显示全部条件 */
    const visibleConditionsForCard = (r) => {
      const conds = r.conditions || []
      if (isRuleCardExpanded(r.id)) return conds
      if (r.conditionsVersion !== 2) return conds
      return conds.filter((c) => (c._groupIndex || 1) === 1)
    }

    /** v2 除第 1 组外还有多少组（用于折叠提示） */
    const extraCondGroupsCount = (r) => {
      if (r.conditionsVersion !== 2 || !r.conditions?.length) return 0
      let maxG = 1
      for (const c of r.conditions) {
        const g = c._groupIndex || 1
        if (g > maxG) maxG = g
      }
      return Math.max(0, maxG - 1)
    }

    watch(expandedRuleIds, () => persistExpandedRuleIds(), { deep: true })

    watch(rules, (list) => {
      const idSet = new Set(
        (list || []).map((x) => Number(x.id)).filter((n) => Number.isFinite(n) && n > 0)
      )
      const pruned = expandedRuleIds.value.filter((id) => idSet.has(id))
      if (pruned.length !== expandedRuleIds.value.length) {
        expandedRuleIds.value = pruned
      }
    })

    // v2 DNF 工具函数
    const parseJson = (val) => {
      if (typeof val === 'string') {
        try { return JSON.parse(val) } catch { return null }
      }
      return val
    }
    const isV2Conditions = (x) =>
      x && typeof x === 'object' && x.version === 2 && Array.isArray(x.groups)
    const flattenV2Conditions = (v2) => {
      if (!v2?.groups) return []
      const list = []
      for (let i = 0; i < v2.groups.length; i++) {
        for (const c of v2.groups[i]?.conditions || []) {
          list.push({ ...c, _groupIndex: i + 1 })
        }
      }
      return list
    }

    const ensureWhenLinesNonEmpty = () => {
      if (!whenLines.value.length) {
        whenLines.value = [createDefaultWhenLine(null)]
      }
    }

    const normalizeJsonArray = (val) => {
      if (Array.isArray(val)) return val
      if (typeof val === 'string') {
        try {
          const parsed = JSON.parse(val)
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return []
        }
      }
      return []
    }

    const parseScopeFilters = (val, fallbackLevel = 'ad') => {
      const parsed = parseJson(val)
      if (!parsed || typeof parsed !== 'object') {
        return { level: fallbackLevel, conditions: [] }
      }
      const level = ['ad', 'adset', 'campaign'].includes(parsed.level) ? parsed.level : fallbackLevel
      const conditions = Array.isArray(parsed.conditions) ? parsed.conditions : []
      return { level, conditions }
    }

    const buildScopeFiltersFromRows = (rows, level) => {
      const conditions = []
      for (const row of rows || []) {
        const err = scopeConditionRowError(row)
        if (err) continue
        if (row.field === 'name') {
          conditions.push({
            field: 'name',
            operator: row.operator === 'exclude' ? 'not_contains' : 'contains',
            value: String(row.value || '').trim()
          })
        } else if (row.field === 'status') {
          const val = String(row.value || '').trim()
          const mapped = val === 'active_only'
            ? ['ACTIVE']
            : val === 'paused_only'
              ? ['PAUSED']
              : ['ACTIVE', 'PAUSED']
          conditions.push({
            field: 'effective_status',
            operator: row.operator === 'not_equals' ? 'not_in' : 'in',
            value: mapped
          })
        } else if (row.field === 'created_within') {
          let hours = null
          if (row.value === '24' || row.value === '48' || row.value === '72') {
            hours = Number(row.value)
          } else if (row.value === 'custom') {
            const h = Number(row.customHours)
            if (Number.isFinite(h) && h >= 1 && h <= 720) hours = h
          }
          if (Number.isFinite(hours) && hours > 0) {
            conditions.push({
              field: 'created_time',
              operator: 'within_hours',
              value: hours
            })
          }
        }
      }
      return {
        level: ['ad', 'adset', 'campaign'].includes(level) ? level : 'ad',
        conditions
      }
    }

    const buildScopeRowsFromFilters = (scopeFilters) => {
      const parsed = parseScopeFilters(scopeFilters, 'ad')
      const rows = []
      for (const c of parsed.conditions || []) {
        if (!c || typeof c !== 'object') continue
        if (c.field === 'name' && (c.operator === 'contains' || c.operator === 'not_contains')) {
          rows.push({
            id: `scope-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            field: 'name',
            operator: c.operator === 'not_contains' ? 'exclude' : 'include',
            value: String(c.value || ''),
            customHours: null
          })
        } else if (c.field === 'effective_status' && (c.operator === 'in' || c.operator === 'not_in')) {
          const arr = Array.isArray(c.value) ? c.value.map(v => String(v).toUpperCase()) : []
          let value = 'active_and_paused'
          if (arr.length === 1 && arr[0] === 'ACTIVE') value = 'active_only'
          else if (arr.length === 1 && arr[0] === 'PAUSED') value = 'paused_only'
          rows.push({
            id: `scope-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            field: 'status',
            operator: c.operator === 'not_in' ? 'not_equals' : 'equals',
            value,
            customHours: null
          })
        } else if (c.field === 'created_time' && c.operator === 'within_hours') {
          const h = Number(c.value)
          if (!Number.isFinite(h) || h <= 0) continue
          let value = 'custom'
          let customHours = h
          if (h === 24 || h === 48 || h === 72) {
            value = String(h)
            customHours = null
          }
          rows.push({
            id: `scope-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            field: 'created_within',
            operator: 'include',
            value,
            customHours
          })
        }
      }
      return rows.length ? rows.slice(0, SCOPE_CONDITION_MAX_ROWS) : [createDefaultScopeConditionRow()]
    }

    const normalizeExcludeTargetIds = (excludeIds, level) => {
      const obj = parseJson(excludeIds)
      if (!obj || typeof obj !== 'object') return []
      if (level === 'campaign') return Array.isArray(obj.campaign_ids) ? obj.campaign_ids.map(v => String(v)).filter(Boolean) : []
      if (level === 'adset') return Array.isArray(obj.adset_ids) ? obj.adset_ids.map(v => String(v)).filter(Boolean) : []
      return Array.isArray(obj.ad_ids) ? obj.ad_ids.map(v => String(v)).filter(Boolean) : []
    }

    const formatExcludeSummary = (excludeIds) => {
      const obj = parseJson(excludeIds)
      if (!obj || typeof obj !== 'object') return ''
      const adCount = Array.isArray(obj.ad_ids) ? obj.ad_ids.length : 0
      const adsetCount = Array.isArray(obj.adset_ids) ? obj.adset_ids.length : 0
      const campaignCount = Array.isArray(obj.campaign_ids) ? obj.campaign_ids.length : 0
      const total = adCount + adsetCount + campaignCount
      if (total <= 0) return ''
      const parts = []
      if (adCount > 0) parts.push(`广告 ${adCount}`)
      if (adsetCount > 0) parts.push(`广告组 ${adsetCount}`)
      if (campaignCount > 0) parts.push(`广告系列 ${campaignCount}`)
      return `排除名单：${parts.join(' / ')}`
    }

    const buildExcludeIdsPayload = (excludeTargetIds, level) => {
      const safeLevel = ['ad', 'adset', 'campaign'].includes(level) ? level : 'ad'
      const uniq = [...new Set((excludeTargetIds || []).map(v => {
        const s = String(v || '').trim()
        if (!s) return ''
        const idx = s.indexOf(':')
        return idx >= 0 ? s.slice(idx + 1) : s
      }).filter(Boolean))]
      return uniq.map(id => ({ level: safeLevel, id }))
    }

    /** 预览接口用：从 excludeTargetIds（act_xxx:id 或 id）构造 exclude_ids { ad_ids, adset_ids, campaign_ids } */
    const buildExcludeIdsForPreview = (excludeTargetIds, targetLevel) => {
      const level = ['ad', 'adset', 'campaign'].includes(targetLevel) ? targetLevel : 'ad'
      const uniq = [...new Set((excludeTargetIds || []).map(v => {
        const s = String(v || '').trim()
        if (!s) return ''
        const idx = s.indexOf(':')
        return idx >= 0 ? s.slice(idx + 1) : s
      }).filter(Boolean))]
      const ad_ids = level === 'ad' ? uniq : []
      const adset_ids = level === 'adset' ? uniq : []
      const campaign_ids = level === 'campaign' ? uniq : []
      return { ad_ids, adset_ids, campaign_ids }
    }

    const normalizeRule = (r) => {
      const raw = parseJson(r.conditions)
      const isV2 = isV2Conditions(raw)
      return {
        id: r.id,
        name: r.ruleName || r.name || '',
        enabled: r.enabled !== false,
        conditionsRaw: raw,
        conditionsVersion: isV2 ? 2 : 1,
        conditions: isV2 ? flattenV2Conditions(raw) : normalizeJsonArray(r.conditions),
        actions: normalizeJsonArray(r.actions),
        targetLevel: r.targetLevel || r.target_level || 'ad',
        targetIds: normalizeJsonArray(r.targetIds || r.target_ids),
        targetAccountIds: Array.isArray(r.targetAccountIds) ? r.targetAccountIds : (Array.isArray(r.target_account_ids) ? r.target_account_ids : null),
        targetByAccount: r.targetByAccount != null && typeof r.targetByAccount === 'object' ? r.targetByAccount : (r.target_by_account != null && typeof r.target_by_account === 'object' ? r.target_by_account : null),
        logicOperator: r.logicOperator || r.logic_operator || 'AND',
        timezoneName: r.timezoneName || r.timezone_name || 'UTC',
        isSimulation: r.isSimulation ?? r.is_simulation ?? false,
        accountId: r.accountId || r.account_id || '',
        excludeTargetIds: normalizeExcludeTargetIds(r.excludeIds ?? r.exclude_ids, r.targetLevel || r.target_level || 'ad'),
        executionIntervalMinutes: r.executionIntervalMinutes ?? r.execution_interval_minutes ?? 15,
        executionTimeWindows: (r.executionTimeWindows ?? r.execution_time_windows) && Array.isArray(r.executionTimeWindows ?? r.execution_time_windows) ? (r.executionTimeWindows ?? r.execution_time_windows) : [],
        useDynamicScope: r.useDynamicScope ?? r.use_dynamic_scope ?? false,
        scopeFilters: parseScopeFilters(r.scopeFilters ?? r.scope_filters, r.targetLevel || r.target_level || 'ad'),
        excludeIds: parseJson(r.excludeIds ?? r.exclude_ids) || null,
        excludeSummaryText: formatExcludeSummary(r.excludeIds ?? r.exclude_ids),
        maxDynamicMatches: r.maxDynamicMatches ?? r.max_dynamic_matches ?? 1000,
        dynamicScopeStatus: String(r.dynamicScopeStatus ?? r.dynamic_scope_status ?? 'NORMAL'),
        dynamicScopeErrorMsg: r.dynamicScopeErrorMsg ?? r.dynamic_scope_error_msg ?? '',
        dynamicScopeUpdatedAt: r.dynamicScopeUpdatedAt ?? r.dynamic_scope_updated_at ?? null,
        matchedCount: r.matched_count != null ? Number(r.matched_count) : null,
        invalidIds: Array.isArray(r.invalid_ids) ? r.invalid_ids : [],
        ownerId: r.ownerId ?? r.owner_id ?? null,
        ownerName: r.ownerName ?? r.owner_name ?? '未分配'
      }
    }

    const loadTemplates = async () => {
      try {
        const resp = await authFetch('/api/templates')
        const data = await resp.json()
        templates.value = data.templates || []
      } catch {
        templates.value = []
      }
    }

    const loadRules = async () => {
      // 列表重载时清空批量选中状态，避免旧列表选中残留到新列表
      if (bulkMode.value) exitBulkMode()
      try {
        let url = '/api/rules'
        if (isAdminFromRules.value) {
          const params = []
          if (selectedOwnerIds.value.length > 0) {
            const ids = selectedOwnerIds.value.map(id => Number(id)).filter(Number.isFinite)
            if (ids.length > 0) params.push('ownerIds=' + ids.join(','))
          }
          if (includeNoOwner.value) params.push('includeNoOwner=1')
          if (params.length > 0) url += '?' + params.join('&')
        }
        const resp = await authFetch(url)
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error || '获取规则失败')
        isAdminFromRules.value = data.isAdmin === true
        if (data.isAdmin) {
          try {
            const oResp = await authFetch('/api/owners')
            const oData = await oResp.json()
            ownersList.value = oData.owners || []
          } catch {
            ownersList.value = []
          }
        }
        rules.value = (data.rules || []).map(normalizeRule)
        rulesLoaded.value = true
      } catch (e) {
        rulesLoaded.value = true
        alert(`加载规则失败：${e.message}`)
      }
    }

    /** 显式全量铺底（原则 B：仅 POST 写接口触发） */
    const bootstrapFromTemplates = async () => {
      if (bootstrapLoading.value) return
      bootstrapLoading.value = true
      bootstrapFeedback.value = { type: 'info', text: '' }
      try {
        const resp = await authFetch('/api/rules/bootstrap-from-templates', { method: 'POST' })
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error || '铺底失败')
        await loadRules()
        const created = Number(data.created || 0)
        if (created > 0) {
          bootstrapFeedback.value = {
            type: 'success',
            text: `已生成 ${created} 条半成品规则，请补全账户与条件后再启用。`
          }
        } else {
          bootstrapFeedback.value = {
            type: 'info',
            text: '无新增规则（当前负责人已有规则或模板为空）。'
          }
        }
      } catch (e) {
        bootstrapFeedback.value = {
          type: 'error',
          text: `一键生成失败：${e.message}`
        }
      } finally {
        bootstrapLoading.value = false
      }
    }

    /** 负责人筛选：清除已选并重新拉规则 */
    const clearOwnerFilter = () => {
      selectedOwnerIds.value = []
      includeNoOwner.value = false
      ownerFilterOpen.value = false
      loadRules()
    }

    /** 负责人筛选：切换某一负责人的选中状态并重新拉规则 */
    const toggleOwnerOption = (id) => {
      const ids = selectedOwnerIds.value
      const idx = ids.indexOf(id)
      if (idx >= 0) {
        selectedOwnerIds.value = ids.filter((_, i) => i !== idx)
      } else {
        selectedOwnerIds.value = [...ids, id]
      }
      loadRules()
    }

    /** 负责人筛选：切换"管理员创建"选中状态并重新拉规则 */
    const toggleNoOwnerOption = () => {
      includeNoOwner.value = !includeNoOwner.value
      loadRules()
    }

    const loadAccounts = async () => {
      accountLoading.value = true
      accountError.value = ''
      try {
        accounts.value = await facebookApi.getAdAccounts()
      } catch (e) {
        accountError.value = `加载账户失败：${e.message}`
        accounts.value = []
        selectedAccountIds.value = []
        scopeItems.value = []
        ruleForm.value.targetIds = []
        ruleForm.value.excludeTargetIds = []
      } finally {
        accountLoading.value = false
      }
    }

    // 辅助显示
    const metricLabel = (m) => {
      const map = {
        spend: '花费',
        roas: 'ROAS',
        cpa: '单次购买花费（CPA）',
        cpc: 'CPC（花费/链接点击）',
        add_to_cart_cost: '单次加购花费',
        checkout_cost: '单次结账花费',
        payment_cost: '单次添加支付信息花费',
        purchases: '购买次数',
        purchases_avg_after_create: '多天购买次数平均数',
        link_clicks: '链接点击',
        add_to_cart_count: '加购次数',
        initiate_checkout_count: '结账次数',
        add_payment_info_count: '添加支付信息次数'
      }
      return map[m] || m
    }
    const opLabel = (op) => {
      const map = { gt: '>', lt: '<', gte: '≥', lte: '≤', eq: '=' }
      return map[op] || op
    }
    const actionLabel = (t) => {
      const map = { pause_ad: '暂停目标', activate_ad: '启用目标', increase_budget: '增加预算', decrease_budget: '减少预算', set_budget: '设置预算', set_dynamic_budget: '设置动态预算值' }
      return map[t] || t
    }
    const getActionClass = (type) => {
      if (type === 'pause_ad') return 'danger'
      if (type === 'activate_ad') return 'success'
      return 'primary'
    }

    const timeWindowLabel = (w, c) => {
      const map = {
        today: '今天',
        yesterday: '昨天',
        last_3_days: '近3天',
        last_3_days_excluding_today: '近3天（不含今天）',
        last_5_days: '近5天',
        last_5_days_excluding_today: '近5天（不含今天）',
        last_7_days: '近7天',
        last_7_days_excluding_today: '近7天（不含今天）',
        lifetime: '至今为止',
        custom_range: '自定义'
      }
      const base = map[w] || w
      if (w === 'custom_range' && c?.custom_range?.since) {
        const { since, until } = c.custom_range
        return until && since !== until ? `${base}(${since}~${until})` : `${base}(${since})`
      }
      return base
    }

    /** 列表展示：执行时间段 → 「全天」或「09:00–18:00」或跨日「20:00–次日 05:00」（文档 §8.2 + 跨日方案） */
    const formatExecutionTimeDisplay = (windows) => {
      if (!windows || !Array.isArray(windows) || windows.length === 0) return '全天'
      return windows.map(w => {
        const s = (w.start || '').toString().slice(0, 5)
        const e = (w.end || '').toString().slice(0, 5)
        if (!s && !e) return ''
        if (!s || !e) return s || e
        // 比较 HH:mm 字符串即可判断是否跨日（ end 早于或等于 start 视为跨日）
        const [sh, sm] = s.split(':').map(Number)
        const [eh, em] = e.split(':').map(Number)
        const startMin = (sh || 0) * 60 + (sm || 0)
        const endMin = (eh || 0) * 60 + (em || 0)
        const isCrossDay = endMin <= startMin
        return isCrossDay ? `${s}–次日 ${e}` : `${s}–${e}`
      }).filter(Boolean).join(', ')
    }

    /** 列表展示：执行间隔（分钟）→ 可读文案 */
    const formatIntervalDisplay = (minutes) => {
      const m = Number(minutes)
      if (!Number.isFinite(m) || m < 0) return '15 分钟'
      if (m === 60) return '1 小时'
      if (m === 180) return '3 小时'
      if (m === 360) return '6 小时'
      if (m >= 60 && m % 60 === 0) return `${m / 60} 小时`
      return `${m} 分钟`
    }

    const dynamicStatusLabel = (status) => {
      const s = String(status || 'NORMAL')
      if (s === 'NORMAL') return '状态正常'
      if (s === 'ERROR_OVERSIZE') return '超出上限'
      if (s === 'ERROR_FILTER_INVALID') return '条件无效'
      if (s === 'ERROR_REFRESH_FAILED') return '刷新失败'
      return s
    }

    const dynamicStatusClass = (status) => {
      const s = String(status || 'NORMAL')
      if (s === 'NORMAL') return 'dynamic-status-normal'
      if (s === 'ERROR_OVERSIZE') return 'dynamic-status-warn'
      return 'dynamic-status-error'
    }

    const filteredScopeItems = computed(() => {
      const key = String(scopeSearch.value || '').trim().toLowerCase()
      const list = !key
        ? scopeItems.value
        : scopeItems.value.filter(item =>
            String(item.name || '').toLowerCase().includes(key) ||
            String(item.id || '').toLowerCase().includes(key)
          )
      // 开启(ACTIVE)在前，暂停(PAUSED)在后
      return [...list].sort((a, b) => {
        const order = (x) => (x.effective_status === 'ACTIVE' ? 0 : 1)
        return order(a) - order(b)
      })
    })

    /** 排除区：有关键词时用服务端结果 excludeScopeItems（q+limit=50）；无关键词时用 scopeItems */
    const filteredExcludeScopeItems = computed(() => {
      const key = String(excludeScopeSearch.value || '').trim()
      const list = key ? excludeScopeItems.value : scopeItems.value
      return [...list].sort((a, b) => {
        const order = (x) => (x.effective_status === 'ACTIVE' ? 0 : 1)
        return order(a) - order(b)
      })
    })

    /** 多选时用 account_id:id 作为唯一键与表单值；单选时用 id（兼容旧逻辑） */
    const scopeItemKey = (item) => selectedAccountIds.value.length > 1 ? `${item.account_id || ''}:${item.id}` : item.id
    const scopeItemValue = (item) => selectedAccountIds.value.length > 1 ? `${item.account_id || ''}:${item.id}` : item.id

    /** 未选中的账户（供「添加账户」下拉用） */
    const accountsFilteredForAdd = computed(() => {
      const set = new Set(selectedAccountIds.value)
      return accounts.value.filter(a => !set.has(a.id))
    })

    const canSelectAll = computed(() => {
      return scopeReady.value && !scopeLoading.value && filteredScopeItems.value.length > 0
    })
    /** 排除区加载中：有关键词用 excludeScopeLoading，无关键词用 scopeLoading（与目标区共用列表） */
    const excludeAreaLoading = computed(() => {
      const key = String(excludeScopeSearch.value || '').trim()
      return key ? excludeScopeLoading.value : scopeLoading.value
    })
    const canSelectAllExclude = computed(() => {
      return scopeReady.value && !excludeAreaLoading.value && filteredExcludeScopeItems.value.length > 0
    })

    const selectedTargetPreview = computed(() => {
      return ruleForm.value.targetIds.slice(0, 6)
    })

    /** 当前已加载的 scope 列表中的 id 集合（用于显示「未加载数据」） */
    const scopeLoadedIdSet = computed(() => new Set(scopeItems.value.map(x => scopeItemValue(x))))

    /** 后端返回的失效目标复合 ID 集合（规则配置中有但未进入 rule_matched_objects） */
    const invalidIdSet = computed(() => new Set((ruleForm.value.invalidIds || []).map(String)))

    /** 仅当「当前匹配数 ≠ 规则配置数」时显示 [同步] 按钮 */
    const showSyncButton = computed(() =>
      !!ruleForm.value.useDynamicScope &&
      ruleForm.value.matchedCount != null &&
      ruleForm.value.matchedCount !== (ruleForm.value.targetIds?.length ?? 0)
    )
    const isScopeConditionsDisabled = computed(() => ruleForm.value.useDynamicScope !== true)

    const missingSelectedCount = computed(() => {
      return ruleForm.value.targetIds.filter(id => !scopeLoadedIdSet.value.has(String(id))).length
    })

    /** 比值类指标口径提示：cpc/ucpc/cpa/roas 需搭配分母条件，否则为 null（TASKS 2.3 前端口径防呆） */
    const ratioMetricTip = computed(() => {
      const lines = whenLines.value || []
      const hasPositiveDenominator = (denomMetric) =>
        lines.some(l => {
          const m = String(l.metric || '').trim()
          const op = String(l.operator || '').trim()
          const v = Number(l.value)
          if (m !== denomMetric) return false
          // “> 0 / >= 1 / = 1+” 都算正分母约束
          if (op === 'gt') return !Number.isNaN(v) && v >= 0
          if (op === 'gte') return !Number.isNaN(v) && v >= 1
          if (op === 'eq') return !Number.isNaN(v) && v >= 1
          return false
        })
      const missing = []
      const hasMetric = (key) => lines.some(l => String(l.metric || '').trim() === key)
      if (lines.some(l => ['cpc', 'ucpc'].includes(String(l.metric || '').trim())) && !hasPositiveDenominator('link_clicks')) {
        missing.push('CPC/独立CPC 需要有点击才有意义，建议加条件：<strong>链接点击 &gt; 0</strong>（<strong>link_clicks &gt; 0</strong>）')
      }
      if (hasMetric('cpa') && !hasPositiveDenominator('purchases')) {
        missing.push('单次购买花费（CPA）需要有购买才有意义，建议加条件：<strong>购买次数 &gt; 0</strong>（<strong>purchases &gt; 0</strong>）')
      }
      if (hasMetric('roas') && !hasPositiveDenominator('spend')) {
        missing.push('ROAS 需要有花费才有意义，建议加条件：<strong>花费 &gt; 0</strong>（<strong>spend &gt; 0</strong>）')
      }
      if (hasMetric('add_to_cart_cost') && !hasPositiveDenominator('add_to_cart_count')) {
        missing.push('单次加购花费需要有加购才有意义，建议加条件：<strong>加购次数 &gt; 0</strong>（<strong>add_to_cart_count &gt; 0</strong>）')
      }
      if (hasMetric('checkout_cost') && !hasPositiveDenominator('initiate_checkout_count')) {
        missing.push('单次结账花费需要有结账才有意义，建议加条件：<strong>结账次数 &gt; 0</strong>（<strong>initiate_checkout_count &gt; 0</strong>）')
      }
      if (hasMetric('payment_cost') && !hasPositiveDenominator('add_payment_info_count')) {
        missing.push('单次添加支付信息花费需要有“添加支付信息”才有意义，建议加条件：<strong>添加支付信息次数 &gt; 0</strong>（<strong>add_payment_info_count &gt; 0</strong>）')
      }
      if (missing.length === 0) return null
      return `当分母为 0 时，上述比值/单次成本指标会为空，规则不会触发。${missing.join('；')}。`
    })

    // CRUD 操作
    const openCreateRule = () => {
      editingRuleId.value = null
      selectedAccountIds.value = []
      accountToAdd.value = ''
      scopeItems.value = []
      scopeSearch.value = ''
      excludeScopeSearch.value = ''
      excludeScopeItems.value = []
      scopePagingAfter.value = null
      resolvedSelectedMap.value = new Map()
      scopeConditionRows.value = [createDefaultScopeConditionRow()]
      scopeStatusFilter.value = ''
      scopeStatusExcludeFilter.value = ''
      scopeNameExclude.value = ''
      scopeCreatedWithinHours.value = null
      ruleForm.value = {
        ...createEmptyRule(),
        actions: [{ type: 'pause_ad', value: null }]
      }
      whenLines.value = [createDefaultWhenLine(null)]
      whenTimeWindow.value = 'today'
      whenCustomRange.value = null
      scopeConditionRows.value = [createDefaultScopeConditionRow()]
      executionTimeAllDay.value = true
      executionTimeStart.value = '09:00'
      executionTimeEnd.value = '18:00'
      loadTemplates()
      showRuleModal.value = true
    }

    /**
     * 兜底归一化：预算护栏字段与动作类型对齐
     * - increase 仅允许 max_daily_budget
     * - decrease 仅允许 min_daily_budget
     * - set_budget 不允许 max/min
     * - 小于 100 分的上下限一律清空
     */
    const normalizeBudgetGuardsByAction = (actions) => {
      let n = 0
      for (const a of actions || []) {
        if (a?.max_daily_budget != null && Number(a.max_daily_budget) < 100) {
          a.max_daily_budget = undefined
          n++
        }
        if (a?.min_daily_budget != null && Number(a.min_daily_budget) < 100) {
          a.min_daily_budget = undefined
          n++
        }
        if (a?.type === 'increase_budget' && a?.min_daily_budget != null) {
          a.min_daily_budget = undefined
          n++
        }
        if (a?.type === 'decrease_budget' && a?.max_daily_budget != null) {
          a.max_daily_budget = undefined
          n++
        }
        if (a?.type === 'set_budget') {
          if (a?.max_daily_budget != null) {
            a.max_daily_budget = undefined
            n++
          }
          if (a?.min_daily_budget != null) {
            a.min_daily_budget = undefined
            n++
          }
        }
        if (a?.type !== 'set_dynamic_budget' && a?.min_daily_budget != null && a?.max_daily_budget != null) {
          a.max_daily_budget = undefined
          n++
        }
      }
      return n
    }

    /** 从 targetIds 中解析出所有出现过的账户 ID（支持 "act_xxx:id" 格式），用于编辑时回填多账户 */
    const parseAccountIdsFromTargetIds = (targetIds, fallbackAccountId) => {
      const set = new Set()
      if (fallbackAccountId) set.add(fallbackAccountId)
      for (const id of targetIds || []) {
        const s = String(id).trim()
        if (s.includes(':')) {
          const acc = s.split(':')[0].trim()
          if (acc) set.add(acc)
        }
      }
      return [...set]
    }

    /** 将 targetIds（act_xxx:id）解析为可读标签并写入 resolvedSelectedMap；无 id 时清空。用于编辑回显与详情拉取后刷新。 */
    function resolveSelectedTargetIds(rawIds) {
      if (!rawIds?.length) {
        resolvedSelectedMap.value = new Map()
        return
      }
      const idParts = rawIds.map((id) => {
        const s = String(id)
        const idx = s.indexOf(':')
        return idx >= 0 ? s.slice(idx + 1) : s
      })
      const uniqueIdParts = [...new Set(idParts)]
      facebookApi.resolveObjectsByIds(uniqueIdParts)
        .then((items) => {
          const idToItem = new Map()
          for (const it of items || []) idToItem.set(String(it.id), it)
          const m = new Map()
          for (const targetId of rawIds) {
            const key = String(targetId)
            const idPart = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
            const item = idToItem.get(idPart)
            m.set(key, item ? { ...item, id: idPart } : { id: idPart, missing: true })
          }
          resolvedSelectedMap.value = m
        })
        .catch(() => {})
    }

    const openEditRule = (r) => {
      editingRuleId.value = r.id
      // 多账户：优先用后端返回的 target_account_ids；否则从 targetIds（act_xxx:id）解析
      const accountIds = (r.targetAccountIds && r.targetAccountIds.length) ? r.targetAccountIds : parseAccountIdsFromTargetIds(r.targetIds || [], r.accountId || '')
      selectedAccountIds.value = accountIds
      accountToAdd.value = ''
      scopeItems.value = []
      scopeSearch.value = ''
      excludeScopeSearch.value = ''
      excludeScopeItems.value = []
      scopePagingAfter.value = null
      scopeConditionRows.value = [createDefaultScopeConditionRow()]
      scopeStatusFilter.value = ''
      scopeStatusExcludeFilter.value = ''
      scopeNameExclude.value = ''
      scopeCreatedWithinHours.value = null

      ruleForm.value = JSON.parse(JSON.stringify({
        name: r.name || '',
        enabled: r.enabled,
        isSimulation: r.isSimulation || false,
        targetLevel: r.targetLevel || 'ad',
        targetIds: r.targetIds || [],
        excludeTargetIds: r.excludeTargetIds || [],
        logicOperator: r.logicOperator || 'AND',
        timezoneName: r.timezoneName || 'UTC',
        actions: r.actions || [],
        executionIntervalMinutes: r.executionIntervalMinutes ?? r.execution_interval_minutes ?? 15,
        executionIntervalPreset: mapMinutesToPreset(r.executionIntervalMinutes ?? r.execution_interval_minutes ?? 15),
        executionIntervalHoursCustom: mapMinutesToPreset(r.executionIntervalMinutes ?? r.execution_interval_minutes ?? 15) === 'custom' ? ((r.executionIntervalMinutes ?? r.execution_interval_minutes ?? 15) / 60) : null,
        executionTimeWindows: (r.executionTimeWindows ?? r.execution_time_windows) && Array.isArray(r.executionTimeWindows ?? r.execution_time_windows) ? (r.executionTimeWindows ?? r.execution_time_windows) : [],
        useDynamicScope: r.useDynamicScope !== false,
        maxDynamicMatches: Number(r.maxDynamicMatches ?? r.max_dynamic_matches ?? 1000) || 1000,
        matchedCount: r.matched_count != null ? Number(r.matched_count) : null,
        invalidIds: Array.isArray(r.invalid_ids) ? r.invalid_ids : []
      }))
      scopeConditionRows.value = buildScopeRowsFromFilters(r.scopeFilters || r.scope_filters || null)
      if (ruleForm.value.useDynamicScope !== true) {
        clearScopeConditions()
      }
      const normalizedCount = normalizeBudgetGuardsByAction(ruleForm.value.actions)
      if (normalizedCount > 0) {
        console.info(`[规则编辑] 已自动归一化 ${normalizedCount} 个预算护栏字段（动作与上下限口径对齐）`)
      }

      if (r.conditionsVersion === 2) {
        const { lines, timeWindow, customRange } = v2ToLines(r.conditionsRaw || { version: 2, groups: [] })
        whenLines.value = lines.length ? lines : [createDefaultWhenLine(null)]
        whenTimeWindow.value = timeWindow
        whenCustomRange.value = customRange
      } else {
        const { lines, timeWindow, customRange } = v1ToLines(r.conditions || [], r.logicOperator || 'AND')
        whenLines.value = lines.length ? lines : [createDefaultWhenLine(null)]
        whenTimeWindow.value = timeWindow
        whenCustomRange.value = customRange
      }
      const win = (r.executionTimeWindows ?? r.execution_time_windows) && Array.isArray(r.executionTimeWindows ?? r.execution_time_windows) ? (r.executionTimeWindows ?? r.execution_time_windows) : []
      executionTimeAllDay.value = win.length === 0
      executionTimeStart.value = win[0]?.start ? String(win[0].start).slice(0, 5) : '09:00'
      executionTimeEnd.value = win[0]?.end ? String(win[0].end).slice(0, 5) : '18:00'
      // 回显：已选对象解析成可读标签（抽成函数，详情拉取后更新 targetIds 时也会复用）
      resolvedSelectedMap.value = new Map()
      resolveSelectedTargetIds(ruleForm.value.targetIds)
      loadTemplates()
      showRuleModal.value = true
      // 动态规则：拉取规则详情以获取 matched_count、最新 target_ids（与 rule_matched_objects 一致），避免列表陈旧导致「规则配置共 N 个」滞后
      if (r.id && ruleForm.value.useDynamicScope) {
        authFetch(`/api/rules/${r.id}`)
          .then(res => res.json())
          .then(data => {
            if (data.rule && ruleForm.value && editingRuleId.value === r.id) {
              ruleForm.value.matchedCount = data.rule.matched_count != null ? Number(data.rule.matched_count) : null
              ruleForm.value.invalidIds = Array.isArray(data.rule.invalid_ids) ? data.rule.invalid_ids : []
              ruleForm.value.lastMatchedHistory = data.rule.last_matched_history || null
              const fromApi = data.rule.targetIds ?? data.rule.target_ids
              const nextTargetIds = Array.isArray(fromApi) ? [...fromApi] : (typeof fromApi === 'string' ? (() => { try { return JSON.parse(fromApi) } catch { return [] } })() : [])
              ruleForm.value.targetIds = nextTargetIds
              resolveSelectedTargetIds(nextTargetIds)
            }
          })
          .catch(() => {})
      }
    }

    /** 动作类型切换：预算类时设置默认 value_unit、value */
    const onActionTypeChange = (a) => {
      if (a.type === 'set_budget') {
        a.value_unit = 'usd'
        if (a.value == null || a.value === '' || a.value < 0.01) a.value = 30
        a.max_daily_budget = undefined
        a.min_daily_budget = undefined
      } else if (a.type === 'set_dynamic_budget') {
        a.value = undefined
        a.value_unit = 'usd'
        a.metric = dynamicBudgetMetricOptions.value.some(opt => opt.value === a.metric) ? a.metric : 'purchases'
        if (a.multiplier == null || a.multiplier === '' || Number(a.multiplier) <= 0) a.multiplier = 30
      } else if (a.type?.includes('budget')) {
        a.value_unit = a.value_unit || 'percent'
        if (a.value_unit === 'percent' && (a.value == null || a.value === '')) a.value = 10
        if (a.type === 'increase_budget') {
          a.min_daily_budget = undefined
        } else if (a.type === 'decrease_budget') {
          a.max_daily_budget = undefined
        }
      } else {
        a.max_daily_budget = undefined
        a.min_daily_budget = undefined
      }
    }

    const saveRule = () => {
      if (!ruleForm.value.name.trim()) return alert('请输入规则名称')
      if (!selectedAccountIds.value?.length) return alert('请至少选择一个广告账户')
      if (!ruleForm.value.actions.length) return alert('请至少添加一个动作')
      for (const a of ruleForm.value.actions) {
        if (a.type === 'set_dynamic_budget') {
          if (!dynamicBudgetMetricOptions.value.some(opt => opt.value === a.metric)) {
            return alert('动态预算指标不支持当前目标层级')
          }
          const multiplier = Number(a.multiplier)
          if (a.multiplier == null || a.multiplier === '' || !Number.isFinite(multiplier) || multiplier <= 0) {
            return alert('动态预算倍率必须大于 0')
          }
          if (Math.abs(multiplier * 100 - Math.round(multiplier * 100)) >= 1e-6) {
            return alert('动态预算倍率最多两位小数')
          }
          if (a.min_daily_budget != null) {
            const min = Number(a.min_daily_budget)
            if (!Number.isInteger(min) || min < 100) return alert('预算下限需为 >= 1 美元')
          }
          if (a.max_daily_budget != null) {
            const max = Number(a.max_daily_budget)
            if (!Number.isInteger(max) || max < 100) return alert('预算上限需为 >= 1 美元')
          }
          if (a.min_daily_budget != null && a.max_daily_budget != null && Number(a.min_daily_budget) > Number(a.max_daily_budget)) {
            return alert('动态预算下限不能大于上限')
          }
        } else if (a.type === 'set_budget') {
          const v = Number(a.value)
          if (a.value == null || a.value === '' || !Number.isFinite(v) || v < 0.01 || v > 9999) {
            return alert('设置预算请填写 0.01–9999 的数值（美元）')
          }
          if (Math.abs(v * 100 - Math.round(v * 100)) >= 1e-6) {
            return alert('设置预算金额最多两位小数')
          }
        } else if (a.type?.includes('budget')) {
          const unit = a.value_unit || 'percent'
          if (unit === 'usd') {
            const v = Number(a.value)
            if (a.value == null || a.value === '' || !Number.isFinite(v) || v < 0.01 || v > 9999) {
              return alert('固定金额模式下请填写 0.01–9999 的数值')
            }
            if (Math.abs(v * 100 - Math.round(v * 100)) >= 1e-6) {
              return alert('固定金额最多两位小数')
            }
          } else {
            const v = Number(a.value)
            if (a.value == null || a.value === '' || !Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > 100) {
              return alert('百分比模式下 value 须为 1–100 的整数')
            }
          }
          if (a.type === 'increase_budget' && a.max_daily_budget != null) {
            const m = Number(a.max_daily_budget)
            if (!Number.isInteger(m) || m < 100) return alert('预算上限需为 >= 1 美元')
          }
          if (a.type === 'decrease_budget' && a.min_daily_budget != null) {
            const m = Number(a.min_daily_budget)
            if (!Number.isInteger(m) || m < 100) return alert('预算下限需为 >= 1 美元')
          }
        }
      }
      ensureWhenLinesNonEmpty()
      if (!whenLines.value.length) return alert('请至少添加一个条件')

      if (whenTimeWindow.value === 'custom_range') {
        const cr = whenCustomRange.value
        if (!cr?.since || !cr?.until) return alert('自定义范围请填写起始和截止日期')
        if (cr.since > cr.until) return alert('起始日期不能晚于截止日期')
      }
      if (ruleForm.value.targetLevel !== 'ad' && whenLines.value.some(line => line.metric === 'purchases_avg_after_create')) {
        return alert('多天购买次数平均数第一版仅支持广告层规则')
      }

      const maxDynamicMatches = Number(ruleForm.value.maxDynamicMatches ?? 1000)
      if (ruleForm.value.useDynamicScope) {
        if (!Number.isFinite(maxDynamicMatches) || maxDynamicMatches < 1 || maxDynamicMatches > 5000) {
          return alert('动态匹配上限必须在 1~5000 之间')
        }
        const validScopeRows = scopeConditionRows.value.filter(row => !scopeConditionRowError(row))
        if (validScopeRows.length === 0) {
          return alert('开启动态筛选时，至少需要一条完整的监控范围条件')
        }
      }

      const conditionsPayload = linesToV2Groups(
        whenLines.value,
        whenTimeWindow.value,
        whenTimeWindow.value === 'custom_range' ? whenCustomRange.value : null
      )

      const actionsPayload = (ruleForm.value.actions || []).map(a => {
        const out = { type: a.type, value: a.value }
        if (a.type === 'set_dynamic_budget') {
          out.metric = a.metric || 'purchases'
          out.multiplier = Number(a.multiplier)
          out.value_unit = 'usd'
          delete out.value
          if (a.min_daily_budget != null) out.min_daily_budget = a.min_daily_budget
          if (a.max_daily_budget != null) out.max_daily_budget = a.max_daily_budget
        } else if (a.type === 'set_budget') {
          out.value_unit = 'usd'
        } else if (a.type === 'increase_budget') {
          out.value_unit = a.value_unit || 'percent'
          if (a.max_daily_budget != null) out.max_daily_budget = a.max_daily_budget
        } else if (a.type === 'decrease_budget') {
          out.value_unit = a.value_unit || 'percent'
          if (a.min_daily_budget != null) out.min_daily_budget = a.min_daily_budget
        }
        return out
      })
      // 方案 B：按账户分组目标 ID，供后端 target_by_account 落库与执行按账户取。多账户时 targetIds 以 act_xxx:id 持久化，避免跨账户 ID 歧义
      // 单选账户时前端 ruleForm.targetIds 为裸 id，后端 parseCompositeId 要求 "act_xxx:id" 格式，故此处统一转为复合 ID 再提交
      const ids = ruleForm.value.targetIds || []
      const byAccount = {}
      const accountSet = new Set(selectedAccountIds.value)
      for (const id of ids) {
        const s = String(id).trim()
        if (s.includes(':')) {
          const acc = s.split(':')[0].trim()
          const idPart = s.slice(s.indexOf(':') + 1)
          if (acc && idPart) {
            if (!byAccount[acc]) byAccount[acc] = []
            byAccount[acc].push(idPart)
          }
        } else if (accountSet.size > 0) {
          const acc = selectedAccountIds.value[0]
          if (!byAccount[acc]) byAccount[acc] = []
          byAccount[acc].push(s)
        }
      }
      const normalizedTargetIds = []
      for (const acc of Object.keys(byAccount)) {
        for (const objId of byAccount[acc]) {
          normalizedTargetIds.push(`${acc}:${objId}`)
        }
      }
      if (!ruleForm.value.useDynamicScope && normalizedTargetIds.length === 0) {
        return alert('关闭动态筛选时，请至少选择一个目标对象，避免规则扩大到整个广告账户执行')
      }
      const payload = {
        ruleName: ruleForm.value.name.trim(),
        accountId: selectedAccountIds.value[0],
        conditions: conditionsPayload,
        actions: actionsPayload,
        enabled: ruleForm.value.enabled,
        targetLevel: ruleForm.value.targetLevel,
        targetIds: normalizedTargetIds,
        targetAccounts: selectedAccountIds.value,
        target_by_account: Object.keys(byAccount).length ? byAccount : null,
        logicOperator: ruleForm.value.logicOperator,
        timezoneName: ruleForm.value.timezoneName,
        isSimulation: ruleForm.value.isSimulation,
        useDynamicScope: !!ruleForm.value.useDynamicScope,
        scopeFilters: ruleForm.value.useDynamicScope
          ? buildScopeFiltersFromRows(scopeConditionRows.value, ruleForm.value.targetLevel)
          : null,
        excludeIds: buildExcludeIdsPayload(ruleForm.value.excludeTargetIds, ruleForm.value.targetLevel),
        maxDynamicMatches: Math.floor(maxDynamicMatches),
        executionIntervalMinutes: ruleForm.value.executionIntervalPreset === 'custom'
          ? Math.round(Number(ruleForm.value.executionIntervalHoursCustom) * 60) || 15
          : (INTERVAL_PRESETS.find(p => p.value === ruleForm.value.executionIntervalPreset)?.minutes ?? 15),
        executionTimeWindows: executionTimeAllDay.value ? null : [{ start: (executionTimeStart.value || '09:00').slice(0, 5) + ':00', end: (executionTimeEnd.value || '18:00').slice(0, 5) + ':00' }]
      }

      const submit = editingRuleId.value
        ? authFetch(`/api/rules/${editingRuleId.value}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
        : authFetch('/api/rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })

      submit.then(async (resp) => {
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error || '保存失败')
        syncJustDoneMessage.value = ''
        showRuleModal.value = false
        await loadRules()
      }).catch((e) => {
        alert(`保存失败：${e.message}`)
      })
    }

    const deleteRule = (r) => {
      if (!confirm(`确定删除「${r.name}」吗？`)) return
      authFetch(`/api/rules/${r.id}`, { method: 'DELETE' })
        .then(async (resp) => {
          const data = await resp.json()
          if (!resp.ok) throw new Error(data.error || '删除失败')
          await loadRules()
        })
        .catch((e) => alert(`删除失败：${e.message}`))
    }

    const toggleRule = (r, checked) => {
      authFetch(`/api/rules/${r.id}/toggle`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: checked })
      })
        .then(async (resp) => {
          const data = await resp.json()
          if (!resp.ok) throw new Error(data.error || '操作失败')
          await loadRules()
        })
        .catch((e) => alert(`操作失败：${e.message}`))
    }

    const runThisRule = async (r) => {
      if (!confirm(`确定立即执行规则「${r.name}」吗？`)) return
      runningRuleId.value = r.id
      try {
        const res = await facebookApi.executeRuleById(r.id)
        const statusMap = {
          no_match: '已执行，本次 0 命中（未找到满足条件的对象）',
          skipped: '已执行，但本次被跳过',
          matched: '已执行，并产生命中对象',
          error: '已执行，但过程出错'
        }
        const statusText = statusMap[res.status] || (res.status || '未知')
        const msg = res.success
          ? `已执行。\n状态：${statusText}\n匹配 ${res.matched_count ?? 0} 个，执行成功 ${res.executed_count ?? 0}，失败 ${res.failed_count ?? 0}。\nRun ID: ${res.run_id ?? 'N/A'}`
          : (res.message || '执行完成')
        alert(msg)
      } catch (e) {
        const code = e.response?.data?.code
        const err = e.response?.data?.error || e.message
        if (code === 'ALREADY_RUNNING' || code === 'ACCOUNT_LOCKED') {
          alert('该账户规则正在执行中，请稍后再试')
        } else if (e.response?.status === 403) {
          alert('无权执行该规则')
        } else if (e.response?.status === 404) {
          alert('规则不存在或无权访问')
        } else {
          alert('执行失败: ' + err)
        }
      } finally {
        runningRuleId.value = null
      }
    }

    const refreshDynamicScopeForRule = async (r) => {
      if (!r?.id) return
      refreshingRuleId.value = r.id
      try {
        const res = await facebookApi.refreshDynamicScopeByAccount({ ruleId: r.id })
        const info = res?.result || {}
        if (Array.isArray(info.accountResults)) {
          const processedAccounts = info.processedAccounts ?? info.accountResults.length
          const totalInserted = info.accountResults.reduce((sum, x) => sum + Number(x?.updated || 0), 0)
          const totalOversize = info.accountResults.reduce((sum, x) => sum + Number(x?.oversize || 0), 0)
          const totalInvalid = info.accountResults.reduce((sum, x) => sum + Number(x?.invalid || 0), 0)
          alert(`重算完成：accounts=${processedAccounts}, inserted=${totalInserted}, oversize=${totalOversize}, invalid=${totalInvalid}`)
        } else {
          alert(`重算完成：processed=${info.processed ?? 0}, inserted=${info.inserted ?? 0}, oversize=${info.oversize ?? 0}, invalid=${info.invalid ?? 0}`)
        }
        await loadRules()
      } catch (e) {
        alert(`重算失败：${e.response?.data?.error || e.message}`)
      } finally {
        refreshingRuleId.value = null
      }
    }

    const refreshScopeItemsWithSync = async () => {
      if (!selectedAccountIds.value?.length) return
      scopeLoading.value = true
      try {
        if (selectedAccountIds.value.length === 1) {
          await facebookApi.syncStructure(selectedAccountIds.value[0])
        }
        await refreshScopeItems()
        // 刷新列表后重新解析已选对象，补齐 missing（验证5）
        if (ruleForm.value.targetIds?.length) {
          const items = await facebookApi.resolveObjectsByIds(ruleForm.value.targetIds).catch(() => [])
          const m = new Map()
          for (const it of items || []) m.set(String(it.id), it)
          resolvedSelectedMap.value = m
        }
      } catch (e) {
        const status = e.response?.status
        const data = e.response?.data
        if (status === 429 && data?.reason === 'cooldown') {
          const sec = data?.retry_after_sec ?? 120
          alert(`冷却中，请 ${sec} 秒后再试`)
        } else if (status === 429 && (data?.reason === 'quota_high' || data?.reason === 'fb_rate_limited')) {
          const sec = data?.retry_after_sec ?? 3600
          alert(`API 调用已达上限/使用率过高，请 ${sec} 秒后再试`)
        } else if (status === 409 && data?.reason === 'lock_busy') {
          alert('同步进行中，请稍后重试')
        } else {
          alert(`同步失败：${data?.error || e.message}`)
        }
      } finally {
        scopeLoading.value = false
      }
    }

    const refreshScopeItems = async () => {
      if (!selectedAccountIds.value?.length) return
      scopeLoading.value = true
      scopeReady.value = false
      const requestId = ++scopeRequestId.value
      const ids = selectedAccountIds.value
      const level = ruleForm.value.targetLevel
      const type = level
      const levelKey = level === 'campaign' ? 'campaigns' : (level === 'adset' ? 'adsets' : 'ads')
      const keyword = String(scopeSearch.value || '').trim()
      const isSearchMode = keyword.length > 0
      const limit = isSearchMode ? SCOPE_SEARCH_LIMIT : SCOPE_PAGE_LIMIT
      const isIdSearch = /^\d{10,}$/.test(keyword)
      try {
        if (ids.length === 1) {
          const promises = [
            facebookApi.getStructureObjects(levelKey, ids[0], {
              q: keyword,
              limit,
              after: null,
              include_paused: scopeIncludePaused.value,
              scope_status: scopeStatusFilter.value || undefined,
              scope_status_exclude: scopeStatusExcludeFilter.value || undefined,
              name_exclude: scopeNameExclude.value || undefined,
              scope_created_within_hours: scopeCreatedWithinHours.value ?? undefined
            })
          ]
          if (isIdSearch) promises.push(facebookApi.resolveObjectsByIds(keyword).catch(() => []))
          const results = await Promise.all(promises)
          if (requestId !== scopeRequestId.value) return
          let items = results[0]?.items || []
          if (isIdSearch && results[1]?.length > 0) {
            const existingIds = new Set(items.map(it => String(it.id)))
            for (const resolved of results[1]) {
              if (!existingIds.has(String(resolved.id))) items = [resolved, ...items]
            }
          }
          scopeItems.value = items
          scopePagingAfter.value = isSearchMode ? null : (results[0]?.paging?.after ?? null)
        } else {
          const result = await facebookApi.getStructureObjectsMulti(type, ids, {
            q: keyword,
            limit,
            after: null,
            include_paused: scopeIncludePaused.value,
            scope_status: scopeStatusFilter.value || undefined,
            scope_status_exclude: scopeStatusExcludeFilter.value || undefined,
            name_exclude: scopeNameExclude.value || undefined,
            scope_created_within_hours: scopeCreatedWithinHours.value ?? undefined
          })
          if (requestId !== scopeRequestId.value) return
          scopeItems.value = result.items || []
          scopePagingAfter.value = isSearchMode ? null : (result.paging?.after ?? null)
        }
        // 不再用当前页 scope 列表过滤 ruleForm.targetIds / excludeTargetIds，避免分页导致接口返回的 98 条被裁成 95 条；未出现在当前列表的 ID 仅做提示保留
        scopeReady.value = true
      } catch (e) {
        if (requestId !== scopeRequestId.value) return
        alert(`加载列表失败：${e.message}`)
        scopeItems.value = []
        scopePagingAfter.value = null
      } finally {
        if (requestId === scopeRequestId.value) scopeLoading.value = false
      }
    }

    /** 排除区有关键词时请求 q+limit=50+after=null，结果写 excludeScopeItems；无关键词不请求。
     * 与目标区一致：当关键词为纯数字且长度≥10 时视为 ID 搜索，额外调 resolve 并合并，使按广告 ID 也能搜到。 */
    const refreshExcludeScopeItems = async () => {
      const keyword = String(excludeScopeSearch.value || '').trim()
      if (!keyword || !selectedAccountIds.value?.length) {
        excludeScopeItems.value = []
        return
      }
      excludeScopeLoading.value = true
      const requestId = ++excludeRequestId.value
      const ids = selectedAccountIds.value
      const level = ruleForm.value.targetLevel
      const type = level
      const levelKey = level === 'campaign' ? 'campaigns' : (level === 'adset' ? 'adsets' : 'ads')
      const isIdSearch = /^\d{10,}$/.test(keyword)
      try {
        if (ids.length === 1) {
          const promises = [
            facebookApi.getStructureObjects(levelKey, ids[0], {
              q: keyword,
              limit: SCOPE_SEARCH_LIMIT,
              after: null,
              include_paused: scopeIncludePaused.value,
              scope_status: scopeStatusFilter.value || undefined,
              scope_status_exclude: scopeStatusExcludeFilter.value || undefined,
              name_exclude: scopeNameExclude.value || undefined,
              scope_created_within_hours: scopeCreatedWithinHours.value ?? undefined
            })
          ]
          if (isIdSearch) promises.push(facebookApi.resolveObjectsByIds(keyword).catch(() => []))
          const results = await Promise.all(promises)
          if (requestId !== excludeRequestId.value) return
          let items = results[0]?.items || []
          if (isIdSearch && results[1]?.length > 0) {
            const existingIds = new Set(items.map(it => String(it.id)))
            for (const resolved of results[1]) {
              if (resolved.missing) continue
              const id = String(resolved.id || '').trim()
              if (!id || existingIds.has(id)) continue
              existingIds.add(id)
              items = [{ id, name: resolved.name || '', effective_status: resolved.effective_status ?? null, account_id: ids[0] }, ...items]
            }
          }
          excludeScopeItems.value = items
        } else {
          const result = await facebookApi.getStructureObjectsMulti(type, ids, {
            q: keyword,
            limit: SCOPE_SEARCH_LIMIT,
            after: null,
            include_paused: scopeIncludePaused.value,
            scope_status: scopeStatusFilter.value || undefined,
            scope_status_exclude: scopeStatusExcludeFilter.value || undefined,
            name_exclude: scopeNameExclude.value || undefined,
            scope_created_within_hours: scopeCreatedWithinHours.value ?? undefined
          })
          if (requestId !== excludeRequestId.value) return
          excludeScopeItems.value = result.items || []
        }
      } catch {
        if (requestId === excludeRequestId.value) excludeScopeItems.value = []
      } finally {
        if (requestId === excludeRequestId.value) excludeScopeLoading.value = false
      }
    }

    const loadMoreScopeItems = async () => {
      const ids = selectedAccountIds.value
      if (!ids?.length || !scopePagingAfter.value) return false
      scopeLoading.value = true
      const requestId = ++scopeRequestId.value
      try {
        const level = ruleForm.value.targetLevel
        const type = level
        const levelKey = level === 'campaign' ? 'campaigns' : (level === 'adset' ? 'adsets' : 'ads')
        if (ids.length === 1) {
          const resp = await facebookApi.getStructureObjects(levelKey, ids[0], {
            q: String(scopeSearch.value || '').trim(),
            limit: SCOPE_PAGE_LIMIT,
            after: scopePagingAfter.value,
            include_paused: scopeIncludePaused.value,
            scope_status: scopeStatusFilter.value || undefined,
            scope_status_exclude: scopeStatusExcludeFilter.value || undefined,
            name_exclude: scopeNameExclude.value || undefined,
            scope_created_within_hours: scopeCreatedWithinHours.value ?? undefined
          })
          if (requestId !== scopeRequestId.value) return false
          scopeItems.value = [...scopeItems.value, ...(resp.items || [])]
          scopePagingAfter.value = resp?.paging?.after || null
        } else {
          const result = await facebookApi.getStructureObjectsMulti(type, ids, {
            q: String(scopeSearch.value || '').trim(),
            limit: SCOPE_PAGE_LIMIT,
            after: scopePagingAfter.value,
            include_paused: scopeIncludePaused.value,
            scope_status: scopeStatusFilter.value || undefined,
            scope_status_exclude: scopeStatusExcludeFilter.value || undefined,
            name_exclude: scopeNameExclude.value || undefined,
            scope_created_within_hours: scopeCreatedWithinHours.value ?? undefined
          })
          if (requestId !== scopeRequestId.value) return false
          scopeItems.value = [...scopeItems.value, ...(result.items || [])]
          scopePagingAfter.value = result.paging?.after ?? null
          // 非后台拉全量时，加载更多后对当前列表重新应用勾选；开启动态时不写 targetIds（做法 A）
          if (!isApplyingScopeConditions.value && !ruleForm.value.useDynamicScope) {
            const completed = scopeConditionRows.value.filter(row => !scopeConditionRowError(row))
            if (completed.length > 0) applyScopeConditionsToCurrentList(completed, true)
          }
        }
        scopeReady.value = true
        return true
      } catch (e) {
        if (requestId !== scopeRequestId.value) return false
        alert(`加载更多失败：${e.message}`)
        return false
      } finally {
        if (requestId === scopeRequestId.value) scopeLoading.value = false
      }
    }

    const selectAllScope = () => {
      ruleForm.value.targetIds = filteredScopeItems.value.map(item => scopeItemValue(item))
    }

    const clearScopeSelection = () => {
      ruleForm.value.targetIds = []
    }

    const selectAllExcludeScope = () => {
      const toAdd = filteredExcludeScopeItems.value.map(item => scopeItemValue(item))
      ruleForm.value.excludeTargetIds = [...new Set([...ruleForm.value.excludeTargetIds, ...toAdd])]
    }

    const clearExcludeScopeSelection = () => {
      ruleForm.value.excludeTargetIds = []
    }

    const onAddAccount = (e) => {
      const v = e?.target?.value
      if (!v) return
      if (!selectedAccountIds.value.includes(v)) selectedAccountIds.value = [...selectedAccountIds.value, v]
      accountToAdd.value = ''
    }
    const removeAccount = (aid) => {
      selectedAccountIds.value = selectedAccountIds.value.filter(id => id !== aid)
    }
    const selectAllAccounts = () => {
      selectedAccountIds.value = accounts.value.map(a => a.id)
    }
    const clearAllAccounts = () => {
      selectedAccountIds.value = []
    }
    const accountLabel = (aid) => {
      const a = accounts.value.find(x => x.id === aid)
      return a ? `${a.name} (${aid})` : aid
    }

    watch(selectedAccountIds, (val) => {
      if (!val?.length) {
        scopeItems.value = []
        excludeScopeItems.value = []
        scopeReady.value = false
        scopePagingAfter.value = null
        if (!isEditing.value) ruleForm.value.targetIds = []
        if (!isEditing.value) ruleForm.value.excludeTargetIds = []
        return
      }
      scopeItems.value = []
      excludeScopeItems.value = []
      scopeReady.value = false
      scopePagingAfter.value = null
      if (!isEditing.value) ruleForm.value.targetIds = []
      if (!isEditing.value) ruleForm.value.excludeTargetIds = []
      refreshScopeItems()
    }, { deep: true })

    watch(() => ruleForm.value.targetLevel, () => {
      if (!selectedAccountIds.value?.length) return
      scopeItems.value = []
      scopeReady.value = false
      scopePagingAfter.value = null
      // 切换层级：新建规则清空；编辑规则保留并提示“可能有失效对象”
      if (!isEditing.value) ruleForm.value.targetIds = []
      if (!isEditing.value) ruleForm.value.excludeTargetIds = []
      refreshScopeItems()
    })

    // 输入搜索词时改为“服务端搜索”（避免只在当前页过滤）
    let searchTimer = null
    watch(scopeSearch, () => {
      if (isApplyingScopeConditions.value) return
      if (!selectedAccountIds.value?.length) return
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(() => {
        scopeItems.value = []
        scopeReady.value = false
        scopePagingAfter.value = null
        refreshScopeItems()
      }, 300)
    })

    // 排除区搜索：防抖后有关键词则请求 q+limit=50，无关键词用 scopeItems
    let excludeSearchTimer = null
    watch(excludeScopeSearch, () => {
      const keyword = String(excludeScopeSearch.value || '').trim()
      if (!keyword) {
        excludeScopeItems.value = []
        if (excludeSearchTimer) clearTimeout(excludeSearchTimer)
        excludeSearchTimer = null
        return
      }
      if (!selectedAccountIds.value?.length) return
      if (excludeSearchTimer) clearTimeout(excludeSearchTimer)
      excludeSearchTimer = setTimeout(() => {
        excludeSearchTimer = null
        refreshExcludeScopeItems()
      }, 300)
    })

    const todayYMD = () => {
      const d = new Date()
      return d.toISOString().slice(0, 10)
    }

    const onWhenTimeWindowChange = () => {
      if (whenTimeWindow.value === 'custom_range' && !whenCustomRange.value) {
        whenCustomRange.value = getDefaultWhenCustomRange()
      }
    }

    const addWhenLine = () => {
      const join = whenLines.value.length === 0 ? null : 'AND'
      whenLines.value.push(createDefaultWhenLine(join))
    }

    const removeWhenLine = (idx) => {
      whenLines.value.splice(idx, 1)
      ensureWhenLinesNonEmpty()
    }

    const addScopeConditionRow = () => {
      if (isScopeConditionsDisabled.value) return
      if (scopeConditionRows.value.length >= SCOPE_CONDITION_MAX_ROWS) return
      scopeConditionRows.value.push(createDefaultScopeConditionRow())
    }
    const removeScopeConditionRow = (idx) => {
      if (isScopeConditionsDisabled.value) return
      scopeConditionRows.value.splice(idx, 1)
      if (scopeConditionRows.value.length === 0) {
        scopeConditionRows.value = [createDefaultScopeConditionRow()]
      }
    }
    const onScopeConditionFieldChange = (row) => {
      if (isScopeConditionsDisabled.value) return
      if (row.field === 'name') {
        row.operator = 'include'
        row.value = ''
      } else if (row.field === 'created_within') {
        row.operator = 'include'
        row.value = ''
        row.customHours = null
      } else {
        row.operator = 'equals'
        row.value = ''
      }
    }
    const scopeConditionRowError = (row) => {
      const v = String(row.value || '').trim()
      if (row.field === 'status' && !v) return '数据不能为空'
      if (row.field === 'name' && !v) return '数据不能为空'
      if (row.field === 'created_within') {
        if (v === '24' || v === '48' || v === '72') return null
        if (v === 'custom') {
          const h = row.customHours
          if (h == null || !Number.isFinite(h) || h < 1 || h > 720) return '请选择时间范围或填写小时数'
          return null
        }
        return '请选择时间范围或填写小时数'
      }
      return null
    }

    /** 应用监控范围条件。有筛选条件时走预览接口，与规则执行共用后端逻辑（消除 91 vs 101）。 */
    const applyScopeConditions = async () => {
      if (isApplyingScopeConditions.value) return
      scopeApplyMessage.value = ''
      const completed = scopeConditionRows.value.filter(row => !scopeConditionRowError(row))
      if (completed.length === 0) {
        scopeApplyMessage.value = '请至少填写一行完整条件'
        return
      }
      if (!selectedAccountIds.value.length) {
        scopeApplyMessage.value = '请先选择账户并加载列表'
        return
      }

      const multi = selectedAccountIds.value.length > 1
      const nameIncludeRow = completed.find(r => r.field === 'name' && r.operator === 'include' && String(r.value || '').trim())
      const nameIncludeKeyword = nameIncludeRow ? String(nameIncludeRow.value || '').trim() : ''
      const nameExcludeRow = completed.find(r => r.field === 'name' && r.operator === 'exclude' && String(r.value || '').trim())
      const nameExcludeKeyword = nameExcludeRow ? String(nameExcludeRow.value || '').trim() : ''
      const statusRow = completed.find(r => r.field === 'status' && String(r.value || '').trim())
      const scopeStatus = statusRow ? String(statusRow.value || '').trim() : '' // active_only | paused_only | active_and_paused
      const hasStatusCondition = !!scopeStatus
      // 创建时间段：多行取最短窗口（AND 语义）
      const resolveHoursFromRow = (r) => {
        if (r.field !== 'created_within') return null
        const val = r.value
        if (val === '24' || val === '48' || val === '72') return parseInt(val, 10)
        if (val === 'custom' && r.customHours != null && Number.isFinite(r.customHours) && r.customHours >= 1 && r.customHours <= 720) return r.customHours
        return null
      }
      const createdRows = completed.filter(r => r.field === 'created_within')
      const hoursList = createdRows.map(r => resolveHoursFromRow(r)).filter(h => Number.isFinite(h) && h > 0)
      const effectiveCreatedWithinHours = hoursList.length ? Math.min(...hoursList) : null
      scopeCreatedWithinHours.value = effectiveCreatedWithinHours

      // 状态「等于」传 scope_status；状态「不等于」传 scope_status_exclude（后端枚举 ACTIVE | PAUSED | ACTIVE,PAUSED）
      if (statusRow) {
        const excludeBackend = scopeStatus === 'active_only' ? 'ACTIVE' : scopeStatus === 'paused_only' ? 'PAUSED' : scopeStatus === 'active_and_paused' ? 'ACTIVE,PAUSED' : ''
        if (statusRow.operator === 'not_equals') {
          scopeStatusExcludeFilter.value = excludeBackend
          scopeStatusFilter.value = ''
        } else {
          scopeStatusFilter.value = scopeStatus
          scopeStatusExcludeFilter.value = ''
        }
      } else {
        scopeStatusFilter.value = ''
        scopeStatusExcludeFilter.value = ''
      }

      const hasCreatedWithinCondition = effectiveCreatedWithinHours != null
      const needFetchAll = !!nameIncludeKeyword || !!nameExcludeKeyword || hasStatusCondition || hasCreatedWithinCondition

      if (needFetchAll) {
        scopeApplyMessage.value = '正在计算监控范围…'
        scopeSearch.value = nameIncludeKeyword
        scopeNameExclude.value = nameExcludeKeyword || ''
        if (hasStatusCondition) scopeIncludePaused.value = true
        isApplyingScopeConditions.value = true
        try {
          const scope_filters = buildScopeFiltersFromRows(scopeConditionRows.value, ruleForm.value.targetLevel)
          const exclude_ids = buildExcludeIdsForPreview(ruleForm.value.excludeTargetIds, ruleForm.value.targetLevel)
          const max_dynamic_matches = ruleForm.value.maxDynamicMatches != null && Number.isFinite(Number(ruleForm.value.maxDynamicMatches))
            ? Number(ruleForm.value.maxDynamicMatches)
            : undefined
          const response = await facebookApi.previewDynamicScope({
            account_ids: selectedAccountIds.value,
            target_level: ruleForm.value.targetLevel,
            scope_filters,
            exclude_ids,
            max_dynamic_matches
          })
          ruleForm.value.targetIds = response.object_ids || []
          scopeApplyMessage.value = `已勾选 ${response.count} 个对象（与规则执行范围一致）`
          if (response.per_account) {
            const oversizedAccounts = Object.keys(response.per_account).filter(
              accId => response.per_account[accId].status === 'ERROR_OVERSIZE'
            )
            if (oversizedAccounts.length > 0) {
              scopeApplyMessage.value += ` (注意：账户 ${oversizedAccounts.join(', ')} 匹配数超限)`
            }
          }
        } catch (err) {
          const data = err.response?.data
          scopeApplyMessage.value = data?.error || err.message || '预览失败'
        } finally {
          isApplyingScopeConditions.value = false
        }
        return
      }

      if (!scopeItems.value.length) {
        scopeApplyMessage.value = '请先选择账户并加载列表'
        return
      }

      applyScopeConditionsToCurrentList(completed, multi)
    }

    /** 将「当前匹配」结果同步到表单 targetIds，并提示用户保存；仅在有差异时由 [同步] 按钮触发 */
    const syncConfigFromMatch = async () => {
      if (isApplyingScopeConditions.value) return
      if (!ruleForm.value.useDynamicScope || !selectedAccountIds.value?.length) return
      const completed = scopeConditionRows.value.filter(row => !scopeConditionRowError(row))
      if (completed.length === 0) {
        syncJustDoneMessage.value = '请先填写完整的监控范围条件'
        return
      }
      syncJustDoneMessage.value = ''
      isApplyingScopeConditions.value = true
      try {
        const scope_filters = buildScopeFiltersFromRows(scopeConditionRows.value, ruleForm.value.targetLevel)
        const exclude_ids = buildExcludeIdsForPreview(ruleForm.value.excludeTargetIds, ruleForm.value.targetLevel)
        const max_dynamic_matches = ruleForm.value.maxDynamicMatches != null && Number.isFinite(Number(ruleForm.value.maxDynamicMatches))
          ? Number(ruleForm.value.maxDynamicMatches)
          : undefined
        const prevLen = (ruleForm.value.targetIds || []).length
        const response = await facebookApi.previewDynamicScope({
          account_ids: selectedAccountIds.value,
          target_level: ruleForm.value.targetLevel,
          scope_filters,
          exclude_ids,
          max_dynamic_matches
        })
        ruleForm.value.targetIds = response.object_ids || []
        if ((ruleForm.value.targetIds || []).length !== prevLen) {
          syncJustDoneMessage.value = '配置已更新，请点击【保存规则】以使更改永久生效'
        }
      } catch (err) {
        const data = err.response?.data
        syncJustDoneMessage.value = data?.error || err.message || '同步失败'
      } finally {
        isApplyingScopeConditions.value = false
      }
    }

    /** 按当前 scopeItems 与已完成的条件行，做 match 并写回 targetIds（供 applyScopeConditions 与加载更多后复用） */
    function applyScopeConditionsToCurrentList(completed, multi) {
      const match = (item) => {
        for (const row of completed) {
          if (row.field === 'created_within') continue // 后端已按 created_time 过滤，前端视为通过
          if (row.field === 'name') {
            const name = String(item.name || '').toLowerCase()
            const keyword = String(row.value || '').trim().toLowerCase()
            if (row.operator === 'include') {
              if (!keyword || !name.includes(keyword)) return false
            } else {
              if (keyword && name.includes(keyword)) return false
            }
          } else {
            const status = item.effective_status || item.status || ''
            const statusMatch = (val) => {
              if (val === 'active_only') return status === 'ACTIVE'
              if (val === 'paused_only') return status === 'PAUSED'
              if (val === 'active_and_paused') return ['ACTIVE', 'PAUSED'].includes(status)
              return false
            }
            if (row.operator === 'equals') {
              if (!statusMatch(row.value)) return false
            } else if (row.operator === 'not_equals') {
              if (statusMatch(row.value)) return false
            }
          }
        }
        return true
      }
      const matched = scopeItems.value.filter(match)
      ruleForm.value.targetIds = matched.map(item => (multi ? `${item.account_id || ''}:${item.id}` : item.id))
      const total = scopeItems.value.length
      if (multi && scopePagingAfter.value) {
        scopeApplyMessage.value = matched.length
          ? `已勾选 ${matched.length} 个（当前已加载 ${total} 条）。点击「加载更多」可继续加载并自动更新勾选`
          : `当前已加载 ${total} 条中无匹配项。点击「加载更多」可继续加载`
      } else {
        scopeApplyMessage.value = matched.length ? `已勾选 ${matched.length} 个对象` : '当前列表无匹配项'
      }
    }

    // 监控范围条件 / 已选账户 / 目标层级 任一变更：无「名称 包含」有值时清空搜索栏
    let scopeAutoApplyTimer = null
    watch(
      [scopeConditionRows, selectedAccountIds, () => ruleForm.value.targetLevel],
      () => {
        const hasNameIncludeValue = scopeConditionRows.value.some(
          r => r.field === 'name' && r.operator === 'include' && String(r.value || '').trim()
        )
        if (!hasNameIncludeValue) scopeSearch.value = ''
        if (scopeAutoApplyTimer) clearTimeout(scopeAutoApplyTimer)
        scopeAutoApplyTimer = null
      },
      { deep: true }
    )

    /** 开启动态时仅更新 matchedCount 的防抖预览（不写 targetIds，做法 A） */
    let matchedCountPreviewTimer = null
    watch(
      [
        scopeConditionRows,
        selectedAccountIds,
        () => ruleForm.value.targetLevel,
        () => ruleForm.value.excludeTargetIds,
        () => ruleForm.value.maxDynamicMatches,
        () => ruleForm.value.useDynamicScope
      ],
      () => {
        if (ruleForm.value.useDynamicScope !== true) return
        if (!selectedAccountIds.value?.length) {
          if (matchedCountPreviewTimer) clearTimeout(matchedCountPreviewTimer)
          matchedCountPreviewTimer = null
          return
        }
        const completed = scopeConditionRows.value.filter(row => !scopeConditionRowError(row))
        if (completed.length === 0) {
          ruleForm.value.matchedCount = null
          if (matchedCountPreviewTimer) clearTimeout(matchedCountPreviewTimer)
          matchedCountPreviewTimer = null
          return
        }
        if (matchedCountPreviewTimer) clearTimeout(matchedCountPreviewTimer)
        matchedCountPreviewTimer = setTimeout(async () => {
          matchedCountPreviewTimer = null
          try {
            const scope_filters = buildScopeFiltersFromRows(scopeConditionRows.value, ruleForm.value.targetLevel)
            const exclude_ids = buildExcludeIdsForPreview(ruleForm.value.excludeTargetIds, ruleForm.value.targetLevel)
            const max_dynamic_matches = ruleForm.value.maxDynamicMatches != null && Number.isFinite(Number(ruleForm.value.maxDynamicMatches))
              ? Number(ruleForm.value.maxDynamicMatches)
              : undefined
            const response = await facebookApi.previewDynamicScope({
              account_ids: selectedAccountIds.value,
              target_level: ruleForm.value.targetLevel,
              scope_filters,
              exclude_ids,
              max_dynamic_matches
            })
            ruleForm.value.matchedCount = response.count != null ? Number(response.count) : null
          } catch {
            ruleForm.value.matchedCount = null
          }
        }, 3000)
      },
      { deep: true }
    )

    const clearScopeConditions = () => {
      scopeConditionRows.value = [createDefaultScopeConditionRow()]
      scopeApplyMessage.value = ''
      scopeStatusFilter.value = ''
      scopeStatusExcludeFilter.value = ''
      scopeNameExclude.value = ''
      scopeCreatedWithinHours.value = null
    }

    watch(
      () => ruleForm.value.useDynamicScope,
      (next, prev) => {
        if (prev === true && next === false) {
          clearScopeConditions()
        }
      }
    )

    watch(
      () => ruleForm.value.targetLevel,
      (next) => {
        if (next === 'ad') return
        for (const line of whenLines.value || []) {
          if (line.metric === 'purchases_avg_after_create') line.metric = 'purchases'
        }
        for (const action of ruleForm.value.actions || []) {
          if (action.type === 'set_dynamic_budget' && action.metric === 'purchases_avg_after_create') {
            action.metric = 'purchases'
          }
        }
      }
    )

    watch(showRuleModal, (v) => {
      if (!v) syncJustDoneMessage.value = ''
    })

    const addAction = () => {
      ruleForm.value.actions.push({ type: 'pause_ad', value: null })
    }

    /** 预算动作展示：$5 或 10% 或 设置为$30 */
    const formatBudgetValue = (a) => {
      if (a.value == null) return ''
      if (a.type === 'set_budget') return `=$${Number(a.value)}`
      return (a.value_unit === 'usd') ? `$${Number(a.value)}` : `${a.value}%`
    }

    const formatDynamicBudgetValue = (a) => {
      const metric = metricLabel(a.metric || 'purchases')
      const multiplier = Number(a.multiplier || 0)
      const parts = [`${metric} × ${multiplier}`]
      if (a.min_daily_budget != null) parts.push(`下限 $${(Number(a.min_daily_budget) / 100).toFixed(2)}`)
      if (a.max_daily_budget != null) parts.push(`上限 $${(Number(a.max_daily_budget) / 100).toFixed(2)}`)
      return parts.join('，')
    }

    /** 预算上限输入（美元 → 分）：展示用美元，后端存分；输入 0 视为未设置 */
    const onMaxBudgetInput = (e, a) => {
      const raw = e.target.value
      if (raw === '' || raw == null) {
        a.max_daily_budget = undefined
        return
      }
      const yuan = parseFloat(raw)
      if (Number.isNaN(yuan) || yuan < 0) {
        a.max_daily_budget = undefined
        return
      }
      if (yuan === 0) {
        a.max_daily_budget = undefined
        return
      }
      a.max_daily_budget = Math.round(yuan * 100)
    }

    /** 预算下限输入（美元 → 分）：展示用美元，后端存分；输入 0 视为未设置 */
    const onMinBudgetInput = (e, a) => {
      const raw = e.target.value
      if (raw === '' || raw == null) {
        a.min_daily_budget = undefined
        return
      }
      const yuan = parseFloat(raw)
      if (Number.isNaN(yuan) || yuan < 0) {
        a.min_daily_budget = undefined
        return
      }
      if (yuan === 0) {
        a.min_daily_budget = undefined
        return
      }
      a.min_daily_budget = Math.round(yuan * 100)
    }

    const applyTemplate = (template) => {
      if (!template || !confirm('这将覆盖当前条件设置，确定吗？')) return
      const lines = Array.isArray(template.when_lines) ? template.when_lines : []
      whenLines.value = lines.length ? lines.map(l => ({ ...l })) : [createDefaultWhenLine(null)]
      whenTimeWindow.value = template.when_time_window || 'today'
      whenCustomRange.value = template.when_custom_range ? { ...template.when_custom_range } : null
      const acts = Array.isArray(template.actions) ? template.actions : []
      ruleForm.value.actions = acts.length ? acts.map(a => ({ ...a })) : [{ type: 'pause_ad', value: null }]
    }

    /** 负责人下拉：点击外部关闭的清理函数 */
    let ownerFilterClickOutsideCleanup = null

    onMounted(async () => {
      try {
        const res = await authFetch('/api/me')
        if (res.ok) {
          const data = await res.json()
          const u = data?.user
          if (u?.id != null) {
            const uid = Number(u.id)
            if (Number.isFinite(uid) && uid > 0) {
              currentUserId.value = uid
              hydrateExpandedRuleIds()
            }
          }
        }
      } catch (_) {
        /* 未登录或网络失败：仍可用页面，折叠状态仅内存、不按用户持久化 */
      }

      await loadAccounts()
      await loadRules()

      const handleOwnerFilterClickOutside = (e) => {
        const el = ownerDropdownRef.value
        if (el && !el.contains(e.target)) ownerFilterOpen.value = false
      }
      document.addEventListener('mousedown', handleOwnerFilterClickOutside)
      ownerFilterClickOutsideCleanup = () => document.removeEventListener('mousedown', handleOwnerFilterClickOutside)
    })

    onBeforeUnmount(() => {
      if (ownerFilterClickOutsideCleanup) {
        ownerFilterClickOutsideCleanup()
        ownerFilterClickOutsideCleanup = null
      }
    })

    // 仅开发环境：挂到 window 供控制台验证阶段 1 转换函数（生产构建不会包含）
    if (import.meta.env?.DEV) {
      window.__ruleManagerVerify = {
        linesToV2Groups,
        v2ToLines,
        v1ToLines
      }
    }

    return {
      rules, showRuleModal, editingRuleId, ruleForm, running, runningRuleId, refreshingRuleId,
      isAdminFromRules, ownersList, selectedOwnerIds, includeNoOwner,
      ownerFilterOpen, ownerFilterDisplayValue, ownerDropdownRef, clearOwnerFilter, toggleOwnerOption, toggleNoOwnerOption,
      bulkMode, selectedRuleIds, selectedCount, enterBulkMode, exitBulkMode, toggleRuleSelection, toggleSelectAllRules, onCardClick,
      showBatchModal, batchAccounts, batchAccountIds, batchSaving, batchResult, batchError,
      openBatchModal, closeBatchModal, toggleBatchAccount, selectAllBatchAccounts, clearBatchAccounts, submitBatchAddAccounts,
      isRuleCardExpanded, toggleRuleCardExpand, collapseAllRuleCards, expandAllRuleCards,
      visibleConditionsForCard, extraCondGroupsCount,
      whenLines, whenTimeWindow, whenCustomRange, conditionMetricOptions, dynamicBudgetMetricOptions,
      linesToV2Groups, v2ToLines, v1ToLines,
      createDefaultWhenLine, ensureWhenLinesNonEmpty, getDefaultWhenCustomRange,
      accounts, selectedAccountIds, accountToAdd, accountsFilteredForAdd, accountLabel, onAddAccount, removeAccount, selectAllAccounts, clearAllAccounts,
      scopeItems, scopeSearch, excludeScopeSearch, scopeLoading, scopeReady, excludeAreaLoading, filteredScopeItems, filteredExcludeScopeItems, scopeItemKey, scopeItemValue, scopeLoadedIdSet,
      accountLoading, accountError, loadAccounts,
      canSelectAll, canSelectAllExclude, selectedTargetPreview,
      scopePagingAfter, loadMoreScopeItems, missingSelectedCount, resolvedSelectedMap,
      isApplyingScopeConditions, invalidIdSet,
      levelOptions, hasBudgetAction,
      loadRules, loadTemplates, templates, zeroClickTemplate, metricLabel, opLabel, actionLabel, getActionClass, timeWindowLabel,
      formatExecutionTimeDisplay, formatIntervalDisplay, dynamicStatusLabel, dynamicStatusClass,
      ratioMetricTip,
      openCreateRule, openEditRule, saveRule, deleteRule, toggleRule, runThisRule, refreshDynamicScopeForRule,
      showBootstrapButton, bootstrapLoading, bootstrapFromTemplates, bootstrapFeedback,
      refreshScopeItems, refreshScopeItemsWithSync, selectAllScope, clearScopeSelection, selectAllExcludeScope, clearExcludeScopeSelection,
      showSyncButton, syncJustDoneMessage, syncConfigFromMatch,
      addWhenLine, removeWhenLine, onWhenTimeWindowChange, addAction, onMaxBudgetInput, onMinBudgetInput, applyTemplate, formatBudgetValue, formatDynamicBudgetValue, onActionTypeChange,
      scopeConditionRows, SCOPE_CONDITION_MAX_ROWS, addScopeConditionRow, removeScopeConditionRow, onScopeConditionFieldChange, isScopeConditionsDisabled,
      scopeConditionRowError, scopeApplyMessage,
      executionTimeAllDay, executionTimeStart, executionTimeEnd, INTERVAL_PRESETS
    }
  }
}
</script>

<style scoped>
.rule-page {
  padding-bottom: 40px;
}

/* 免责提示 */
.disclaimer-banner {
  background: #fffbeb;
  border: 1px solid #fcd34d;
  color: #92400e;
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 20px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  font-size: 14px;
  line-height: 1.5;
}
.disclaimer-banner .icon { font-size: 18px; }
.muted { color: var(--text-secondary); margin-left: 6px; font-size: 12px; }

/* 比值类指标口径提示 */
.ratio-tip {
  background: #eff6ff;
  border: 1px solid #93c5fd;
  color: #1e40af;
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 13px;
  line-height: 1.5;
}
.ratio-tip .icon { font-size: 16px; flex-shrink: 0; }
.ratio-tip .btn-tiny { margin-left: auto; flex-shrink: 0; }

.header-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.header-actions h2 { margin: 0; font-size: 24px; color: var(--text-primary); }
.actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.actions .btn.small {
  padding: 6px 12px;
  font-size: 13px;
}

.owner-filter-wrap {
  position: relative;
  min-width: 240px;
}

.owner-filter-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 240px;
  padding: 8px 12px;
  background: #fff;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.owner-filter-trigger:hover {
  border-color: var(--primary-color, #2563eb);
  box-shadow: 0 0 0 1px var(--primary-color, #2563eb);
}

.owner-filter-trigger-text {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  min-width: 0;
}
.owner-filter-label-inline {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-secondary, #6b7280);
}
.owner-filter-value {
  font-weight: 500;
  color: var(--text-primary, #111827);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.owner-filter-trigger-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.owner-filter-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  border-radius: 4px;
}
.owner-filter-clear:hover {
  color: var(--danger-color, #dc2626);
  background: #fef2f2;
}
.owner-filter-chevron {
  font-size: 10px;
  color: var(--text-secondary, #6b7280);
  transition: transform 0.2s;
}
.owner-filter-chevron.open {
  transform: rotate(180deg);
}

.owner-filter-panel {
  position: absolute;
  z-index: 50;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 4px;
  background: #fff;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  max-height: 240px;
  overflow-y: auto;
  padding: 4px 0;
}

.owner-filter-option {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  font-size: 14px;
  cursor: pointer;
  color: var(--text-primary, #374151);
  transition: background 0.15s;
}
.owner-filter-option:hover {
  background: #f3f4f6;
}
.owner-filter-option.selected {
  background: #eff6ff;
  color: #1d4ed8;
}
.owner-filter-option-clear {
  color: var(--text-secondary, #6b7280);
  border-bottom: 1px solid var(--border-color, #e5e7eb);
  margin-bottom: 4px;
}
.owner-filter-option-clear:hover {
  background: #f9fafb;
  color: var(--primary-color, #2563eb);
}

.owner-filter-checkbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-right: 10px;
  flex-shrink: 0;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  background: #fff;
  transition: border-color 0.2s, background 0.2s;
}
.owner-filter-option.selected .owner-filter-checkbox {
  border-color: #2563eb;
  background: #2563eb;
}
.owner-filter-check {
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
}

.owner-filter-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 负责人下拉展开/收起过渡 */
.owner-dropdown-enter-active,
.owner-dropdown-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.owner-dropdown-enter-from,
.owner-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.owner-info .owner-name { color: var(--text-primary); }

/* 卡片网格 */
.rules-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
}

.rule-card {
  background: #fff;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  box-shadow: 0 2px 8px rgba(0,0,0,0.04);
  transition: all 0.2s;
  display: flex;
  flex-direction: column;
}

.rule-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 16px rgba(0,0,0,0.08);
}

.rule-card.disabled {
  opacity: 0.7;
  background: #f9fafb;
}

.card-header {
  padding: 16px;
  border-bottom: 1px solid var(--bg-body);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.card-header-titles {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.card-expand-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--primary-color, #2563eb);
  padding: 0;
}
.card-expand-toggle:hover {
  color: #1d4ed8;
  text-decoration: none;
}
.card-expand-chevron {
  font-size: 9px;
  transition: transform 0.2s;
  display: inline-block;
}
.card-expand-chevron.open {
  transform: rotate(180deg);
}

/* 批量模式：规则卡片复选框 */
.rule-select-checkbox {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  cursor: pointer;
  margin-top: 2px;
  user-select: none;
}
.rule-select-box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-color, #d1d5db);
  border-radius: 4px;
  transition: background 0.15s, border-color 0.15s;
}
.rule-select-box.checked {
  background: var(--primary-color, #2563eb);
  border-color: var(--primary-color, #2563eb);
}
.rule-select-check {
  color: #fff;
  font-size: 12px;
  font-weight: bold;
  line-height: 1;
}

/* 批量模式：已选计数 */
.bulk-counter {
  font-size: 14px;
  font-weight: 600;
  color: var(--primary-color, #2563eb);
  align-self: center;
  white-space: nowrap;
}

.cond-more-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
  line-height: 1.4;
}

.rule-name { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.4; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.badge-dnf { font-size: 10px; font-weight: 500; padding: 2px 6px; border-radius: 4px; background: #dbeafe; color: #1d4ed8; }

.card-body {
  padding: 16px;
  flex: 1;
}

.section { margin-bottom: 8px; }
.label { display: block; font-size: 11px; color: var(--text-secondary); margin-bottom: 6px; font-weight: 600; }
.account-info { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px dashed var(--border); }
.account-info .label { display: inline; margin-bottom: 0; }
.account-id { font-size: 12px; color: var(--primary); font-family: monospace; background: var(--bg-secondary); padding: 2px 6px; border-radius: 4px; }
.arrow { text-align: center; color: var(--text-secondary); margin: 4px 0; font-size: 12px; }

.execution-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; font-size: 12px; }
.execution-meta .label { display: inline; margin-bottom: 0; }

.pill {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 13px;
  margin: 0 6px 6px 0;
  border: 1px solid transparent;
}

.condition { background: #EAF3FF; color: var(--primary-color); border-color: #D6E4FF; }
.action { font-weight: 600; }
.action.danger { background: #FFF5F5; color: var(--danger-color); border-color: #FED7D7; }
.action.success { background: #F0FFF4; color: var(--secondary-color); border-color: #C6F6D5; }
.val { font-weight: 400; opacity: 0.9; }
.dynamic-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dynamic-on { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
.dynamic-off { background: #f3f4f6; color: #6b7280; border-color: #d1d5db; }
.dynamic-status-normal { background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; }
.dynamic-status-warn { background: #fffbeb; color: #b45309; border-color: #fde68a; }
.dynamic-status-error { background: #fff1f2; color: #be123c; border-color: #fecdd3; }
.dynamic-error { color: #b45309; }

.card-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--bg-body);
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.btn-text { background: none; border: none; cursor: pointer; color: var(--text-secondary); font-size: 13px; }
.btn-text:hover { color: var(--primary-color); text-decoration: underline; }
.btn-text.danger:hover { color: var(--danger-color); }

/* Switch 开关 */
.switch { position: relative; display: inline-block; width: 36px; height: 20px; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 20px; }
.slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%; }
input:checked + .slider { background-color: var(--secondary-color); }
input:checked + .slider:before { transform: translateX(16px); }

/* 空状态 */
.empty-rules { text-align: center; padding: 60px 0; color: var(--text-secondary); }
.empty-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
.empty-actions { display: inline-flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
.empty-note { margin-top: 12px; font-size: 13px; color: #6b7280; }
.empty-feedback { margin: 12px auto 0; padding: 8px 12px; border-radius: 8px; width: fit-content; max-width: 520px; font-size: 13px; }
.empty-feedback.success { background: #ecfdf5; border: 1px solid #6ee7b7; color: #065f46; }
.empty-feedback.info { background: #eff6ff; border: 1px solid #93c5fd; color: #1e40af; }
.empty-feedback.error { background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b; }

/* 模态框 */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal-content {
  background: #fff; width: 90%; max-width: 600px; border-radius: 12px;
  box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1);
  animation: slideUp 0.3s ease;
}
.modal-content.wide { max-width: 800px; }
@keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

.modal-header { padding: 16px 24px; border-bottom: 1px solid var(--bg-body); display: flex; justify-content: space-between; align-items: center; }
.modal-body { padding: 24px; max-height: 70vh; overflow-y: auto; }
.modal-footer { padding: 16px 24px; border-top: 1px solid var(--bg-body); display: flex; justify-content: flex-end; gap: 12px; }

.form-group { margin-bottom: 20px; }
.form-group label { display: block; margin-bottom: 8px; font-weight: 500; font-size: 14px; }
.input-text { width: 100%; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; }
.input-textarea { width: 100%; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: 6px; font-family: 'Consolas', 'Monaco', monospace; font-size: 13px; resize: vertical; }
.alert.info { background: #eff6ff; border: 1px solid #93c5fd; color: #1e40af; padding: 10px 12px; border-radius: 6px; font-size: 13px; }

.condition-row, .action-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; flex-wrap: wrap; }
.select { padding: 8px; border: 1px solid var(--border-color); border-radius: 6px; flex: 1; }
.input-date { padding: 8px; border: 1px solid var(--border-color); border-radius: 6px; width: 140px; font-size: 13px; }
.date-sep { font-size: 12px; color: var(--text-secondary); padding: 0 4px; }
.select.short { flex: 0 0 80px; }
.input-number { width: 80px; padding: 8px; border: 1px solid var(--border-color); border-radius: 6px; }
.action-unit { font-weight: 600; color: var(--text-secondary); margin-left: 2px; }
.action-hint { font-size: 12px; color: var(--text-secondary); margin-left: 4px; }
.cbo-hint { font-size: 12px; color: var(--text-secondary); background: #f0f9ff; border-left: 3px solid #0ea5e9; padding: 8px 12px; margin: 0 0 12px 0; border-radius: 0 4px 4px 0; }
.budget-cap-label { font-size: 13px; color: var(--text-secondary); margin-left: 12px; white-space: nowrap; }
.budget-cap-input { width: 120px; }
.placeholder { width: 80px; text-align: center; color: #999; line-height: 36px; }

.btn-icon { width: 36px; height: 36px; border: 1px solid var(--border-color); background: #fff; border-radius: 6px; cursor: pointer; color: #666; }
.btn-icon:hover { background: #f5f5f5; }
.btn-icon.danger { color: var(--danger-color); border-color: #fed7d7; background: #fff5f5; }
.btn-add { width: 100%; border: 1px dashed var(--border-color); background: #fafafa; padding: 8px; border-radius: 6px; color: var(--primary-color); cursor: pointer; font-size: 13px; }
.btn-add:hover { background: #f0f7ff; border-color: var(--primary-color); }

/* 分块布局 */
.section-block {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}
.section-title {
  margin: 0 0 12px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.form-row { display: flex; gap: 16px; }
.execution-time-range { margin-top: 8px; }
.execution-time-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.execution-time-row .label { margin-bottom: 0; min-width: 72px; }
.execution-time-hint { margin: 10px 0 0 0; font-size: 12px; line-height: 1.45; }
.flex-1 { flex: 1; }
.flex-2 { flex: 2; }
.dynamic-scope-row { align-items: center; justify-content: space-between; }
.dynamic-max-wrap { display: flex; align-items: center; gap: 8px; }
.dynamic-max-wrap label { margin: 0; font-size: 13px; color: var(--text-secondary); }

.radio-group { display: flex; gap: 16px; }
.radio-label { display: flex; align-items: center; gap: 6px; font-size: 14px; cursor: pointer; }

.metric-select { width: 140px; }
.window-select { width: 120px; background-color: #f0f9ff; border-color: #bae6fd; color: #0369a1; }
.operator-select { width: 80px; }
.action-select { min-width: 160px; }
.conditions-container { display: flex; flex-direction: column; gap: 6px; }
.when-time-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.when-line-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.join-select { flex: 0 0 60px; }
.join-placeholder { flex: 0 0 60px; display: inline-block; }
.join-label { flex: 0 0 60px; font-size: 13px; color: var(--primary-color); font-weight: 500; }
.scope-condition-block { margin-top: 8px; }
.scope-condition-block.scope-condition-block-disabled {
  opacity: 0.72;
  background: #f9fafb;
  border: 1px dashed #d1d5db;
  border-radius: 8px;
  padding: 10px;
}
.scope-condition-hint { margin-bottom: 8px; }
.scope-condition-disabled-tip {
  margin-bottom: 8px;
  color: #6b7280;
}
.scope-condition-rows .scope-condition-row { flex-wrap: wrap; }
.scope-condition-row .scope-value-input { min-width: 180px; flex: 1; }
.scope-condition-row .scope-value-select { min-width: 160px; }
.scope-row-error { flex: 0 0 100%; width: 100%; margin-top: 4px; margin-left: 68px; font-size: 12px; color: var(--danger-color); }
.link-add-scope { color: var(--primary-color); font-size: 13px; text-decoration: none; }
.link-add-scope:hover { text-decoration: underline; }
.link-add-scope-button {
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
}
.link-add-scope-button:disabled {
  color: #9ca3af;
  cursor: not-allowed;
  text-decoration: none;
}
.scope-apply-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.scope-apply-message { font-size: 12px; color: var(--text-secondary); }
.sync-just-done-hint { font-size: 12px; color: var(--primary-color); margin-top: 6px; }
.input-error { border-color: var(--danger-color) !important; }

.btn-tiny {
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid var(--border-color);
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
  margin-left: 8px;
}
.btn-tiny:hover { background: #f0f0f0; color: var(--primary-color); }

@keyframes pulse-blue {
  0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); }
  70% { box-shadow: 0 0 0 6px rgba(59, 130, 246, 0); }
  100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
}
.btn-sync-highlight {
  animation: pulse-blue 2s infinite;
  background-color: #3b82f6;
  color: white;
  border-color: #2563eb;
}
.btn-sync-highlight:hover { background: #2563eb; color: white; }

.switch-label { margin-left: 8px; font-size: 13px; color: var(--text-secondary); }

.hint { font-size: 12px; color: var(--text-secondary); margin-top: 6px; }
.empty-hint { font-size: 12px; color: var(--text-secondary); margin: 8px 0; }
.loading { font-size: 12px; color: var(--text-secondary); }

.selected-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 0 8px;
}
.tag {
  background: #eef2ff;
  color: var(--primary-color);
  border: 1px solid #dbeafe;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
}
.tag-missing {
  background: #fef3c7;
  color: #92400e;
  border-color: #fcd34d;
}
.tag-invalid {
  background: #e5e7eb;
  color: #6b7280;
  border-color: #d1d5db;
}
.selected-accounts-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.account-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding-right: 4px;
}
.account-tag .tag-remove {
  background: none;
  border: none;
  padding: 0 2px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  color: var(--text-secondary);
}
.account-tag .tag-remove:hover { color: #dc2626; }
.account-add-select { min-width: 180px; }
.scope-item .account-badge {
  font-size: 11px;
  color: var(--text-secondary);
  font-family: ui-monospace, monospace;
}

.scope-list {
  margin-top: 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px;
  background: #fff;
}
.scope-dynamic-summary {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
}
.scope-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.scope-buttons { display: flex; gap: 8px; }
.scope-items {
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.scope-item {
  display: grid;
  grid-template-columns: 18px 1fr auto auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
}
.scope-item:hover { background: #f9fafb; }
.scope-item .name { font-size: 13px; color: var(--text-primary); }
.scope-item .id { font-size: 12px; color: var(--text-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.scope-item-active { border-left: 3px solid #2563eb; }
.scope-item-paused { border-left: 3px solid #9ca3af; }

/* ===== 批量添加账户弹窗 ===== */
.batch-hint {
  font-size: 14px;
  margin-bottom: 12px;
  color: var(--text-secondary);
}
.batch-accounts-grid {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  margin-bottom: 12px;
}
.batch-account-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-color);
  transition: background 0.15s;
}
.batch-account-item:last-child {
  border-bottom: none;
}
.batch-account-item:hover {
  background: #f0f9ff;
}
.batch-account-item.checked {
  background: #eff6ff;
}
.batch-account-checkbox {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-color);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: #fff;
  flex-shrink: 0;
  transition: all 0.15s;
}
.batch-account-checkbox.checked {
  background: var(--primary-color);
  border-color: var(--primary-color);
}
.batch-account-name {
  flex: 1;
  font-size: 14px;
  color: var(--text-primary);
}
.batch-account-id {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: ui-monospace, monospace;
}
.batch-empty {
  padding: 32px;
  text-align: center;
  color: var(--text-secondary);
}
.batch-select-actions {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}
.batch-result {
  margin-top: 16px;
  padding: 14px;
  border-radius: 8px;
  background: #f9fafb;
  border: 1px solid var(--border-color);
}
.batch-result-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 10px;
}
.batch-result-title.ok { color: #059669; }
.batch-result-title.warn { color: #d97706; }
.batch-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 13px;
  color: var(--text-secondary);
}
.batch-stat strong { color: var(--text-primary); }
.batch-stat-ok { color: #059669; }
.batch-stat-err { color: #dc2626; }
.batch-stat-pending {
  color: #d97706;
  font-style: italic;
}
</style>


