<template>
  <div class="admin-page">
    <div class="page-header">
      <h2>规则变更审计</h2>
      <p class="sub">仅展示人为操作（创建/编辑/开关/删除），不包含系统动态刷新等记录。</p>
    </div>

    <div class="card filters">
      <div class="filter-row">
        <label>规则 ID <input v-model.number="f.rule_id" type="number" min="1" class="inp" placeholder="可选" /></label>
        <label>操作人用户 ID <input v-model.number="f.changed_by_user_id" type="number" min="1" class="inp" placeholder="可选" /></label>
        <label>类型
          <select v-model="f.change_type" class="select">
            <option value="">全部</option>
            <option value="CREATE">创建</option>
            <option value="UPDATE">编辑</option>
            <option value="TOGGLE">开关</option>
            <option value="DELETE">删除</option>
          </select>
        </label>
        <div class="date-range-block">
          <span class="date-range-label">变更日期</span>
          <VueDatePicker
            v-model="dateRange"
            range
            :enable-time-picker="false"
            format="yyyy-MM-dd"
            preview-format="yyyy-MM-dd"
            :clearable="true"
            class="date-range-picker"
            @update:model-value="onDateRangeUpdate"
          />
          <div class="date-presets">
            <button type="button" class="btn tiny secondary" @click="presetRange('today')">今天</button>
            <button type="button" class="btn tiny secondary" @click="presetRange('yesterday')">昨天</button>
            <button type="button" class="btn tiny secondary" @click="presetRange('last7')">最近 7 天</button>
            <button type="button" class="btn tiny secondary" @click="presetRange('last30')">最近 30 天</button>
            <button type="button" class="btn tiny secondary" @click="presetRange('last90')">最近 3 个月</button>
          </div>
        </div>
        <button type="button" class="btn secondary" @click="load(1)">查询</button>
      </div>
    </div>

    <div v-if="loading" class="loading">加载中…</div>

    <div v-else class="card">
      <div v-if="items.length === 0" class="empty">暂无记录</div>
      <div v-else class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>规则 ID</th>
              <th>类型</th>
              <th>规则名</th>
              <th>操作人</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in items" :key="r.id">
              <td class="mono small">{{ formatTime(r.changed_at) }}</td>
              <td class="mono">{{ r.rule_id }}</td>
              <td><span class="tag" :class="typeClass(r.change_type)">{{ typeLabel(r.change_type) }}</span></td>
              <td>{{ r.rule_name_preview || '—' }}</td>
              <td>{{ r.changed_by_username || ('#' + r.changed_by_user_id) }}</td>
              <td>
                <button type="button" class="btn small secondary" @click="openDetail(r.id)">查看</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="pager" v-if="total > limit">
          <button type="button" class="btn small secondary" :disabled="page <= 1" @click="load(page - 1)">上一页</button>
          <span class="page-info">第 {{ page }} 页 / 共 {{ totalPages }} 页（{{ total }} 条）</span>
          <button type="button" class="btn small secondary" :disabled="page >= totalPages" @click="load(page + 1)">下一页</button>
        </div>
      </div>
    </div>

    <div v-if="detailModalOpen" class="modal-mask" @click.self="closeDetail">
      <div class="modal card">
        <div class="modal-head">
          <h3>变更详情 <template v-if="detailOpenId">#{{ detailOpenId }}</template></h3>
          <button type="button" class="btn small secondary" @click="closeDetail">关闭</button>
        </div>
        <div class="modal-body">
          <div v-if="detailPhase === 'fetch'" class="detail-loading">正在加载详情…</div>
          <div v-else-if="detailPhase === 'parse'" class="detail-loading">正在解析变更详情…</div>
          <template v-else-if="detailPayload">
          <dl class="meta">
            <dt>规则 ID</dt><dd class="mono">{{ detailPayload.record.rule_id }}</dd>
            <dt>类型</dt><dd>{{ typeLabel(detailPayload.record.change_type) }}</dd>
            <dt>时间</dt><dd>{{ formatTime(detailPayload.record.changed_at) }}</dd>
            <dt>操作人</dt><dd>{{ detailPayload.record.changed_by_username || ('用户 #' + detailPayload.record.changed_by_user_id) }}</dd>
          </dl>

          <p v-if="detailPayload.diff?.notice" class="notice">{{ detailPayload.diff.notice }}</p>

          <template v-if="enrichedDiffChanges.length">
            <h4 class="diff-h4">字段级变更（双栏对照 · 顺序与规则编辑习惯一致）</h4>
            <section
              v-for="(row, i) in enrichedDiffChanges"
              :key="`${row.change.field}-${i}`"
              class="diff-field-card"
            >
              <div class="diff-title">{{ row.change.label }} <code class="mono">({{ row.change.field }})</code></div>

              <div v-if="row.delta" class="delta-summary">
                <div class="delta-summary-title">本次增减摘要（相对另一端）</div>

                <template v-if="row.delta.kind === 'flat'">
                  <div class="delta-block">
                    <div class="delta-block-label delta-block-label--add">新增</div>
                    <div class="delta-block-body mono">{{ row.delta.added.length ? row.delta.added.join('、') : '无' }}</div>
                  </div>
                  <div class="delta-block">
                    <div class="delta-block-label delta-block-label--remove">减少</div>
                    <div class="delta-block-body mono">{{ row.delta.removed.length ? row.delta.removed.join('、') : '无' }}</div>
                  </div>
                </template>

                <template v-else-if="row.delta.kind === 'exclude'">
                  <template v-if="row.delta.layers.length">
                    <div
                      v-for="(layer, li) in row.delta.layers"
                      :key="layer.layerKey"
                      class="delta-exclude-layer"
                    >
                      <div class="delta-exclude-layer-title">排除 — {{ layer.layerLabel }}</div>
                      <div class="delta-block">
                        <div class="delta-block-label delta-block-label--add">新增排除</div>
                        <div class="delta-block-body mono">{{ layer.added.length ? layer.added.join('、') : '无' }}</div>
                      </div>
                      <div class="delta-block">
                        <div class="delta-block-label delta-block-label--remove">减少排除</div>
                        <div class="delta-block-body mono">{{ layer.removed.length ? layer.removed.join('、') : '无' }}</div>
                      </div>
                    </div>
                  </template>
                  <p v-else class="delta-none">（本字段无分层级内的增减）</p>
                </template>

                <template v-else-if="row.delta.kind === 'target_by_account'">
                  <div v-if="row.delta.newAccounts.length" class="delta-tba-section">
                    <div class="delta-tba-heading">新增账户（新桶）</div>
                    <div
                      v-for="b in row.delta.newAccounts"
                      :key="'na-' + b.act"
                      class="delta-tba-line mono"
                    >
                      <span class="delta-tba-act">{{ b.act }}</span>
                      <span class="delta-tba-ids">{{ b.ids.length ? b.ids.join('、') : '（空）' }}</span>
                    </div>
                  </div>
                  <div v-if="row.delta.removedAccounts.length" class="delta-tba-section">
                    <div class="delta-tba-heading">移除账户（整桶）</div>
                    <div
                      v-for="b in row.delta.removedAccounts"
                      :key="'rm-' + b.act"
                      class="delta-tba-line mono"
                    >
                      <span class="delta-tba-act">{{ b.act }}</span>
                      <span class="delta-tba-ids">{{ b.ids.length ? b.ids.join('、') : '（空）' }}</span>
                    </div>
                  </div>
                  <div v-if="row.delta.sameAccountIdDelta.length" class="delta-tba-section">
                    <div class="delta-tba-heading">同账户下目标 ID 增减</div>
                    <div
                      v-for="x in row.delta.sameAccountIdDelta"
                      :key="'sc-' + x.act"
                      class="delta-tba-bucket"
                    >
                      <div class="delta-tba-act mono">{{ x.act }}</div>
                      <div class="delta-block">
                        <div class="delta-block-label delta-block-label--add">新增</div>
                        <div class="delta-block-body mono">{{ x.added.length ? x.added.join('、') : '无' }}</div>
                      </div>
                      <div class="delta-block">
                        <div class="delta-block-label delta-block-label--remove">减少</div>
                        <div class="delta-block-body mono">{{ x.removed.length ? x.removed.join('、') : '无' }}</div>
                      </div>
                    </div>
                  </div>
                </template>
              </div>

              <div class="diff-container">
                <div class="diff-column diff-column--before">
                  <div class="diff-label">修改前</div>
                  <div class="diff-text narrative-scroll">{{ formatDiffColumnBefore(row.change, detailPayload) }}</div>
                </div>
                <div class="diff-column diff-column--after">
                  <div class="diff-label">修改后</div>
                  <div class="diff-text narrative-scroll">{{ formatDiffColumnAfter(row.change, detailPayload) }}</div>
                </div>
              </div>
            </section>
          </template>

          <details v-if="enrichedDiffChanges.length" class="json-details">
            <summary>查看字段级原始 JSON 对照</summary>
            <div v-for="(row, i) in enrichedDiffChanges" :key="'j-'+i" class="diff-block">
              <div class="diff-title">{{ row.change.label }} <code class="mono">({{ row.change.field }})</code></div>
              <div class="diff-cols">
                <div class="diff-col">
                  <div class="diff-label">变更前</div>
                  <pre class="json-pre json-pre-inner">{{ stringify(row.change.before) }}</pre>
                </div>
                <div class="diff-col">
                  <div class="diff-label">变更后</div>
                  <pre class="json-pre json-pre-inner">{{ stringify(row.change.after) }}</pre>
                </div>
              </div>
            </div>
          </details>

          <details v-if="detailPayload && detailViewOk === false" class="json-details raw-fallback">
            <summary>变更说明解析异常 · 原始详情 JSON（兜底 §10.5）</summary>
            <pre class="json-pre json-pre-inner">{{ stringify(detailPayload) }}</pre>
          </details>

          <template v-if="showFullSnapshot(detailPayload)">
            <h4>完整配置（变更后 / 创建时 / 删除前）</h4>
            <div class="narrative-scroll">
              <pre class="json-pre full">{{ stringify(detailPayload.snapshot_after) }}</pre>
            </div>
          </template>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed, onMounted, nextTick } from 'vue'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import VueDatePicker from '@vuepic/vue-datepicker'
import '@vuepic/vue-datepicker/dist/main.css'
import { authFetch } from '../utils/authFetch.js'
import {
  buildDetailNarrativeLines,
  sortRuleHistoryChanges,
  formatDiffColumnBefore,
  formatDiffColumnAfter,
  getCollectionDeltaSummary
} from '../utils/ruleAuditNarrative.js'

dayjs.locale('zh-cn')

export default {
  name: 'AdminRuleHistory',
  components: { VueDatePicker },
  setup() {
    const items = ref([])
    const total = ref(0)
    const page = ref(1)
    const limit = ref(30)
    const loading = ref(false)
    /** @type {import('vue').Ref<Record<string, unknown>|null>} */
    const detailPayload = ref(null)
    /** 叙述/双栏流水线是否成功；失败时展示底部原始 JSON 兜底（§10.5） */
    const detailViewOk = ref(true)
    const detailModalOpen = ref(false)
    /** @type {import('vue').Ref<'idle'|'fetch'|'parse'|'ready'>} */
    const detailPhase = ref('idle')
    const detailOpenId = ref(null)
    /** 日期范围控件绑定（Date[] | null），与 f.from / f.to 字符串同步 */
    const dateRange = ref(null)
    const f = ref({
      rule_id: null,
      changed_by_user_id: null,
      change_type: '',
      from: '',
      to: ''
    })

    const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit.value)))

    /** 每条 diff 附带集合类「增减摘要」，顺序仍由 sortRuleHistoryChanges / DIFF_FIELD_RANK 决定 */
    const enrichedDiffChanges = computed(() => {
      if (!detailPayload.value) return []
      return sortRuleHistoryChanges(detailPayload.value).map((change) => ({
        change,
        delta: getCollectionDeltaSummary(change)
      }))
    })

    const typeLabel = (t) => {
      if (t === 'CREATE') return '创建'
      if (t === 'UPDATE') return '编辑'
      if (t === 'TOGGLE') return '开关'
      if (t === 'DELETE') return '删除'
      return t || '—'
    }

    const typeClass = (t) => {
      if (t === 'CREATE') return 'create'
      if (t === 'UPDATE') return 'update'
      if (t === 'TOGGLE') return 'toggle'
      if (t === 'DELETE') return 'delete'
      return ''
    }

    const formatTime = (v) => {
      if (!v) return '—'
      const s = typeof v === 'string' ? v.replace(' ', 'T') : String(v)
      const d = new Date(s)
      if (Number.isNaN(d.getTime())) return String(v)
      return d.toLocaleString('zh-CN', { hour12: false })
    }

    const stringify = (v) => {
      if (v === undefined) return '(无)'
      try {
        return JSON.stringify(v, null, 2)
      } catch {
        return String(v)
      }
    }

    const load = async (p = page.value) => {
      loading.value = true
      page.value = p
      try {
        const q = new URLSearchParams()
        q.set('page', String(page.value))
        q.set('limit', String(limit.value))
        const fv = f.value
        if (fv.rule_id) q.set('rule_id', String(fv.rule_id))
        if (fv.changed_by_user_id) q.set('changed_by_user_id', String(fv.changed_by_user_id))
        if (fv.change_type) q.set('change_type', fv.change_type)
        if (fv.from) q.set('from', fv.from)
        if (fv.to) q.set('to', fv.to)

        const resp = await authFetch(`/api/admin/rule-history?${q.toString()}`)
        const data = await resp.json()
        if (!resp.ok || !data.success) {
          alert(data.error || '加载失败')
          return
        }
        items.value = data.items || []
        total.value = Number(data.total || 0)
      } catch (e) {
        alert(e.message || String(e))
      } finally {
        loading.value = false
      }
    }

    const showFullSnapshot = (d) => {
      if (!d?.record) return false
      const t = d.record.change_type
      if (t === 'CREATE' || t === 'DELETE') return true
      const ch = d.diff?.changes
      if ((t === 'UPDATE' || t === 'TOGGLE') && (!Array.isArray(ch) || ch.length === 0)) return true
      return false
    }

    function syncDateRangeFromFilters() {
      const from = f.value.from
      const to = f.value.to
      if (from && to) {
        dateRange.value = [dayjs(from).startOf('day').toDate(), dayjs(to).startOf('day').toDate()]
      } else {
        dateRange.value = null
      }
    }

    /** @param {unknown} modelData */
    function onDateRangeUpdate(modelData) {
      if (!modelData || !Array.isArray(modelData) || modelData.length < 2 || !modelData[0] || !modelData[1]) {
        f.value.from = ''
        f.value.to = ''
        return
      }
      f.value.from = dayjs(modelData[0]).format('YYYY-MM-DD')
      f.value.to = dayjs(modelData[1]).format('YYYY-MM-DD')
    }

    /** @param {'today'|'yesterday'|'last7'|'last30'|'last90'} key */
    function presetRange(key) {
      const today = dayjs()
      if (key === 'today') {
        f.value.from = today.format('YYYY-MM-DD')
        f.value.to = today.format('YYYY-MM-DD')
      } else if (key === 'yesterday') {
        const y = today.subtract(1, 'day')
        f.value.from = y.format('YYYY-MM-DD')
        f.value.to = y.format('YYYY-MM-DD')
      } else if (key === 'last7') {
        f.value.from = today.subtract(6, 'day').format('YYYY-MM-DD')
        f.value.to = today.format('YYYY-MM-DD')
      } else if (key === 'last30') {
        f.value.from = today.subtract(29, 'day').format('YYYY-MM-DD')
        f.value.to = today.format('YYYY-MM-DD')
      } else if (key === 'last90') {
        f.value.from = today.subtract(89, 'day').format('YYYY-MM-DD')
        f.value.to = today.format('YYYY-MM-DD')
      }
      syncDateRangeFromFilters()
    }

    /** 双帧 yield，便于浏览器先绘制「正在解析」再跑同步叙述，减轻视觉闪烁 */
    function yieldTwoFrames() {
      return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      })
    }

    const closeDetail = () => {
      detailModalOpen.value = false
      detailPhase.value = 'idle'
      detailPayload.value = null
      detailOpenId.value = null
      detailViewOk.value = true
    }

    const openDetail = async (id) => {
      detailModalOpen.value = true
      detailOpenId.value = id
      detailPhase.value = 'fetch'
      detailPayload.value = null
      try {
        const resp = await authFetch(`/api/admin/rule-history/${id}`)
        const data = await resp.json()
        if (!resp.ok || !data.success) {
          closeDetail()
          alert(data.error || '加载详情失败')
          return
        }
        detailPhase.value = 'parse'
        await nextTick()
        await yieldTwoFrames()
        let ok = true
        try {
          const rows = sortRuleHistoryChanges(data)
          for (const ch of rows) {
            formatDiffColumnBefore(ch, data)
            formatDiffColumnAfter(ch, data)
          }
          buildDetailNarrativeLines(data)
        } catch (err) {
          console.error('[AdminRuleHistory] 详情叙述流水线失败', err)
          ok = false
        }
        detailViewOk.value = ok
        detailPayload.value = { ...data }
        detailPhase.value = 'ready'
      } catch (e) {
        closeDetail()
        alert(e.message || String(e))
      }
    }

    onMounted(() => {
      syncDateRangeFromFilters()
      load(1)
    })

    return {
      items,
      total,
      page,
      limit,
      loading,
      detailPayload,
      detailModalOpen,
      detailPhase,
      detailOpenId,
      dateRange,
      onDateRangeUpdate,
      presetRange,
      closeDetail,
      detailViewOk,
      formatDiffColumnBefore,
      formatDiffColumnAfter,
      enrichedDiffChanges,
      f,
      totalPages,
      typeLabel,
      typeClass,
      formatTime,
      stringify,
      load,
      openDetail,
      showFullSnapshot
    }
  }
}
</script>

<style scoped>
.admin-page {
  max-width: 1200px;
  width: 100%;
  margin: 0 auto;
}
.page-header h2 {
  margin: 0 0 4px;
  font-size: 24px;
  color: var(--text-primary);
}
.sub {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--text-secondary);
}
.card {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  padding: 16px;
  margin-bottom: 16px;
}
.filters .filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  align-items: flex-end;
  font-size: 13px;
}
.filters label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--text-secondary);
}
.inp {
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  min-width: 120px;
}
.select {
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  min-width: 100px;
}
.loading,
.empty {
  padding: 24px;
  color: var(--text-secondary);
  text-align: center;
}
.table-container {
  overflow-x: auto;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
}
.data-table th,
.data-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--bg-body);
  text-align: left;
}
.data-table th {
  font-size: 13px;
  color: var(--text-secondary);
}
.mono {
  font-family: ui-monospace, monospace;
  font-size: 13px;
}
.small {
  font-size: 12px;
}
.tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}
.tag.create { background: rgba(34, 197, 94, 0.15); color: #15803d; }
.tag.update { background: rgba(59, 130, 246, 0.15); color: #1d4ed8; }
.tag.toggle { background: rgba(234, 179, 8, 0.2); color: #a16207; }
.tag.delete { background: rgba(239, 68, 68, 0.12); color: #b91c1c; }
.pager {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  font-size: 13px;
  color: var(--text-secondary);
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 16px;
  overflow-y: auto;
}
.modal {
  width: 100%;
  max-width: 900px;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.modal-head h3 {
  margin: 0;
  font-size: 18px;
}
.modal-body {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.date-range-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 260px;
}
.date-range-label {
  font-size: 12px;
  color: var(--text-secondary);
}
.date-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.btn.tiny {
  padding: 4px 8px;
  font-size: 12px;
}
.date-range-picker {
  width: 100%;
  max-width: 320px;
}
.detail-loading {
  padding: 32px 16px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 14px;
}
.narrative-scroll {
  max-height: min(40vh, 360px);
  overflow-y: auto;
  margin-bottom: 12px;
}
.narrative-list {
  margin: 0;
  padding-left: 1.25rem;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-primary);
}
.narrative-list li {
  margin-bottom: 6px;
}
.json-details {
  margin-top: 8px;
  margin-bottom: 16px;
}
.json-details summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.json-pre-inner {
  max-height: min(36vh, 320px);
}
.narrative-scroll .json-pre.full {
  max-height: none;
}
.meta {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 8px 12px;
  font-size: 14px;
  margin-bottom: 16px;
}
.meta dt {
  color: var(--text-secondary);
}
.notice {
  padding: 10px 12px;
  background: rgba(59, 130, 246, 0.08);
  border-radius: var(--radius-md);
  font-size: 13px;
  margin-bottom: 16px;
}
.diff-block {
  margin-bottom: 20px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 12px;
}
.diff-title {
  font-weight: 600;
  margin-bottom: 8px;
  font-size: 14px;
}
.diff-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
@media (max-width: 700px) {
  .diff-cols {
    grid-template-columns: 1fr;
  }
}
.diff-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}
.json-pre {
  margin: 0;
  padding: 10px;
  background: var(--bg-body);
  border-radius: var(--radius-md);
  font-size: 11px;
  overflow-x: auto;
  max-height: 240px;
  white-space: pre-wrap;
  word-break: break-word;
}
.json-pre.full {
  max-height: 400px;
}
h4 {
  margin: 16px 0 8px;
  font-size: 15px;
}
.diff-h4 {
  margin: 12px 0 10px;
  font-size: 15px;
  color: var(--text-primary);
}
.diff-field-card {
  margin-bottom: 14px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 12px;
  background: var(--bg-card);
}
.diff-container {
  display: flex;
  gap: 16px;
  align-items: stretch;
}
.diff-column {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  border-radius: var(--radius-md);
}
.diff-column--before {
  background: #f4f4f5;
}
.diff-column--after {
  background: #e8f8ec;
}
.diff-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-primary);
}
@media (max-width: 640px) {
  .diff-container {
    flex-direction: column;
  }
}
.raw-fallback summary {
  color: #b45309;
}

/* 集合类：双栏下方的「增减摘要」，与全量双栏分开排版 */
.delta-summary {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  border: 1px dashed var(--border-color);
  background: rgba(0, 0, 0, 0.02);
}
.delta-summary-title {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 10px;
  font-weight: 600;
}
.delta-block {
  margin-bottom: 10px;
}
.delta-block:last-child {
  margin-bottom: 0;
}
.delta-block-label {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
}
.delta-block-label--add {
  color: #15803d;
}
.delta-block-label--remove {
  color: #b91c1c;
}
.delta-block-body {
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}
.delta-exclude-layer {
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
}
.delta-exclude-layer:last-child {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}
.delta-exclude-layer-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-primary);
}
.delta-none {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}
.delta-tba-section {
  margin-bottom: 12px;
}
.delta-tba-section:last-child {
  margin-bottom: 0;
}
.delta-tba-heading {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--text-secondary);
}
.delta-tba-line {
  font-size: 13px;
  margin-bottom: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
}
.delta-tba-act {
  font-weight: 600;
  color: var(--text-primary);
}
.delta-tba-ids {
  color: var(--text-primary);
}
.delta-tba-bucket {
  margin-bottom: 10px;
  padding-left: 8px;
  border-left: 2px solid var(--border-color);
}
.delta-tba-bucket .delta-block {
  margin-bottom: 6px;
}
</style>
