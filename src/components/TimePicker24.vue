<template>
  <div class="time-picker-24">
    <select
      :value="hour"
      @change="onHourChange"
      class="select select-hour"
      aria-label="小时（0-23）"
    >
      <option v-for="h in hourOptions" :key="h" :value="h">{{ String(h).padStart(2, '0') }}</option>
    </select>
    <span class="time-sep">:</span>
    <select
      :value="minute"
      @change="onMinuteChange"
      class="select select-minute"
      aria-label="分钟（0-59）"
    >
      <option v-for="m in minuteOptions" :key="m" :value="m">{{ String(m).padStart(2, '0') }}</option>
    </select>
  </div>
</template>

<script>
import { ref, watch } from 'vue'

/**
 * 24 小时制时间选择器（无 AM/PM）
 * - 入参：modelValue 为 "HH:mm" 字符串
 * - 出参：emit update:modelValue，保证 "HH:mm" 且个位补零
 */
export default {
  name: 'TimePicker24',
  props: {
    modelValue: {
      type: String,
      default: '00:00'
    }
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    // 从 "HH:mm" 或 "HH:mm:00" 解析出 hour/minute（数字）
    const parse = (val) => {
      const s = (val || '').trim()
      const part = s.slice(0, 5) // 只取前 5 位
      const [h, m] = part.split(':').map((n) => Math.max(0, Math.min(59, parseInt(n, 10) || 0)))
      const hour = Number.isFinite(h) && h >= 0 && h <= 23 ? h : 0
      const minute = Number.isFinite(m) && m >= 0 && m <= 59 ? m : 0
      return { hour, minute }
    }

    const { hour: initHour, minute: initMinute } = parse(props.modelValue)
    const hour = ref(initHour)
    const minute = ref(initMinute)

    // 当父组件通过 v-model 变更值时（如回显），同步内部状态
    watch(() => props.modelValue, (val) => {
      const { hour: h, minute: m } = parse(val)
      hour.value = h
      minute.value = m
    })

    const pad = (n) => String(n).padStart(2, '0')
    const commit = () => {
      emit('update:modelValue', `${pad(hour.value)}:${pad(minute.value)}`)
    }

    const onHourChange = (e) => {
      hour.value = Math.max(0, Math.min(23, parseInt(e.target.value, 10) || 0))
      commit()
    }
    const onMinuteChange = (e) => {
      minute.value = Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0))
      commit()
    }

    const hourOptions = Array.from({ length: 24 }, (_, i) => i)
    const minuteOptions = Array.from({ length: 60 }, (_, i) => i)

    return {
      hour,
      minute,
      hourOptions,
      minuteOptions,
      onHourChange,
      onMinuteChange
    }
  }
}
</script>

<style scoped>
.time-picker-24 {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.time-picker-24 .select {
  padding: 8px 10px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  font-size: 14px;
  min-width: 0;
}
.select-hour { width: 64px; }
.select-minute { width: 64px; }
.time-sep {
  font-weight: 600;
  color: var(--text-secondary, #6b7280);
  user-select: none;
}
</style>
