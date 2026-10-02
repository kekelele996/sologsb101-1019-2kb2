<script lang="ts">
/**
 * 筛选条 query 同步辅助（非 setup 模块导出）
 * 把筛选条件读写同步到 URL query，页面里再用 watchEffect 写回 Pinia store。
 * keys 必须是模块级常量数组，保证引用稳定。
 */
import { computed as vueComputed, type ComputedRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'

export interface FilterQueryState {
  keyword: ComputedRef<string>
  values: ComputedRef<Record<string, string[]>>
  setKeyword: (value: string) => void
  setValues: (key: string, list: string[]) => void
  /** 一次性写入多个 query key（原子更新，避免多次 replace 互相覆盖） */
  apply: (patch: Record<string, string | string[]>) => void
  reset: () => void
}

export function useFilterQuery(keys: readonly string[]): FilterQueryState {
  const route = useRoute()
  const router = useRouter()

  const keyword = vueComputed<string>(() => (typeof route.query.kw === 'string' ? route.query.kw : ''))

  const values = vueComputed<Record<string, string[]>>(() => {
    const result: Record<string, string[]> = {}
    keys.forEach((key) => {
      const raw = route.query[key]
      result[key] = typeof raw === 'string' && raw.length > 0 ? raw.split(',').filter((item) => item.length > 0) : []
    })
    return result
  })

  const update = (patch: Record<string, string | string[] | undefined>): void => {
    const next: Record<string, string> = {}
    Object.entries(route.query).forEach(([key, value]) => {
      if (typeof value === 'string') next[key] = value
    })
    Object.entries(patch).forEach(([key, value]) => {
      if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
        delete next[key]
      } else {
        next[key] = Array.isArray(value) ? value.join(',') : value
      }
    })
    void router.replace({ query: next })
  }

  return {
    keyword,
    values,
    setKeyword: (value: string) => update({ kw: value }),
    setValues: (key: string, list: string[]) => update({ [key]: list }),
    apply: (patch: Record<string, string | string[]>) => update(patch),
    reset: () => {
      void router.replace({ query: {} })
    }
  }
}
</script>

<script setup lang="ts">
/**
 * <FilterBar> 筛选条
 * 关键字 + 多选下拉过滤并同步 URL query；被古籍页、补纸页、工序页消费。
 */
import { computed } from 'vue'
import { Refresh, Search } from '@element-plus/icons-vue'

export interface FilterSelectOption {
  label: string
  value: string
}

export interface FilterSelectConfig {
  /** query key，同时作为组件内唯一标识 */
  key: string
  label: string
  options: FilterSelectOption[]
  placeholder?: string
  /** 多选（默认）或单选 */
  multiple?: boolean
}

export interface FilterModel {
  keyword: string
  [key: string]: string | string[] | boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: FilterModel
    selects?: FilterSelectConfig[]
    keywordPlaceholder?: string
    /** 右上方附加操作区（如日期区间） */
    showReset?: boolean
  }>(),
  {
    selects: () => [],
    keywordPlaceholder: '搜索关键字…',
    showReset: true
  }
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: FilterModel): void
  (event: 'change', value: FilterModel): void
  (event: 'reset'): void
}>()

const activeCount = computed(() => {
  const entries = Object.entries(props.modelValue).filter(([key]) => key !== 'keyword')
  return entries.reduce((sum, [, value]) => {
    if (Array.isArray(value)) return sum + value.length
    if (typeof value === 'string' && value.length > 0) return sum + 1
    if (typeof value === 'boolean' && value) return sum + 1
    return sum
  }, 0)
})

function emitChange(next: FilterModel): void {
  emit('update:modelValue', next)
  emit('change', next)
}

function handleKeywordInput(value: string): void {
  emitChange({ ...props.modelValue, keyword: value })
}

function handleSelect(key: string, value: string | string[]): void {
  emitChange({ ...props.modelValue, [key]: value })
}

function handleReset(): void {
  const cleared: FilterModel = { keyword: '' }
  props.selects.forEach((select) => {
    cleared[select.key] = select.multiple === false ? '' : []
  })
  emit('update:modelValue', cleared)
  emit('change', cleared)
  emit('reset')
}

function valueOf(key: string): string | string[] {
  const value = props.modelValue[key]
  if (Array.isArray(value)) return value
  return typeof value === 'string' ? value : ''
}
</script>

<template>
  <div class="filter-bar">
    <div class="filter-bar__main">
      <el-input
        :model-value="modelValue.keyword"
        class="filter-bar__keyword"
        :placeholder="keywordPlaceholder"
        clearable
        @update:model-value="handleKeywordInput"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>

      <div v-for="select in selects" :key="select.key" class="filter-bar__select">
        <span class="filter-bar__label">{{ select.label }}</span>
        <el-select
          :model-value="valueOf(select.key)"
          :multiple="select.multiple !== false"
          :collapse-tags="select.multiple !== false"
          collapse-tags-tooltip
          clearable
          :placeholder="select.placeholder ?? `选择${select.label}`"
          class="filter-bar__control"
          @update:model-value="(value: string | string[]) => handleSelect(select.key, value)"
        >
          <el-option v-for="option in select.options" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
      </div>

      <slot name="extra" />
    </div>

    <div class="filter-bar__side">
      <slot name="actions" />
      <el-tag v-if="activeCount > 0" type="warning" effect="plain" round>{{ activeCount }} 项条件</el-tag>
      <el-button v-if="showReset" :icon="Refresh" text type="primary" @click="handleReset">重置</el-button>
    </div>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  background: #ffffff;
  border: 1px solid #e6e0d6;
  border-radius: 10px;
}

.filter-bar__main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  flex: 1 1 520px;
}

.filter-bar__side {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-bar__keyword {
  width: 220px;
}

.filter-bar__label {
  margin-right: 6px;
  font-size: 13px;
  color: #6b6257;
}

.filter-bar__select {
  display: flex;
  align-items: center;
}

.filter-bar__control {
  width: 180px;
}
</style>
