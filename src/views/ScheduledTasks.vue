<template>
  <div class="rule-page">
    <!-- 顶部操作栏 + 筛选 -->
    <div class="header-actions">
      <h2>定时任务</h2>
      <div class="actions">
        <select v-model="filterAccountId" class="select" style="max-width:220px;" @change="loadTasks">
          <option value="">全部账户</option>
          <option v-for="acc in accounts" :key="acc.id" :value="acc.id">{{ acc.name || acc.id }}</option>
        </select>
        <select v-model="filterStatus" class="select" style="max-width:120px;" @change="loadTasks">
          <option value="">全部状态</option>
          <option value="enabled">启用</option>
          <option value="disabled">禁用</option>
        </select>
        <select v-model="filterScheduleType" class="select" style="max-width:120px;" @change="loadTasks">
          <option value="">全部类型</option>
          <option value="once">一次性</option>
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
          <option value="interval">按间隔</option>
          <option value="cron">Cron</option>
        </select>
        <!-- 负责人筛选（仅管理员可见） -->
        <div v-if="isAdminFromTasks" ref="ownerDropdownRef" class="owner-filter-wrap">
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
        <button class="btn secondary small" @click="loadTasks">刷新</button>
        <button class="btn" @click="openCreateModal">+ 新建定时任务</button>
      </div>
    </div>

    <!-- 任务列表 Grid 布局 -->
    <div v-if="tasks.length === 0" class="empty-rules">
      <div class="empty-icon">⏰</div>
      <h3>暂无定时任务</h3>
      <p>创建一次性或周期性定时任务，按计划自动执行广告操作。</p>
      <div class="empty-actions">
        <button class="btn" @click="openCreateModal">创建第一个定时任务</button>
      </div>
    </div>

    <div v-else class="rules-grid">
      <div
        v-for="task in tasks"
        :key="task.id"
        class="rule-card"
        :class="{ disabled: !task.enabled }"
      >
        <div class="card-header">
          <div class="card-header-titles">
            <h3 class="rule-name">
              {{ task.taskName ||
                 (task.actionType === 'set_budget' ? '💰 设置预算' :
                  task.actionType === 'increase_budget' ? '📈 上调预算' :
                  task.actionType === 'decrease_budget' ? '📉 下调预算' :
                  task.actionType === 'pause_ad' ? '⏸ 暂停' : '▶️ 启动') }}
              <span class="badge-dnf">{{ scheduleTypeLabel(task.scheduleType) }}</span>
            </h3>
          </div>
          <div class="switch-wrapper">
            <label class="switch">
              <input type="checkbox" :checked="task.enabled" @change="toggleTask(task, $event.target.checked)">
              <span class="slider round"></span>
            </label>
          </div>
        </div>

        <div class="card-body">
          <div class="section">
            <span class="label">账户:</span>
            <span class="account-id">{{ task.accountId }}</span>
          </div>
          <div class="section">
            <span class="label">目标:</span>
            <span class="pill" style="background:#e8f4fd;">{{ task.targetLevel }}</span>
            <span class="muted" style="margin-left:4px;">{{ task.targetId }}</span>
          </div>
          <div class="section">
            <span class="label">动作参数:</span>
            <span class="pill action" :class="getActionClass(task.actionType)">{{ formatActionParams(task) }}</span>
          </div>
          <!-- 动态筛选 -->
          <div v-if="task.useDynamicScope" class="section">
            <span class="label">动态筛选：</span>
            <span class="pill dynamic-on">已开启</span>
            <span class="pill" :class="dynamicScopeStatusClass(task)">{{ dynamicScopeStatusLabel(task) }}</span>
            <span v-if="task.matchedCount != null" class="muted" style="margin-left:6px;">当前生效 {{ task.matchedCount }} 个对象</span>
          </div>
          <div class="section" v-if="isAdminFromTasks">
            <span class="label">负责人:</span>
            <span class="owner-name">{{ task.ownerName || '未分配' }}</span>
          </div>
          <div class="section execution-meta">
            <span class="label">调度:</span>
            <span class="muted">{{ scheduleTypeLabel(task.scheduleType) }} · {{ task.scheduleAt || task.scheduleCron || '-' }}</span>
          </div>
          <div class="section execution-meta">
            <span class="label">下次执行:</span>
            <span class="muted">{{ formatTime(task.nextExecuteAt) }}</span>
            <span v-if="task.lastExecutedAt" style="margin-left:12px;">
              <span class="label">上次执行:</span>
              <span class="muted">{{ formatTime(task.lastExecutedAt) }}</span>
              <span v-if="task.lastStatus" class="pill" :class="task.lastStatus === 'success' ? 'dynamic-on' : task.lastStatus === 'fail' ? 'dynamic-off' : ''" style="margin-left:4px;">{{ task.lastStatus }}</span>
            </span>
          </div>
          <div v-if="task.isSimulation" class="hint" style="margin-top:8px;">🧪 Dry Run 仅模拟</div>
          <div v-if="countExcluded(task) > 0" class="hint" style="margin-top:4px;color:#b45309;">⊘ 排除 {{ countExcluded(task) }} 个对象</div>
        </div>

        <div class="card-footer">
          <button class="btn-text" @click="executeTask(task)" :disabled="runningTaskId === task.id">
            {{ runningTaskId === task.id ? '执行中...' : '立即执行' }}
          </button>
          <button class="btn-text" @click="openEditModal(task)">编辑</button>
          <button class="btn-text danger" @click="deleteTask(task)">删除</button>
        </div>
      </div>
    </div>

    <!-- 创建/编辑模态框 -->
    <div v-if="showModal" class="modal-overlay" @click="showModal = false">
      <div class="modal-content wide" @click.stop>
        <div class="modal-header">
          <h3>{{ editingTaskId ? '编辑定时任务' : '新建定时任务' }}</h3>
          <button class="close-btn" @click="showModal = false">×</button>
        </div>

        <div class="modal-body">
          <!-- 区块1：基本信息 -->
          <div class="section-block">
            <h4 class="section-title">1. 基本信息</h4>
            <div class="form-row">
              <div class="form-group flex-2">
                <label>任务名称</label>
                <input v-model="form.task_name" placeholder="例如：凌晨关停亏损广告" class="input-text" />
              </div>
              <div class="form-group flex-1">
                <label>调度类型</label>
                <select v-model="form.schedule_type" class="select" @change="onScheduleTypeChange">
                  <option value="once">一次性</option>
                  <option value="daily">每天</option>
                  <option value="weekly">每周</option>
                  <option value="interval">按间隔重复</option>
                  <option value="cron">Cron</option>
                </select>
              </div>
              <div class="form-group flex-1">
                <label>时区</label>
                <select v-model="form.schedule_timezone" class="select">
                  <option value="">跟随账户时区</option>
                  <option v-for="tz in commonTimezones" :key="tz" :value="tz">{{ tz }}</option>
                </select>
              </div>
            </div>

            <div class="form-group" v-if="form.schedule_type === 'once'">
              <label>执行日期</label>
              <div class="form-row" style="gap:8px;">
                <input type="date" v-model="form.schedule_date" class="input-text" style="max-width:180px;" />
                <input type="time" v-model="form.schedule_time" class="input-text" style="max-width:120px;" step="60" />
              </div>
            </div>
            <div class="form-group" v-if="['weekly'].includes(form.schedule_type)">
              <label>执行星期</label>
              <div class="weekday-picker">
                <label v-for="(day, idx) in weekDays" :key="idx" class="radio-label">
                  <input type="checkbox" :value="idx + 1" v-model="form.week_days"> {{ day }}
                </label>
              </div>
            </div>
            <div class="form-group" v-if="['daily', 'weekly'].includes(form.schedule_type)">
              <label>执行时间</label>
              <input type="time" v-model="form.schedule_time" class="input-text" style="max-width:160px;" step="60" />
            </div>
            <div class="form-group" v-if="form.schedule_type === 'interval'">
              <label>执行间隔</label>
              <div class="form-row" style="gap:6px;align-items:center;">
                <label style="font-weight:400;white-space:nowrap;">每</label>
                <input v-model.number="form.interval_hours" type="number" class="input-text" style="max-width:70px;" min="0" max="23" placeholder="0" />
                <label style="font-weight:400;white-space:nowrap;">小时</label>
                <input v-model.number="form.interval_minutes" type="number" class="input-text" style="max-width:70px;" min="1" max="59" placeholder="15" />
                <label style="font-weight:400;white-space:nowrap;">分钟</label>
              </div>
              <div class="hint" style="margin-top:4px;">最小间隔 1 分钟，设置后将按此间隔循环重复执行</div>
            </div>
            <div class="form-group" v-if="form.schedule_type === 'cron'">
              <label>Cron 表达式</label>
              <input v-model="form.schedule_cron" class="input-text" placeholder="例如：*/15 * * * *（每15分钟）" />
              <div class="hint" style="margin-top:4px;">支持标准 5 位 cron 表达式</div>
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
                  <option v-for="a in accountsFilteredForAdd" :key="a.id" :value="a.id">{{ a.name }} ({{ a.id }})</option>
                </select>
                <button class="btn secondary" @click="loadAccounts" :disabled="accountLoading">{{ accountLoading ? '加载中...' : '刷新账户' }}</button>
                <button class="btn secondary" @click="selectAllAccounts" :disabled="accountLoading || !accounts.length">全选</button>
                <button class="btn secondary" @click="clearAllAccounts" :disabled="!selectedAccountIds.length">清空</button>
              </div>
              <div v-if="selectedAccountIds.length" class="selected-accounts-tags">
                <span v-for="aid in selectedAccountIds" :key="aid" class="tag account-tag">{{ accountLabel(aid) }}<button type="button" class="tag-remove" @click="removeAccount(aid)">×</button></span>
              </div>
              <div class="hint">仅展示你有权限的账户；多选后下方列表为多账户合并结果</div>
            </div>
            <div class="form-group">
              <label>目标层级</label>
              <div class="radio-group">
                <label v-for="opt in levelOptions" :key="opt.value" class="radio-label"><input type="radio" v-model="form.target_level" :value="opt.value" @change="onTargetLevelChange"> {{ opt.label }}</label>
              </div>
            </div>

            <!-- 动态筛选 -->
            <div class="form-group">
              <label>动态筛选</label>
              <div class="form-row dynamic-scope-row">
                <div class="switch-wrapper">
                  <label class="switch"><input type="checkbox" v-model="form.use_dynamic_scope"><span class="slider round"></span></label>
                  <span class="switch-label">{{ form.use_dynamic_scope ? '开启（按监控范围自动更新目标）' : '关闭（仅使用手动勾选目标）' }}</span>
                </div>
                <div class="dynamic-max-wrap" v-if="form.use_dynamic_scope">
                  <label>动态匹配上限</label>
                  <input v-model.number="form.max_dynamic_matches" type="number" min="1" max="5000" class="input-number" />
                </div>
              </div>
            </div>

            <!-- 监控范围条件 -->
            <div class="form-group scope-condition-block" :class="{ 'scope-condition-block-disabled': !form.use_dynamic_scope }">
              <label>监控范围条件（可选）</label>
              <div class="hint">根据下方条件自动勾选匹配的对象；不填则需手动勾选。</div>
              <div v-if="!form.use_dynamic_scope" class="hint" style="color:#b45309;">未开启动态筛选时，监控范围条件不生效。请开启动态筛选或手动勾选目标对象。</div>
              <div class="conditions-container scope-condition-rows">
                <div v-for="(row, idx) in scopeConditionRows" :key="row.id" class="condition-row scope-condition-row">
                  <span v-if="idx > 0" class="join-label">AND</span>
                  <span v-else class="join-placeholder"></span>
                  <select v-model="row.field" class="select scope-field-select" :disabled="!form.use_dynamic_scope" @change="onScopeConditionFieldChange(row)">
                    <option value="name">名称</option>
                    <option value="status">状态</option>
                    <option value="created_within">创建时间段</option>
                  </select>
                  <select v-model="row.operator" class="select scope-operator-select" :disabled="!form.use_dynamic_scope || row.field === 'created_within'">
                    <template v-if="row.field === 'name'"><option value="include">包含</option><option value="exclude">不包含</option></template>
                    <template v-else-if="row.field === 'created_within'"><option value="include">包含</option></template>
                    <template v-else><option value="equals">等于</option><option value="not_equals">不等于</option></template>
                  </select>
                  <template v-if="row.field === 'name'">
                    <input v-model.trim="row.value" type="text" class="input-text scope-value-input" placeholder="请输入名称" :disabled="!form.use_dynamic_scope" :class="{ 'input-error': form.use_dynamic_scope && scopeConditionRowError(row) }" />
                  </template>
                  <template v-else-if="row.field === 'created_within'">
                    <select v-model="row.value" class="select scope-value-select" :disabled="!form.use_dynamic_scope"><option value="">请选择</option><option value="24">近 24 小时内</option><option value="48">近 48 小时内</option><option value="72">近 72 小时内</option><option value="custom">自定义小时内</option><option value="older_than">超过 XX 小时</option><option value="between">介于 XX~YY 小时之间</option></select>
                    <input v-if="row.value === 'custom'" v-model.number="row.customHours" type="number" min="1" max="720" class="input-text scope-value-input" placeholder="小时数 1-720" :disabled="!form.use_dynamic_scope" />
                    <input v-if="row.value === 'older_than'" v-model.number="row.olderThanHours" type="number" min="1" max="720" class="input-text scope-value-input" placeholder="小时数 1-720" :disabled="!form.use_dynamic_scope" />
                    <span v-if="row.value === 'between'" class="scope-between-group">
                      <input v-model.number="row.betweenFromHours" type="number" min="1" max="720" class="input-text scope-between-input" placeholder="超过 (小时)" :disabled="!form.use_dynamic_scope" />
                      <span class="scope-between-sep">—</span>
                      <input v-model.number="row.betweenToHours" type="number" min="1" max="720" class="input-text scope-between-input" placeholder="以内 (小时)" :disabled="!form.use_dynamic_scope" />
                    </span>
                  </template>
                  <template v-else>
                    <select v-model="row.value" class="select scope-value-select" :disabled="!form.use_dynamic_scope"><option value="">请选择</option><option value="active_only">所有投放中</option><option value="paused_only">所有已暂停</option><option value="active_and_paused">所有投放中和已暂停</option></select>
                  </template>
                  <button v-if="scopeConditionRows.length > 1" type="button" class="btn-icon danger" :disabled="!form.use_dynamic_scope" @click="removeScopeConditionRow(idx)">×</button>
                </div>
                <button v-if="scopeConditionRows.length < SCOPE_CONDITION_MAX_ROWS" type="button" class="link-add-scope" :disabled="!form.use_dynamic_scope" @click="addScopeConditionRow">添加监控范围 ({{ scopeConditionRows.length }}/{{ SCOPE_CONDITION_MAX_ROWS }})</button>
                <span v-else class="hint">已达 {{ SCOPE_CONDITION_MAX_ROWS }} 条上限</span>
                <div v-if="scopeApplyMessage" class="scope-apply-row">
                  <span class="scope-apply-message">{{ scopeApplyMessage }}</span>
                </div>
              </div>
            </div>

            <!-- 选择目标对象 -->
            <div class="form-group">
              <label>选择目标对象</label>
              <div v-if="!form.use_dynamic_scope" class="scope-filters"><input v-model="scopeSearch" class="input-text" placeholder="搜索名称或ID" /></div>
              <div v-if="!selectedAccountIds.length" class="empty-hint">请先选择至少一个广告账户</div>
              <template v-else>
                <div v-if="form.use_dynamic_scope" class="scope-list"><div class="scope-dynamic-summary">当前匹配 {{ form.matchedCount ?? 0 }} 个对象（按监控条件实时计算，无需选择目标）</div></div>
                <div v-else class="scope-list">
                  <div class="scope-actions">
                    <span>已选 {{ form.target_ids.length }} 个</span>
                    <div class="scope-buttons">
                      <button class="btn-tiny" @click="selectAllScope" :disabled="!filteredScopeItems.length">全选</button>
                      <button class="btn-tiny" @click="clearScopeSelection" :disabled="!form.target_ids.length">清空</button>
                    </div>
                  </div>
                  <div v-if="form.target_ids.length" class="selected-preview">
                    <span v-for="id in form.target_ids.slice(0, 10)" :key="id" class="tag">
                      {{ resolvedNameForId(id) }}
                      <button type="button" class="tag-remove" @click="removeTargetId(id)">×</button>
                    </span>
                    <span v-if="form.target_ids.length > 10" class="muted">还有 {{ form.target_ids.length - 10 }} 个</span>
                  </div>
                  <div v-if="scopeLoading" class="loading">正在加载列表...</div>
                  <div v-else-if="!filteredScopeItems.length" class="empty-hint">暂无可选对象</div>
                  <div v-else class="scope-items">
                    <label v-for="item in filteredScopeItems" :key="scopeItemKey(item)" class="scope-item" :class="{ 'scope-item-active': item.effective_status === 'ACTIVE', 'scope-item-paused': item.effective_status === 'PAUSED' }">
                      <input type="checkbox" :value="scopeItemValue(item)" v-model="form.target_ids" />
                      <span class="name">{{ item.name || '-' }}</span><span class="id">{{ item.id }}</span>
                      <span v-if="selectedAccountIds.length > 1" class="account-badge">{{ item.account_id || '' }}</span>
                    </label>
                  </div>
                  <div v-if="scopePagingAfter" class="scope-more"><button class="btn-tiny" @click="loadMoreScopeItems" :disabled="scopeLoading">{{ scopeLoading ? '加载中...' : '加载更多' }}</button></div>
                </div>
              </template>
            </div>

            <!-- 排除名单 -->
            <div class="form-group">
              <label>排除名单（可选）</label>
              <div class="hint">排除的对象不会被执行操作（公式：最终 = 动态/手动 - 排除）</div>
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
                  <span>已排除 {{ form.excludeTargetIds.length }} 个</span>
                  <div class="scope-buttons">
                    <button class="btn-tiny" @click="selectAllExcludeScope" :disabled="!canSelectAllExclude">全选</button>
                    <button class="btn-tiny" @click="clearExcludeScopeSelection" :disabled="!form.excludeTargetIds.length">清空</button>
                  </div>
                </div>
                <div v-if="excludeScopeLoading" class="loading">正在加载列表...</div>
                <div v-else-if="!filteredExcludeScopeItems.length" class="empty-hint">暂无可选对象（输入搜索词加载）</div>
                <div v-else class="scope-items">
                  <label v-for="item in filteredExcludeScopeItems" :key="'exclude-' + scopeItemKey(item)" class="scope-item" :class="{ 'scope-item-active': item.effective_status === 'ACTIVE', 'scope-item-paused': item.effective_status === 'PAUSED' }">
                    <input type="checkbox" :value="scopeItemValue(item)" v-model="form.excludeTargetIds">
                    <span class="name">{{ item.name || '-' }}</span>
                    <span class="id">{{ item.id }}</span>
                    <span v-if="selectedAccountIds.length > 1" class="account-badge">{{ item.account_id || '' }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- 区块3：执行动作 -->
          <div class="section-block">
            <h4 class="section-title">3. 执行动作 (Action)</h4>
            <div class="form-row">
              <div class="form-group flex-1">
                <label>动作类型</label>
                <select v-model="form.action_type" class="select" @change="onActionTypeChange">
                  <option value="">请选择动作</option>
                  <option value="pause_ad">⏸ 暂停目标</option>
                  <option value="activate_ad">▶️ 启用目标</option>
                  <option value="increase_budget">💰 增加预算</option>
                  <option value="decrease_budget">💸 减少预算</option>
                  <option value="set_budget">📌 设置预算为固定值</option>
                </select>
              </div>
            </div>

            <!-- 暂停/启用无需参数 -->
            <div v-if="['pause_ad', 'activate_ad'].includes(form.action_type)" class="hint" style="margin-top:8px;">
              {{ form.action_type === 'pause_ad' ? '⏸ 将在指定时间暂停目标对象' : '▶️ 将在指定时间启用目标对象' }}
            </div>

            <!-- 预算类动作参数 -->
            <div v-if="['set_budget', 'increase_budget', 'decrease_budget'].includes(form.action_type)">
              <div class="form-row" style="margin-top:12px;">
                <div class="form-group flex-1">
                  <label>{{ form.action_type === 'set_budget' ? '目标预算' : '调整量' }}</label>
                  <div class="form-row" style="gap:6px;align-items:center;">
                    <input
                      v-model.number="form.budget_value"
                      type="number"
                      class="input-text"
                      :placeholder="form.action_type === 'set_budget' ? '30' : '10'"
                      step="0.01"
                      min="0.01"
                      style="max-width:140px;"
                    />
                    <select v-if="form.action_type !== 'set_budget'" v-model="form.budget_unit" class="select" style="max-width:80px;">
                      <option value="percent">%</option>
                      <option value="usd">$</option>
                    </select>
                    <span class="action-hint">
                      {{ form.action_type === 'set_budget' ? '（设置为固定美元值）' : ((form.budget_unit || 'percent') === 'usd' ? '（按美元增减）' : '（按百分比增减）') }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- 预算上限（增加预算时） -->
              <div class="form-row" v-if="form.action_type === 'increase_budget'">
                <div class="form-group flex-1">
                  <label>预算上限（美元，可选）</label>
                  <input
                    v-model.number="form.max_daily_budget"
                    type="number"
                    class="input-text"
                    placeholder="不填则不限制"
                    step="0.01"
                    min="1"
                    style="max-width:180px;"
                  />
                </div>
              </div>

              <!-- 预算下限（减少预算时） -->
              <div class="form-row" v-if="form.action_type === 'decrease_budget'">
                <div class="form-group flex-1">
                  <label>预算下限（美元，可选）</label>
                  <input
                    v-model.number="form.min_daily_budget"
                    type="number"
                    class="input-text"
                    placeholder="不填则不限制"
                    step="0.01"
                    min="1"
                    style="max-width:180px;"
                  />
                </div>
              </div>
            </div>
          </div>

          <!-- 区块4：选项 -->
          <div class="section-block">
            <h4 class="section-title">4. 选项</h4>
            <div class="form-row">
              <div class="form-group flex-1">
                <label>模拟运行 (Dry Run)</label>
                <div class="switch-wrapper">
                  <label class="switch">
                    <input type="checkbox" v-model="form.is_simulation">
                    <span class="slider round"></span>
                  </label>
                  <span class="switch-label">{{ form.is_simulation ? '🧪 仅模拟日志' : '⚡ 真实执行' }}</span>
                </div>
              </div>
              <div class="form-group flex-1" v-if="form.schedule_type === 'once'">
                <label>执行后自动禁用</label>
                <div class="switch-wrapper">
                  <label class="switch">
                    <input type="checkbox" v-model="form.auto_disable">
                    <span class="slider round"></span>
                  </label>
                  <span class="switch-label">{{ form.auto_disable ? '✅ 自动禁用' : '⚠️ 保持启用' }}</span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="computedNextTime" class="hint" style="margin-top:12px;text-align:center;">
            📅 预计下次执行时间: <strong>{{ computedNextTime }}</strong>
          </div>

          <div v-if="formError" class="alert error">{{ formError }}</div>
        </div>

        <div class="modal-footer">
          <button class="btn secondary" @click="showModal = false">取消</button>
          <button class="btn" @click="saveTask" :disabled="saving">
            {{ saving ? '保存中...' : (editingTaskId ? '保存' : '创建') }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="toastMsg" class="toast" :class="toastType">{{ toastMsg }}</div>
  </div>
</template>

<script>
import api from '../services/facebookApi.js'
import { authFetch } from '../utils/authFetch.js'

export default {
  name: 'ScheduledTasks',
  data() {
    return {
      tasks: [],
      accounts: [],
      accountLoading: false,
      // 多账户选择
      selectedAccountIds: [],
      accountToAdd: '',
      // 筛选
      filterAccountId: '',
      filterStatus: '',
      filterScheduleType: '',
      // 负责人筛选（仅管理员）
      isAdminFromTasks: false,
      ownersList: [],
      selectedOwnerIds: [],
      includeNoOwner: false,
      ownerFilterOpen: false,
      // modal
      showModal: false,
      editingTaskId: null,
      saving: false,
      runningTaskId: null,
      formError: '',
      toastMsg: '',
      toastType: 'info',
      // scope 列表
      scopeSearch: '',
      scopeLoading: false,
      scopeReady: false,
      scopeRequestId: 0,
      scopeItems: [],
      scopePagingAfter: null,
      // 排除名单
      excludeScopeSearch: '',
      excludeScopeLoading: false,
      excludeRequestId: 0,
      excludeScopeItems: [],
      // 条件应用反馈
      scopeApplyMessage: '',
      form: this.getEmptyForm(),
      // 监控范围条件
      SCOPE_CONDITION_MAX_ROWS: 3,
      scopeConditionRows: [],
      weekDays: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
      commonTimezones: [
        'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Kolkata',
        'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Chicago',
        'America/Los_Angeles', 'America/Sao_Paulo', 'UTC'
      ],
      levelOptions: [
        { value: 'ad', label: '广告 (Ad)' },
        { value: 'adset', label: '广告组 (Adset)' },
        { value: 'campaign', label: '广告系列 (Campaign)' }
      ]
    }
  },
  computed: {
    computedNextTime() {
      if (!this.form.schedule_type) return ''
      const at = this.buildScheduleAt()
      if (!at) return ''
      try {
        if (this.form.schedule_type === 'once') return at
        if (this.form.schedule_type === 'daily') return '每天 ' + at
        if (this.form.schedule_type === 'weekly') {
          const [days] = at.split('|')
          const map = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' }
          const labels = (days || '').split(',').map(d => '周' + map[Number(d)]).join('、')
          return '每' + labels + ' ' + (at.split('|')[1] || '')
        }
        if (this.form.schedule_type === 'interval') {
          return '每间隔 ' + at + ' 重复'
        }
        if (this.form.schedule_type === 'cron') {
          return 'Cron: ' + this.form.schedule_cron
        }
      } catch {}
      return at
    },
    accountsFilteredForAdd() {
      const set = new Set(this.selectedAccountIds)
      return this.accounts.filter(a => !set.has(a.id))
    },
    filteredScopeItems() {
      const key = String(this.scopeSearch || '').trim().toLowerCase()
      const targetLevel = this.form.target_level || 'ad'
      const list = !key
        ? this.scopeItems
        : this.scopeItems.filter(item =>
            String(item.name || '').toLowerCase().includes(key) ||
            String(item.id || '').toLowerCase().includes(key)
          )
      // 过滤：只显示当前目标层级内的对象（resolveObjectsByIds 可能返回跨层级结果，item.type 为 campaign/adset/ad）
      const levelFiltered = list.filter(item => {
        if (!item.type) return true  // 来自 getStructureObjects 的结果没有 type 字段，已是正确层级
        return item.type === targetLevel
      })
      return [...levelFiltered].sort((a, b) => {
        const order = (x) => (x.effective_status === 'ACTIVE' ? 0 : 1)
        return order(a) - order(b)
      })
    },
    resolvedName() {
      if (!this.form.target_ids.length) return ''
      const raw = String(this.form.target_ids[0])
      const idPart = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw
      const f = this.scopeItems.find(i => i.id === idPart)
      return f ? (f.name || idPart) : idPart
    },
    filteredExcludeScopeItems() {
      const keyword = String(this.excludeScopeSearch || '').trim().toLowerCase()
      const targetLevel = this.form.target_level || 'ad'
      const list = this.scopeItems  // 始终用已加载的主列表做客户端过滤，支持名称和ID搜索
      // 过滤：只显示当前目标层级内的对象
      const levelFiltered = list.filter(item => {
        if (!item.type) return true
        return item.type === targetLevel
      })
      if (!keyword) return levelFiltered
      return levelFiltered.filter(item =>
        String(item.name || '').toLowerCase().includes(keyword) ||
        String(item.id || '').toLowerCase().includes(keyword)
      )
    },
    canSelectAllExclude() {
      return this.filteredExcludeScopeItems.length > 0
    },
    ownerFilterDisplayValue() {
      const parts = []
      if (this.selectedOwnerIds.length > 0) {
        const names = this.ownersList
          .filter(o => this.selectedOwnerIds.includes(o.id))
          .map(o => o.owner_name || o.ownerName || String(o.id))
        if (names.length > 0) parts.push(names.join(', '))
      }
      if (this.includeNoOwner) parts.push('管理员创建')
      return parts.length > 0 ? parts.join(' + ') : '全部 (不选=全部)'
    }
  },
  async mounted() {
    await Promise.all([this.loadAccounts(), this.loadTasks()])
  },
  watch: {
    selectedAccountIds(val) {
      if (!val?.length) {
        // 账户清空 → 清空所有选择
        this.scopeItems = []
        this.excludeScopeItems = []
        this.scopeReady = false
        this.scopePagingAfter = null
        if (!this.editingTaskId) this.form.target_ids = []
        if (!this.editingTaskId) this.form.excludeTargetIds = []
        return
      }
      // 账户变更（新增/移除）→ 清空旧选择后重新加载对象列表（对齐规则管理页行为，避免单账户裸ID与多账户复合ID混用）
      this.scopeItems = []
      this.excludeScopeItems = []
      this.scopeReady = false
      this.scopePagingAfter = null
      if (!this.editingTaskId) this.form.target_ids = []
      if (!this.editingTaskId) this.form.excludeTargetIds = []
      this.refreshScopeItems()
    },
    scopeSearch() {
      // 输入搜索词时重新从后端获取（含ID搜索检测），防抖300ms
      if (!this.selectedAccountIds?.length) return
      clearTimeout(this._scopeSearchTimer)
      this._scopeSearchTimer = setTimeout(() => {
        this.scopeItems = []
        this.scopeReady = false
        this.scopePagingAfter = null
        this.refreshScopeItems()
      }, 300)
    },
    // 排除区搜索：纯客户端过滤，filteredExcludeScopeItems 已同时匹配名称和ID
    excludeScopeSearch() {
      // 无操作：computed 属性自动响应 excludeScopeSearch 变化
    },
    // 开启动态筛选时，防抖查询 matchedCount
    'form.use_dynamic_scope'(val) {
      if (!val) { this.form.matchedCount = null; return }
      this._triggerMatchedCountPreview()
    },
    // 切换目标层级时重新计算匹配数
    'form.target_level'() {
      if (this.form.use_dynamic_scope) this._triggerMatchedCountPreview()
    },
    scopeConditionRows: {
      deep: true,
      handler() {
        if (this.form.use_dynamic_scope) this._triggerMatchedCountPreview()
      }
    }
  },
  methods: {
    /** 多选时用 account_id:id 作为唯一键与表单值；单选时用 id（对齐规则管理页逻辑） */
    scopeItemKey(item) {
      const key = this.selectedAccountIds.length > 1 ? `${item.account_id || ''}:${item.id}` : item.id
      return key
    },
    scopeItemValue(item) {
      return this.selectedAccountIds.length > 1 ? `${item.account_id || ''}:${item.id}` : item.id
    },
    getEmptyForm() {
      return {
        schedule_type: 'once',
        schedule_date: new Date().toISOString().slice(0, 10),
        schedule_time: '08:00',
        week_days: [],
        schedule_cron: '',
        interval_hours: 0,
        interval_minutes: 15,
        schedule_timezone: '',
        task_name: '',
        target_level: 'ad',
        target_id: '',
        target_ids: [],
        action_type: '',
        budget_value: null,
        budget_unit: 'percent',
        max_daily_budget: null,
        min_daily_budget: null,
        is_simulation: false,
        auto_disable: true,
        use_dynamic_scope: false,
        max_dynamic_matches: 5000,
        matchedCount: null,
        excludeTargetIds: []
      }
    },

    async loadAccounts() {
      this.accountLoading = true
      try {
        this.accounts = await api.getAdAccounts() || []
      } catch (e) {
        this.showToast('加载账户失败: ' + e.message, 'error')
      } finally { this.accountLoading = false }
    },

    async loadTasks() {
      try {
        const p = { limit: 200 }
        if (this.filterAccountId) p.account_id = this.filterAccountId
        if (this.filterStatus) p.status = this.filterStatus
        if (this.filterScheduleType) p.schedule_type = this.filterScheduleType
        if (this.isAdminFromTasks) {
          if (this.selectedOwnerIds.length > 0) {
            const ids = this.selectedOwnerIds.map(id => Number(id)).filter(Number.isFinite)
            if (ids.length > 0) p.ownerIds = ids.join(',')
          }
          if (this.includeNoOwner) p.includeNoOwner = '1'
        }
        const r = await api.getScheduledTasks(p)
        this.tasks = r.items || []
        this.isAdminFromTasks = r.isAdmin === true
        if (r.isAdmin && this.ownersList.length === 0) {
          try {
            const oResp = await authFetch('/api/owners')
            const oData = await oResp.json()
            this.ownersList = oData.owners || []
          } catch { this.ownersList = [] }
        }
      } catch (e) {
        this.showToast('加载列表失败: ' + e.message, 'error')
      }
    },

    /** 负责人筛选：清除已选并重新加载 */
    clearOwnerFilter() {
      this.selectedOwnerIds = []
      this.includeNoOwner = false
      this.ownerFilterOpen = false
      this.loadTasks()
    },

    /** 负责人筛选：切换某一负责人的选中状态 */
    toggleOwnerOption(id) {
      const idx = this.selectedOwnerIds.indexOf(id)
      if (idx >= 0) {
        this.selectedOwnerIds = this.selectedOwnerIds.filter((_, i) => i !== idx)
      } else {
        this.selectedOwnerIds = [...this.selectedOwnerIds, id]
      }
      this.loadTasks()
    },

    /** 负责人筛选：切换"管理员创建" */
    toggleNoOwnerOption() {
      this.includeNoOwner = !this.includeNoOwner
      this.loadTasks()
    },

    // ---- 账户多选 ----
    onAddAccount(e) {
      const v = e?.target?.value
      if (!v) return
      if (!this.selectedAccountIds.includes(v)) this.selectedAccountIds = [...this.selectedAccountIds, v]
      this.accountToAdd = ''
    },
    removeAccount(aid) {
      this.selectedAccountIds = this.selectedAccountIds.filter(id => id !== aid)
    },
    selectAllAccounts() {
      this.selectedAccountIds = this.accounts.map(a => a.id)
    },
    clearAllAccounts() {
      this.selectedAccountIds = []
    },
    accountLabel(aid) {
      const a = this.accounts.find(x => x.id === aid)
      return a ? `${a.name} (${aid})` : aid
    },

    // ---- 作用对象列表加载 ----
    resolveScopeTimeFilters() {
      const completed = this.scopeConditionRows.filter(row => !this.scopeConditionRowError(row))
      const createdRows = completed.filter(r => r.field === 'created_within')
      const hoursList = createdRows.map(r => {
        if (r.value === '24' || r.value === '48' || r.value === '72') return parseInt(r.value, 10)
        if (r.value === 'custom' && r.customHours != null && Number.isFinite(r.customHours) && r.customHours >= 1 && r.customHours <= 720) return r.customHours
        return null
      }).filter(h => Number.isFinite(h) && h > 0)
      const withinHours = hoursList.length ? Math.min(...hoursList) : null
      const olderThanRow = completed.find(r => r.field === 'created_within' && r.value === 'older_than')
      const olderThanHours = olderThanRow ? Number(olderThanRow.olderThanHours) : null
      const beforeHours = Number.isFinite(olderThanHours) && olderThanHours >= 1 && olderThanHours <= 720 ? olderThanHours : null
      const betweenRow = completed.find(r => r.field === 'created_within' && r.value === 'between')
      const betweenFrom = betweenRow ? Number(betweenRow.betweenFromHours) : null
      const betweenTo = betweenRow ? Number(betweenRow.betweenToHours) : null
      const betweenValid = Number.isFinite(betweenFrom) && Number.isFinite(betweenTo) && betweenFrom >= 1 && betweenTo <= 720 && betweenFrom < betweenTo
      return {
        scope_created_within_hours: withinHours ?? undefined,
        scope_created_before_hours: beforeHours ?? undefined,
        scope_created_between_from_hours: betweenValid ? betweenFrom : undefined,
        scope_created_between_to_hours: betweenValid ? betweenTo : undefined
      }
    },
    async refreshScopeItems() {
      if (!this.selectedAccountIds?.length) return
      this.scopeLoading = true
      this.scopeReady = false
      const requestId = ++this.scopeRequestId
      const ids = this.selectedAccountIds
      const level = this.form.target_level || 'ad'
      const levelKey = level === 'campaign' ? 'campaigns' : (level === 'adset' ? 'adsets' : 'ads')
      const keyword = String(this.scopeSearch || '').trim()
      const isIdSearch = /^\d{10,}$/.test(keyword)  // 检测是否为纯数字ID搜索
      const limit = keyword ? 50 : 500
      const tf = this.resolveScopeTimeFilters()
      try {
        if (ids.length === 1) {
          const singleAccountId = ids[0]
          const promises = [
            api.getStructureObjects(levelKey, singleAccountId, { q: keyword, limit, after: null, include_paused: true, ...tf })
          ]
          if (isIdSearch) promises.push(api.resolveObjectsByIds(keyword).catch(() => []))
          const results = await Promise.all(promises)
          if (requestId !== this.scopeRequestId) return
          let items = results[0]?.items || []
          // 单账户 API 返回的 item 不含 account_id，统一补上（对齐多账户 API 行为）
          items = items.map(it => ({ ...it, account_id: it.account_id || singleAccountId }))
          if (isIdSearch && results[1]?.length > 0) {
            const existingIds = new Set(items.map(it => String(it.id)))
            for (const item of results[1]) {
              // 只合并当前目标层级内的对象，避免选了广告组却搜到广告/广告系列
              if (!existingIds.has(String(item.id)) && item.type === level) items.push({ ...item, account_id: item.account_id || singleAccountId })
            }
          }
          this.scopeItems = items
          this.scopePagingAfter = keyword ? null : (results[0]?.paging?.after ?? null)
        } else {
          const promises = [
            api.getStructureObjectsMulti(level, ids, { q: keyword, limit, after: null, include_paused: true, ...tf })
          ]
          if (isIdSearch) promises.push(api.resolveObjectsByIds(keyword).catch(() => []))
          const results = await Promise.all(promises)
          if (requestId !== this.scopeRequestId) return
          let items = results[0]?.items || []
          if (isIdSearch && results[1]?.length > 0) {
            const existingIds = new Set(items.map(it => String(it.id)))
            // 多账户模式下 resolve 返回的 item 不含 account_id，合并时需补上
            // 优先从已有 items 中查找 account_id，找不到则跳过（避免污染 :id 格式）
            const accountMap = new Map()
            for (const it of items) {
              if (it.account_id && it.id) accountMap.set(String(it.id), it.account_id)
            }
            for (const item of results[1]) {
              const itemId = String(item.id)
              // 只合并当前目标层级内的对象，避免选了广告组却搜到广告/广告系列
              if (!existingIds.has(itemId) && item.type === level) {
                const acc = item.account_id || accountMap.get(itemId)
                items.push({ ...item, account_id: acc || ids[0] })
              }
            }
          }
          this.scopeItems = items
          this.scopePagingAfter = keyword ? null : (results[0]?.paging?.after ?? null)
        }
        this.scopeReady = true
      } catch (e) {
        if (requestId !== this.scopeRequestId) return
        this.scopeItems = []
        this.scopePagingAfter = null
        this.showToast('加载列表失败: ' + e.message, 'error')
      } finally {
        if (requestId === this.scopeRequestId) this.scopeLoading = false
      }
    },

    async loadMoreScopeItems() {
      if (!this.selectedAccountIds?.length || !this.scopePagingAfter) return
      const ids = this.selectedAccountIds
      const level = this.form.target_level || 'ad'
      const levelKey = level === 'campaign' ? 'campaigns' : (level === 'adset' ? 'adsets' : 'ads')
      this.scopeLoading = true
      const requestId = ++this.scopeRequestId
      const tf = this.resolveScopeTimeFilters()
      try {
        if (ids.length === 1) {
          const singleAccountId = ids[0]
          const resp = await api.getStructureObjects(levelKey, singleAccountId, { q: String(this.scopeSearch || '').trim(), limit: 500, after: this.scopePagingAfter, include_paused: true, ...tf })
          if (requestId !== this.scopeRequestId) return
          const newItems = (resp.items || []).map(it => ({ ...it, account_id: it.account_id || singleAccountId }))
          this.scopeItems = [...this.scopeItems, ...newItems]
          this.scopePagingAfter = resp?.paging?.after || null
        } else {
          const result = await api.getStructureObjectsMulti(level, ids, { q: String(this.scopeSearch || '').trim(), limit: 500, after: this.scopePagingAfter, include_paused: true, ...tf })
          if (requestId !== this.scopeRequestId) return
          this.scopeItems = [...this.scopeItems, ...(result.items || [])]
          this.scopePagingAfter = result.paging?.after || null
        }
        this.scopeReady = true
      } catch (e) {
        if (requestId === this.scopeRequestId) this.showToast('加载更多失败: ' + e.message, 'error')
      } finally {
        if (requestId === this.scopeRequestId) this.scopeLoading = false
      }
    },

    clearScopeSelection() {
      this.form.target_ids = []
    },
    selectAllScope() {
      this.form.target_ids = this.filteredScopeItems.map(item => this.scopeItemKey(item))
    },
    removeTargetId(id) {
      this.form.target_ids = this.form.target_ids.filter(t => t !== id)
    },
    resolvedNameForId(rawId) {
      const raw = String(rawId || '')
      const idPart = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw
      const f = this.scopeItems.find(i => i.id === idPart)
      return f ? (f.name || idPart) : idPart
    },

    // ---- 排除名单 ----
    buildExcludeIdsForPreview(excludeTargetIds, targetLevel) {
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
    },
    /** 从 exclude_ids 对象恢复为当前层级的排除 ID 数组 */
    restoreExcludeTargetIds(task) {
      const raw = task.excludeIds ?? task.exclude_ids
      if (!raw || typeof raw !== 'object') return []
      const level = (task.targetLevel || task.target_level || 'ad').toLowerCase()
      const keyMap = { ad: 'ad_ids', adset: 'adset_ids', campaign: 'campaign_ids' }
      const key = keyMap[level] || 'ad_ids'
      return Array.isArray(raw[key]) ? raw[key].map(v => String(v)) : []
    },
    async refreshExcludeScopeItems() {
      const keyword = String(this.excludeScopeSearch || '').trim()
      if (!keyword || !this.selectedAccountIds?.length) {
        this.excludeScopeItems = []
        return
      }
      this.excludeScopeLoading = true
      const requestId = ++this.excludeRequestId
      const ids = this.selectedAccountIds
      const level = this.form.target_level || 'ad'
      const levelKey = level === 'campaign' ? 'campaigns' : (level === 'adset' ? 'adsets' : 'ads')
      const tf = this.resolveScopeTimeFilters()
      try {
        if (ids.length === 1) {
          const singleAccountId = ids[0]
          const resp = await api.getStructureObjects(levelKey, singleAccountId, { q: keyword, limit: 50, after: null, include_paused: true, ...tf })
          if (requestId !== this.excludeRequestId) return
          this.excludeScopeItems = (resp.items || []).map(it => ({ ...it, account_id: it.account_id || singleAccountId }))
        } else {
          const result = await api.getStructureObjectsMulti(level, ids, { q: keyword, limit: 50, after: null, include_paused: true, ...tf })
          if (requestId !== this.excludeRequestId) return
          this.excludeScopeItems = result.items || []
        }
      } catch {
        if (requestId === this.excludeRequestId) this.excludeScopeItems = []
      } finally {
        if (requestId === this.excludeRequestId) this.excludeScopeLoading = false
      }
    },
    selectAllExcludeScope() {
      const toAdd = this.filteredExcludeScopeItems.map(item => this.scopeItemKey(item))
      this.form.excludeTargetIds = [...new Set([...this.form.excludeTargetIds, ...toAdd])]
    },
    clearExcludeScopeSelection() {
      this.form.excludeTargetIds = []
    },

    // ---- 动态筛选匹配数预览 ----
    _triggerMatchedCountPreview() {
      if (!this.form.use_dynamic_scope || !this.selectedAccountIds?.length) {
        this.form.matchedCount = null
        return
      }
      const completed = this.scopeConditionRows.filter(row => !this.scopeConditionRowError(row))
      if (completed.length === 0) {
        this.form.matchedCount = null
        return
      }
      if (this._matchedCountTimer) clearTimeout(this._matchedCountTimer)
      this._matchedCountTimer = setTimeout(async () => {
        this._matchedCountTimer = null
        try {
          const scope_filters = this.buildScopeFiltersFromRows()
          const exclude_ids = this.buildExcludeIdsForPreview(this.form.excludeTargetIds, this.form.target_level)
          const max_dynamic_matches = this.form.max_dynamic_matches != null && Number.isFinite(Number(this.form.max_dynamic_matches))
            ? Number(this.form.max_dynamic_matches) : undefined
          const response = await api.previewDynamicScope({
            account_ids: this.selectedAccountIds,
            target_level: this.form.target_level || 'ad',
            scope_filters,
            exclude_ids,
            max_dynamic_matches
          })
          this.form.matchedCount = response.count != null ? Number(response.count) : null
        } catch {
          this.form.matchedCount = null
        }
      }, 500)
    },

    // ---- 监控范围条件 ----
    createDefaultScopeConditionRow() {
      return { id: 'sc-' + Math.random().toString(36).slice(2, 9), field: 'name', operator: 'include', value: '', customHours: null, olderThanHours: null, betweenFromHours: null, betweenToHours: null }
    },
    scopeConditionRowError(row) {
      const v = String(row.value || '').trim()
      if (row.field === 'status' && !v) return '数据不能为空'
      if (row.field === 'name' && !v) return '数据不能为空'
      if (row.field === 'created_within') {
        if (v === '24' || v === '48' || v === '72') return null
        if (v === 'custom') { const h = row.customHours; if (h == null || !Number.isFinite(h) || h < 1 || h > 720) return '请填写小时数(1-720)'; return null }
        if (v === 'older_than') { const h = row.olderThanHours; if (h == null || !Number.isFinite(h) || h < 1 || h > 720) return '请填写小时数(1-720)'; return null }
        if (v === 'between') {
          const from = row.betweenFromHours; const to = row.betweenToHours
          if (from == null || !Number.isFinite(from) || from < 1 || from > 720) return '请填写「超过」小时数(1-720)'
          if (to == null || !Number.isFinite(to) || to < 1 || to > 720) return '请填写「以内」小时数(1-720)'
          if (from >= to) return '「超过」小时必须小于「以内」小时'
          return null
        }
        return '请选择时间范围'
      }
      return null
    },
    onScopeConditionFieldChange(row) {
      if (!this.form.use_dynamic_scope) return
      if (row.field === 'name') { row.operator = 'include'; row.value = '' }
      else if (row.field === 'created_within') { row.operator = 'include'; row.value = ''; row.customHours = null; row.olderThanHours = null; row.betweenFromHours = null; row.betweenToHours = null }
      else { row.operator = 'equals'; row.value = '' }
    },
    addScopeConditionRow() {
      if (!this.form.use_dynamic_scope || this.scopeConditionRows.length >= this.SCOPE_CONDITION_MAX_ROWS) return
      this.scopeConditionRows.push(this.createDefaultScopeConditionRow())
    },
    removeScopeConditionRow(idx) {
      if (!this.form.use_dynamic_scope || this.scopeConditionRows.length <= 1) return
      this.scopeConditionRows.splice(idx, 1)
    },
    buildScopeFiltersFromRows() {
      const rows = this.scopeConditionRows || []
      const conditions = []
      for (const row of rows) {
        const err = this.scopeConditionRowError(row); if (err) continue
        if (row.field === 'name') {
          conditions.push({ field: 'name', operator: row.operator === 'exclude' ? 'not_contains' : 'contains', value: String(row.value || '').trim() })
        } else if (row.field === 'status') {
          const val = String(row.value).trim()
          conditions.push({ field: 'effective_status', operator: row.operator === 'not_equals' ? 'not_in' : 'in', value: val === 'active_only' ? ['ACTIVE'] : val === 'paused_only' ? ['PAUSED'] : ['ACTIVE', 'PAUSED'] })
        } else if (row.field === 'created_within') {
          if (row.value === '24' || row.value === '48' || row.value === '72') {
            conditions.push({ field: 'created_time', operator: 'within_hours', value: Number(row.value) })
          } else if (row.value === 'custom') {
            const h = Number(row.customHours); if (Number.isFinite(h) && h >= 1 && h <= 720) conditions.push({ field: 'created_time', operator: 'within_hours', value: h })
          } else if (row.value === 'older_than') {
            const h = Number(row.olderThanHours); if (Number.isFinite(h) && h >= 1 && h <= 720) conditions.push({ field: 'created_time', operator: 'older_than_hours', value: h })
          } else if (row.value === 'between') {
            const from = Number(row.betweenFromHours); const to = Number(row.betweenToHours)
            if (Number.isFinite(from) && Number.isFinite(to) && from >= 1 && to <= 720 && from < to) conditions.push({ field: 'created_time', operator: 'between_hours', value: [from, to] })
          }
        }
      }
      return { level: this.form.target_level || 'ad', conditions }
    },

    onTargetLevelChange() {
      this.form.target_ids = []
      this.form.excludeTargetIds = []
      this.excludeScopeItems = []
      this.form.matchedCount = null  // 层级切换后重置匹配数
      if (this.selectedAccountIds.length) this.refreshScopeItems()
      if (this.form.use_dynamic_scope) this._triggerMatchedCountPreview()
    },
    onScheduleTypeChange() {
      this.form.week_days = []
      this.form.schedule_cron = ''
      this.form.interval_hours = 0
      this.form.interval_minutes = 15
      if (this.form.schedule_type === 'once' && !this.form.schedule_date) {
        this.form.schedule_date = new Date().toISOString().slice(0, 10)
      }
      if (!this.form.schedule_time) this.form.schedule_time = '08:00'
    },
    onActionTypeChange() {
      this.form.budget_value = null
      this.form.budget_unit = 'percent'
      this.form.max_daily_budget = null
      this.form.min_daily_budget = null
    },

    /** 从 scope_filters 恢复监控范围条件行（对齐规则管理 RuleManager） */
    buildScopeRowsFromFilters(scopeFilters) {
      const sf = typeof scopeFilters === 'string' ? JSON.parse(scopeFilters) : scopeFilters
      if (!sf || typeof sf !== 'object') return [this.createDefaultScopeConditionRow()]
      const conditions = sf.conditions || []
      if (!Array.isArray(conditions) || conditions.length === 0) return [this.createDefaultScopeConditionRow()]
      const rows = []
      for (const c of conditions) {
        if (!c || typeof c !== 'object') continue
        const base = { id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}` }
        if (c.field === 'name' && (c.operator === 'contains' || c.operator === 'not_contains')) {
          rows.push({ ...base, field: 'name', operator: c.operator === 'not_contains' ? 'exclude' : 'include', value: String(c.value || ''), customHours: null })
        } else if (c.field === 'effective_status' && (c.operator === 'in' || c.operator === 'not_in')) {
          const arr = Array.isArray(c.value) ? c.value.map(v => String(v).toUpperCase()) : []
          let value = 'active_and_paused'
          if (arr.length === 1 && arr[0] === 'ACTIVE') value = 'active_only'
          else if (arr.length === 1 && arr[0] === 'PAUSED') value = 'paused_only'
          rows.push({ ...base, field: 'status', operator: c.operator === 'not_in' ? 'not_equals' : 'equals', value, customHours: null })
        } else if (c.field === 'created_time') {
          if (c.operator === 'within_hours') {
            const h = Number(c.value)
            if (!Number.isFinite(h) || h <= 0) continue
            let value = 'custom', customHours = h
            if (h === 24 || h === 48 || h === 72) { value = String(h); customHours = null }
            rows.push({ ...base, field: 'created_within', operator: 'include', value, customHours })
          } else if (c.operator === 'older_than_hours') {
            const h = Number(c.value)
            if (!Number.isFinite(h) || h <= 0) continue
            rows.push({ ...base, field: 'created_within', operator: 'include', value: 'older_than', olderThanHours: h, customHours: null })
          } else if (c.operator === 'between_hours') {
            const arr = Array.isArray(c.value) ? c.value.map(Number) : []
            const from = arr[0], to = arr[1]
            if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to > 720 || from >= to) continue
            rows.push({ ...base, field: 'created_within', operator: 'include', value: 'between', betweenFromHours: from, betweenToHours: to, customHours: null })
          }
        }
      }
      return rows.length > 0 ? rows : [this.createDefaultScopeConditionRow()]
    },

    openCreateModal() {
      this.editingTaskId = null
      this.selectedAccountIds = []
      this.accountToAdd = ''
      this.scopeItems = []
      this.scopeSearch = ''
      this.scopePagingAfter = null
      this.excludeScopeSearch = ''
      this.excludeScopeItems = []
      this.scopeApplyMessage = ''
      this.scopeConditionRows = [this.createDefaultScopeConditionRow()]
      this.form = this.getEmptyForm()
      this.form.target_ids = []
      this.form.excludeTargetIds = []
      this.formError = ''
      this.showModal = true
    },

    openEditModal(task) {
      this.editingTaskId = task.id
      this.formError = ''
      this.scopeSearch = ''
      this.excludeScopeSearch = ''
      this.scopeItems = []
      this.excludeScopeItems = []
      this.scopePagingAfter = null
      this.scopeApplyMessage = ''
      // v3.2: 从 scope_filters 恢复监控范围条件（对齐规则管理行为）
      const sf = task.scopeFilters || task.scope_filters
      this.scopeConditionRows = sf && typeof sf === 'object' ? this.buildScopeRowsFromFilters(sf) : [this.createDefaultScopeConditionRow()]
      const taskAccount = task.accountId || ''
      // v3 多账户支持：合并 targetByAccount keys + targetAccountIds 恢复所有目标账户
      const tba = task.targetByAccount ?? task.target_by_account
      const taIds = task.targetAccountIds ?? task.target_account_ids
      const restoredAccountSet = new Set()
      if (tba && typeof tba === 'object') {
        for (const k of Object.keys(tba)) {
          if (Array.isArray(tba[k]) && tba[k].length > 0) restoredAccountSet.add(k)
        }
      }
      if (Array.isArray(taIds) && taIds.length > 0) {
        for (const a of taIds) { const s = String(a).trim(); if (s) restoredAccountSet.add(s) }
      }
      if (restoredAccountSet.size > 0) {
        this.selectedAccountIds = [...restoredAccountSet]
      } else {
        this.selectedAccountIds = taskAccount ? [taskAccount] : []
      }

      // v3 多账户：始终从 target_by_account 重建复合 ID（targetIds 库存为纯ID无账户前缀，无法匹配多账户复选框）
      let restoredTargetIds = []
      if (tba && typeof tba === 'object') {
        for (const [acc, objIds] of Object.entries(tba)) {
          if (Array.isArray(objIds)) {
            for (const oid of objIds) restoredTargetIds.push(`${acc}:${oid}`)
          }
        }
      }
      // 兜底：无 targetByAccount 时用 targetIds（单账户/旧数据兼容）
      if (restoredTargetIds.length === 0) {
        restoredTargetIds = Array.isArray(task.targetIds) ? [...task.targetIds] : (task.targetId ? [task.targetId] : [])
      }
      this.accountToAdd = ''
      const sa = task.scheduleAt || ''
      const f = {
        schedule_type: task.scheduleType || 'once',
        schedule_date: '', schedule_time: '08:00', week_days: [],
        schedule_cron: task.scheduleCron || '',
        interval_hours: 0, interval_minutes: 15,
        schedule_timezone: task.scheduleTimezone || '',
        target_level: task.targetLevel || 'ad',
        target_id: task.targetId || '',
        target_ids: restoredTargetIds,
        action_type: task.actionType || '',
        budget_value: null, budget_unit: 'percent',
        max_daily_budget: null, min_daily_budget: null,
        task_name: task.taskName || '',
        is_simulation: !!task.isSimulation,
        auto_disable: !!task.autoDisable,
        use_dynamic_scope: !!(task.useDynamicScope ?? task.use_dynamic_scope),
        max_dynamic_matches: task.maxDynamicMatches ?? task.max_dynamic_matches ?? 1000,
        matchedCount: null,
        excludeTargetIds: this.restoreExcludeTargetIds(task),
      }
      if (f.schedule_type === 'once' && sa) {
        const p = sa.split(' '); f.schedule_date = p[0] || ''; f.schedule_time = p[1] || '08:00'
      } else if (f.schedule_type === 'daily' && sa) {
        f.schedule_time = sa
      } else if (f.schedule_type === 'weekly' && sa) {
        const [days, t] = sa.split('|')
        f.week_days = (days || '').split(',').map(Number).filter(Boolean)
        f.schedule_time = t || '08:00'
      } else if (f.schedule_type === 'interval' && sa) {
        // 格式："15m" 或 "2h30m"
        const hMatch = sa.match(/(\d+)h/)
        const mMatch = sa.match(/(\d+)m/)
        f.interval_hours = hMatch ? Number(hMatch[1]) : 0
        f.interval_minutes = mMatch ? Number(mMatch[1]) : 15
      }
      const p = task.actionParams
      if (p) {
        const parsed = typeof p === 'string' ? JSON.parse(p) : p
        if (parsed.value != null) f.budget_value = parsed.value
        if (parsed.value_unit) f.budget_unit = parsed.value_unit
        // 预算上下限：存储为美分，回显为美元
        if (parsed.max_daily_budget != null) f.max_daily_budget = Number(parsed.max_daily_budget) / 100
        if (parsed.min_daily_budget != null) f.min_daily_budget = Number(parsed.min_daily_budget) / 100
      }
      this.form = f
      if (this.selectedAccountIds.length) this.refreshScopeItems()
      this.showModal = true
    },

    validateForm() {
      if (!this.form.schedule_type) return '请选择调度类型'
      if (this.form.schedule_type === 'once') { if (!this.form.schedule_date || !this.form.schedule_time) return '请填写日期和时间' }
      else if (this.form.schedule_type === 'daily') { if (!this.form.schedule_time) return '请填写时间' }
      else if (this.form.schedule_type === 'weekly') {
        if (!this.form.week_days.length) return '请至少选择一天'
        if (!this.form.schedule_time) return '请填写时间'
      } else if (this.form.schedule_type === 'interval') {
        if (!this.form.interval_minutes && !this.form.interval_hours) return '请设置间隔时间（至少1分钟）'
        if (this.form.interval_minutes < 1 && this.form.interval_hours < 1) return '间隔时间至少为1分钟'
      } else if (this.form.schedule_type === 'cron') {
        if (!this.form.schedule_cron || !this.form.schedule_cron.trim()) return '请填写 Cron 表达式'
      }
      if (!this.selectedAccountIds.length) return '请至少选择一个广告账户'
      if (!this.form.use_dynamic_scope && !this.form.target_ids.length) return '请至少选择一个目标对象（或开启动态筛选）'
      if (this.form.use_dynamic_scope) {
        const validRows = this.scopeConditionRows.filter(row => !this.scopeConditionRowError(row))
        if (validRows.length === 0) return '开启动态筛选时至少需要一条完整的监控范围条件'
      }
      if (!this.form.action_type) return '请选择执行动作'
      if (['set_budget', 'increase_budget', 'decrease_budget'].includes(this.form.action_type)) {
        if (!this.form.budget_value || this.form.budget_value <= 0) return '请输入有效的预算金额'
      }
      return null
    },

    buildScheduleAt() {
      const t = this.form.schedule_type
      if (t === 'once') return `${this.form.schedule_date} ${this.form.schedule_time}`
      if (t === 'daily') return this.form.schedule_time
      if (t === 'weekly') return [...this.form.week_days].sort().join(',') + '|' + this.form.schedule_time
      if (t === 'interval') {
        const h = this.form.interval_hours || 0
        const m = this.form.interval_minutes || 0
        if (h && m) return `${h}h${m}m`
        if (h) return `${h}h`
        return `${m}m`
      }
      return null
    },

    buildActionParams() {
      const t = this.form.action_type
      if (['pause_ad', 'activate_ad'].includes(t)) {
        return {}  // 暂停/启用无需参数
      }
      if (['set_budget', 'increase_budget', 'decrease_budget'].includes(t)) {
        const p = { value: this.form.budget_value }
        if (t !== 'set_budget') p.value_unit = this.form.budget_unit
        if (this.form.max_daily_budget != null && Number.isFinite(Number(this.form.max_daily_budget))) {
          p.max_daily_budget = Math.round(Number(this.form.max_daily_budget) * 100) // 美元→美分
        }
        if (this.form.min_daily_budget != null && Number.isFinite(Number(this.form.min_daily_budget))) {
          p.min_daily_budget = Math.round(Number(this.form.min_daily_budget) * 100)
        }
        return p
      }
      return {}
    },

    async saveTask() {
      const err = this.validateForm()
      if (err) { this.formError = err; return }
      this.formError = ''
      this.saving = true
      try {
        // v3 多账户支持：构建 target_by_account
        // 策略：优先用 scopeItems 中的 account_id；如果 scopeItems 为空或缺少 account_id，则重新加载
        const ids = this.form.target_ids || []
        const accountSet = new Set(this.selectedAccountIds)
        const byAccount = {}

        if (!this.form.use_dynamic_scope) {
          // 构建 scopeItems 查找表：objectId → account_id
          let scopeAccountMap = new Map()
          for (const it of this.scopeItems) {
            if (it.account_id && it.id) scopeAccountMap.set(String(it.id), it.account_id)
          }

          // 如果 scopeItems 为空或多数 item 缺失 account_id，重新从服务端拉取以确保正确
          const idsNeedResolution = ids.filter(id => {
            const s = String(id).trim()
            if (!s) return false
            const colonIdx = s.indexOf(':')
            const idPart = colonIdx >= 0 ? s.slice(colonIdx + 1) : s
            const acc = colonIdx >= 0 ? s.slice(0, colonIdx).trim() : ''
            return !acc || !scopeAccountMap.has(idPart)
          })
          if (idsNeedResolution.length > 0 && accountSet.size > 1) {
            try {
              const level = this.form.target_level || 'ad'
              const result = await api.getStructureObjectsMulti(level, this.selectedAccountIds, { limit: 500 })
              const freshItems = result?.items || []
              scopeAccountMap = new Map()
              for (const it of freshItems) {
                if (it.account_id && it.id) scopeAccountMap.set(String(it.id), it.account_id)
              }
            } catch (e) {
              // 重载失败时 scopeAccountMap 保持原样，后续逐个 ID 回退到 selectedAccountIds[0]
            }
          }

          for (const id of ids) {
            const s = String(id).trim()
            if (!s) continue
            let acc, idPart
            if (s.includes(':')) {
              const colonIdx = s.indexOf(':')
              acc = s.slice(0, colonIdx).trim()
              idPart = s.slice(colonIdx + 1)
            } else {
              acc = ''
              idPart = s
            }
            if (!idPart) continue
            // 解析归属账户：复合键直接取，否则从 scopeAccountMap 查，再不行回退到第一个选中账户
            if (!acc) {
              acc = scopeAccountMap.get(idPart) || (accountSet.size > 0 ? this.selectedAccountIds[0] : null)
            }
            if (acc) {
              if (!byAccount[acc]) byAccount[acc] = []
              if (!byAccount[acc].includes(idPart)) byAccount[acc].push(idPart)
            }
          }
        }
        // 动态筛选模式：target_by_account 为空对象，执行时按账户逐个调用 previewDynamicScope
        const targetByAccount = Object.keys(byAccount).length > 0 ? byAccount : null

        // v3.4：规范化 target_ids 为复合格式 "act_xxx:id"（对齐规则管理，确保多账户对象归属不丢失）
        const normalizedTargetIds = []
        if (!this.form.use_dynamic_scope) {
          for (const acc of Object.keys(byAccount)) {
            for (const objId of byAccount[acc]) {
              normalizedTargetIds.push(`${acc}:${objId}`)
            }
          }
        }

        const payload = {
          schedule_type: this.form.schedule_type,
          schedule_at: this.buildScheduleAt(),
          schedule_cron: this.form.schedule_type === 'cron' ? this.form.schedule_cron : null,
          schedule_timezone: this.form.schedule_timezone || null,
          account_id: this.selectedAccountIds[0] || '',
          target_accounts: this.selectedAccountIds.length > 0 ? this.selectedAccountIds : null,
          target_by_account: targetByAccount,
          target_level: this.form.target_level,
          target_id: this.form.use_dynamic_scope ? null : (normalizedTargetIds[0] || null),
          target_ids: this.form.use_dynamic_scope ? [] : normalizedTargetIds,
          use_dynamic_scope: this.form.use_dynamic_scope,
          scope_filters: this.form.use_dynamic_scope ? this.buildScopeFiltersFromRows() : null,
          exclude_ids: this.form.excludeTargetIds.length > 0 ? this.buildExcludeIdsForPreview(this.form.excludeTargetIds, this.form.target_level) : null,
          max_dynamic_matches: this.form.use_dynamic_scope ? this.form.max_dynamic_matches : null,
          action_type: this.form.action_type,
          action_params: this.buildActionParams(),
          task_name: this.form.task_name || null,
          is_simulation: this.form.is_simulation,
          auto_disable: this.form.auto_disable
        }
        if (this.editingTaskId) {
          await api.updateScheduledTask(this.editingTaskId, payload)
          this.showToast('任务已更新', 'success')
        } else {
          await api.createScheduledTask(payload)
          this.showToast('任务已创建', 'success')
        }
        this.showModal = false
        await this.loadTasks()
      } catch (e) {
        this.formError = e.response?.data?.error || e.message || '保存失败'
      } finally { this.saving = false }
    },

    async deleteTask(task) {
      if (!confirm('确定删除此定时任务？')) return
      try {
        await api.deleteScheduledTask(task.id)
        this.showToast('已删除', 'info')
        await this.loadTasks()
      } catch (e) { this.showToast('删除失败: ' + (e.response?.data?.error || e.message), 'error') }
    },

    async toggleTask(task, enabled) {
      try {
        const u = await api.toggleScheduledTask(task.id)
        // 保留 API 未返回的字段：ownerName（仅列表接口补全）
        if (u && !u.ownerName && task.ownerName) {
          u.ownerName = task.ownerName
          u.ownerId = task.ownerId ?? u.ownerId
        }
        const i = this.tasks.findIndex(t => t.id === task.id)
        if (i >= 0) this.tasks.splice(i, 1, u)
        this.showToast(u.enabled ? '已启用' : '已禁用', 'info')
      } catch (e) { this.showToast('操作失败: ' + (e.response?.data?.error || e.message), 'error') }
    },

    async executeTask(task) {
      this.runningTaskId = task.id
      try {
        const r = await api.executeScheduledTask(task.id)
        this.showToast(r.message || '已执行', 'success')
        await this.loadTasks()
      } catch (e) {
        this.showToast(e.response?.data?.error || e.message || '执行失败', 'error')
      } finally { this.runningTaskId = null }
    },

    scheduleTypeLabel(t) {
      const m = { once: '一次性', daily: '每天', weekly: '每周', interval: '按间隔', cron: 'Cron' }
      return m[t] || t
    },
    formatActionParams(task) {
      const at = task.actionType || ''
      const p = task.actionParams
      if (!p || typeof p !== 'object') return this.actionLabel(at)
      const v = p.value
      if (v == null) return this.actionLabel(at)
      if (at === 'set_budget') return '设置预算到 $' + v
      if (at === 'increase_budget') {
        const unit = (p.value_unit || 'percent') === 'usd' ? '$' : '%'
        let label = '上调 ' + v + unit
        if (p.max_daily_budget != null) label += '（上限 $' + (Number(p.max_daily_budget) / 100).toFixed(2) + '）'
        return label
      }
      if (at === 'decrease_budget') {
        const unit = (p.value_unit || 'percent') === 'usd' ? '$' : '%'
        let label = '下调 ' + v + unit
        if (p.min_daily_budget != null) label += '（下限 $' + (Number(p.min_daily_budget) / 100).toFixed(2) + '）'
        return label
      }
      return this.actionLabel(at)
    },

    dynamicScopeStatusClass(task) {
      // 简易状态判断：有 scope_filters 且非空 = 正常
      const sf = task.scopeFilters || task.scope_filters
      if (!sf || typeof sf !== 'object') return 'dynamic-off'
      const conds = sf.conditions || []
      if (!Array.isArray(conds) || conds.length === 0) return 'dynamic-off'
      return 'dynamic-on'
    },

    dynamicScopeStatusLabel(task) {
      const sf = task.scopeFilters || task.scope_filters
      if (!sf || typeof sf !== 'object') return '未配置'
      const conds = sf.conditions || []
      if (!Array.isArray(conds) || conds.length === 0) return '未配置'
      return '状态正常'
    },

    countExcluded(task) {
      const ex = task.excludeIds || task.exclude_ids
      if (!ex || typeof ex !== 'object') return 0
      let n = 0
      for (const k of ['ad_ids', 'adset_ids', 'campaign_ids']) {
        if (Array.isArray(ex[k])) n += ex[k].length
      }
      return n
    },

    actionLabel(t) {
      const m = { pause_ad: '暂停', activate_ad: '启动', set_budget: '设置预算', increase_budget: '上调预算', decrease_budget: '下调预算' }
      return m[t] || t
    },
    getActionClass(t) {
      if (t === 'pause_ad') return 'danger-action'
      if (t === 'activate_ad') return 'success-action'
      return 'budget-action'
    },
    formatTime(v) {
      if (!v) return '-'
      try { return new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }
      catch { return v }
    },
    showToast(msg, type = 'info') {
      this.toastMsg = msg
      this.toastType = type
      setTimeout(() => { this.toastMsg = '' }, 3000)
    }
  }
}
</script>

<style scoped>
/* === 顶部操作栏（与 RuleManager 对齐） === */
.header-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}
.header-actions h2 { margin: 0; font-size: 24px; color: var(--text-primary, #111827); }
.actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.actions .btn.small {
  padding: 6px 12px;
  font-size: 13px;
}

/* === 负责人筛选下拉（与 RuleManager 同款） === */
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
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.owner-filter-trigger:hover {
  border-color: #2563eb;
  box-shadow: 0 0 0 1px #2563eb;
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
  color: #6b7280;
}
.owner-filter-value {
  font-weight: 500;
  color: #111827;
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
  color: #6b7280;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  border-radius: 4px;
}
.owner-filter-clear:hover {
  color: #dc2626;
  background: #fef2f2;
}
.owner-filter-chevron {
  font-size: 10px;
  color: #6b7280;
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
  border: 1px solid #e5e7eb;
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
  color: #374151;
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
  color: #6b7280;
  border-bottom: 1px solid #e5e7eb;
  margin-bottom: 4px;
}
.owner-filter-option-clear:hover {
  background: #f9fafb;
  color: #2563eb;
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
.owner-name { color: #374151; font-size: 13px; }

/* Modal overlay + content */
.modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.4); display:flex; align-items:center; justify-content:center; z-index:1000; }
.modal-content { background:#fff; border-radius:12px; width:90%; max-width:600px; max-height:85vh; overflow-y:auto; box-shadow:0 4px 20px rgba(0,0,0,0.2); }
.modal-content.wide { max-width:800px; }
.modal-header { display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-bottom:1px solid #e5e7eb; }
.modal-header h3 { margin:0; font-size:18px; }
.close-btn { background:none; border:none; font-size:22px; cursor:pointer; color:#6b7280; }
.close-btn:hover { color:#111; }
.modal-body { padding:20px; }
.modal-footer { display:flex; justify-content:flex-end; gap:10px; padding:16px 20px; border-top:1px solid #e5e7eb; }

/* Section blocks */
.section-block { margin-bottom:20px; }
.section-title { font-size:15px; font-weight:600; margin:0 0 12px 0; color:#111; border-bottom:2px solid #2563eb; padding-bottom:6px; }
.form-row { display:flex; gap:12px; margin-bottom:12px; align-items:flex-start; flex-wrap:wrap; }
.form-group { flex:1; min-width:0; }
.form-group.flex-1 { flex:1; }
.form-group.flex-2 { flex:2; }
.form-group label { display:block; margin-bottom:4px; font-weight:500; font-size:13px; color:#374151; }
.input-text { width:100%; padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; box-sizing:border-box; }
.input-text:focus { border-color:#2563eb; outline:none; box-shadow:0 0 0 2px rgba(37,99,235,0.15); }
.input-number { padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; width:120px; }
.select { padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; background:#fff; }
.radio-group { display:flex; gap:16px; flex-wrap:wrap; }
.radio-label { display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px; font-weight:normal; }
.hint { font-size:12px; color:#6b7280; margin-top:4px; }
.empty-hint { padding:20px; text-align:center; color:#9ca3af; font-size:13px; border:1px dashed #d1d5db; border-radius:6px; }
.loading { padding:20px; text-align:center; color:#6b7280; font-size:13px; }
.alert.error { padding:10px 14px; background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; border-radius:6px; font-size:13px; margin-top:8px; }

/* Buttons */
.btn { display:inline-flex; align-items:center; gap:6px; padding:8px 16px; border:1px solid #2563eb; border-radius:6px; background:#2563eb; color:#fff; font-size:14px; cursor:pointer; }
.btn:hover { background:#1d4ed8; }
.btn:disabled { opacity:0.5; cursor:not-allowed; }
.btn.secondary { background:#fff; color:#374151; border-color:#d1d5db; }
.btn.secondary:hover { background:#f3f4f6; }
.btn.small { padding:6px 12px; font-size:13px; }
.btn-text { background:none; border:none; cursor:pointer; color:#6b7280; font-size:13px; padding:0; }
.btn-text:hover { color:#2563eb; text-decoration:underline; }
.btn-text.danger:hover { color:#dc2626; }
.btn-tiny { padding:4px 8px; font-size:12px; border:1px solid #d1d5db; border-radius:4px; background:#fff; cursor:pointer; }
.btn-tiny:hover { background:#f3f4f6; }

/* Cards */
.rules-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:20px; }
.rule-card { background:#fff; border-radius:12px; border:1px solid #e5e7eb; box-shadow:0 2px 8px rgba(0,0,0,0.04); transition:all 0.2s; display:flex; flex-direction:column; }
.rule-card:hover { transform:translateY(-2px); box-shadow:0 8px 16px rgba(0,0,0,0.08); }
.rule-card.disabled { opacity:0.7; background:#f9fafb; }
.card-header { padding:16px; border-bottom:1px solid #f3f4f6; display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
.card-header-titles { flex:1; min-width:0; }
.rule-name { margin:0; font-size:16px; font-weight:600; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.badge-dnf { font-size:10px; font-weight:500; padding:2px 6px; border-radius:4px; background:#dbeafe; color:#1d4ed8; }
.card-body { padding:16px; flex:1; }
.card-footer { padding:12px 16px; border-top:1px solid #f3f4f6; display:flex; justify-content:flex-end; gap:12px; }

/* Switch */
.switch-wrapper { display:flex; align-items:center; gap:8px; }
.switch { position:relative; display:inline-block; width:36px; height:20px; }
.switch input { opacity:0; width:0; height:0; }
.slider { position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#ccc; transition:.4s; border-radius:20px; }
.slider:before { position:absolute; content:""; height:16px; width:16px; left:2px; bottom:2px; background-color:white; transition:.4s; border-radius:50%; }
input:checked + .slider { background-color:#16a34a; }
input:checked + .slider:before { transform:translateX(16px); }
.switch-label { font-size:13px; color:#374151; }

/* Section meta */
.section { margin-bottom:8px; }
.label { display:block; font-size:11px; color:#6b7280; margin-bottom:4px; font-weight:600; }
.account-id { font-size:12px; color:#2563eb; font-family:monospace; background:#f3f4f6; padding:2px 6px; border-radius:4px; }
.execution-meta { display:flex; flex-wrap:wrap; gap:4px 12px; align-items:baseline; font-size:12px; }
.execution-meta .label { display:inline; margin-bottom:0; }
.muted { color:#6b7280; font-size:12px; }

/* Pills */
.pill { display:inline-block; padding:4px 10px; border-radius:20px; font-size:13px; margin:0 6px 6px 0; border:1px solid transparent; }
.pill.dynamic-on { background:#ecfdf5; color:#047857; border-color:#a7f3d0; }
.pill.dynamic-off { background:#f3f4f6; color:#6b7280; border-color:#d1d5db; }

/* Scope list */
.scope-filters { margin-bottom:8px; }
.scope-list { border:1px solid #e5e7eb; border-radius:6px; padding:8px; }
.scope-actions { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; font-size:13px; }
.scope-buttons { display:flex; gap:6px; }
.scope-items { max-height:250px; overflow-y:auto; }
.scope-item { display:flex; align-items:center; gap:6px; padding:6px 8px; cursor:pointer; font-size:13px; border-radius:4px; }
.scope-item:hover { background:#f3f4f6; }
.scope-item-active { background:#e0f2fe; }
.scope-item-paused { opacity:0.65; }
.scope-item .name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.scope-item .id { font-size:11px; color:#9ca3af; font-family:monospace; }
.account-badge { font-size:10px; background:#f3f4f6; color:#6b7280; padding:1px 4px; border-radius:3px; }
.scope-more { text-align:center; padding:8px; }
.scope-dynamic-summary { padding:8px; color:#6b7280; font-size:13px; }
.scope-row-error { color:#dc2626; font-size:12px; margin-top:2px; }
.scope-between-group { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; flex-shrink: 0; }
.scope-between-group .scope-between-input { width: 80px; min-width: 60px; flex: none; }
.scope-between-group .scope-between-sep { color: #6b7280; font-size: 13px; user-select: none; }

/* Tags */
.selected-preview { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px; }
.tag { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; background:#dbeafe; color:#1d4ed8; border-radius:4px; font-size:12px; }
.tag-remove { background:none; border:none; cursor:pointer; color:#6b7280; font-size:14px; padding:0; line-height:1; }
.tag-remove:hover { color:#dc2626; }

/* Empty */
.empty-rules { text-align:center; padding:60px 0; color:#6b7280; }
.empty-icon { font-size:48px; margin-bottom:16px; opacity:0.5; }
.empty-rules h3 { color:#111; margin:8px 0; }
.empty-actions { display:inline-flex; gap:10px; flex-wrap:wrap; justify-content:center; }

/* Filter */
.filter-bar { display:flex; gap:10px; margin-bottom:16px; align-items:center; flex-wrap:wrap; }
.weekday-picker { display:flex; flex-wrap:wrap; gap:8px; }
.weekday-picker .radio-label { display:flex; align-items:center; gap:3px; cursor:pointer; font-size:13px; }
.date-picker-row { display:flex; align-items:center; gap:8px; }
.time-picker-row { display:flex; align-items:center; gap:8px; }
.time-input { max-width:80px; text-align:center; }
.time-spinners { display:flex; gap:4px; }
.time-btn { padding:2px 6px; font-size:11px; border-radius:3px; }
.scope-items { max-height:250px; overflow-y:auto; border:1px solid #e5e7eb; border-radius:6px; padding:4px; }
.scope-item { display:flex; align-items:center; padding:6px 8px; cursor:pointer; font-size:13px; border-radius:4px; gap:6px; }
.scope-item:hover { background:#f3f4f6; }
.scope-item-active { background:#e0f2fe; }
.pill.action { padding:2px 8px; border-radius:10px; font-size:12px; background:#fff3cd; color:#856404; }
.pill.action.danger-action { background:#fce4ec; color:#c62828; }
.pill.action.success-action { background:#e8f5e9; color:#2e7d32; }
.pill.action.budget-action { background:#e3f2fd; color:#1565c0; }
.budget-cap-label { font-size:12px; color:#6b7280; margin-right:4px; }
.budget-cap-input { max-width:140px; }
.action-hint { font-size:12px; color:#6b7280; white-space:nowrap; }
.toast { position:fixed; top:20px; right:20px; padding:12px 20px; border-radius:6px; color:#fff; font-size:14px; z-index:2000; animation:fadeIn .3s; }
.toast.info { background:#17a2b8; } .toast.success { background:#28a745; } .toast.error { background:#dc3545; }
@keyframes fadeIn { from{opacity:0;transform:translateY(-10px)} to{opacity:1;transform:translateY(0)} }

/* Dynamic scope */
.dynamic-scope-row { align-items:center; }
.dynamic-max-wrap { display:flex; align-items:center; gap:8px; }
.dynamic-max-wrap label { font-size:12px; color:#6b7280; white-space:nowrap; }
.scope-condition-block { padding:10px; border:1px solid #e5e7eb; border-radius:6px; background:#fafafa; }
.scope-condition-block-disabled { opacity:0.55; background:#f3f4f6; }
.scope-condition-hint { margin-bottom:8px; }
.conditions-container { display:flex; flex-direction:column; gap:8px; }
.condition-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.join-label { font-size:12px; font-weight:600; color:#6b7280; width:32px; text-align:center; }
.join-placeholder { width:32px; }
.scope-field-select { min-width:100px; }
.scope-operator-select { min-width:90px; }
.scope-value-input { flex:1; min-width:120px; }
.scope-value-select { min-width:140px; }
.conditions-container select, .conditions-container input { padding:6px 8px; font-size:13px; }
.scope-row-error { color:#dc2626; font-size:12px; margin-top:2px; width:100%; }
.scope-apply-row { margin-top:8px; padding:8px 12px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; }
.scope-apply-message { font-size:12px; color:#166534; }
.btn-icon.danger { background:none; border:none; color:#dc2626; cursor:pointer; font-size:16px; padding:2px 4px; }
.btn-icon.danger:hover { background:#fef2f2; border-radius:4px; }
.link-add-scope { background:none; border:1px dashed #d1d5db; color:#2563eb; cursor:pointer; padding:6px 12px; border-radius:4px; font-size:12px; width:100%; }
.link-add-scope:hover { border-color:#2563eb; background:#eff6ff; }
.link-add-scope:disabled { opacity:0.4; cursor:not-allowed; }
</style>
