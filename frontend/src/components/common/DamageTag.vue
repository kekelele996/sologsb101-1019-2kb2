<script setup lang="ts">
/**
 * <DamageTag> 破损类型标签
 * 按虫蛀 / 酸化 / 絮化 / 缺肉 / 水渍渲染底色与图标；
 * 被古籍页、书叶页、工序页消费。
 */
import { computed } from 'vue'
import { Cloudy, Moon, Scissor, Sunny, WarningFilled } from '@element-plus/icons-vue'
import { DAMAGE_TYPE_COLOR, DAMAGE_TYPE_ICON, DAMAGE_TYPE_LABEL, type DamageType } from '@/types/leaf'

const props = withDefaults(
  defineProps<{
    type: DamageType
    /** 是否显示图标，默认显示 */
    showIcon?: boolean
    size?: 'default' | 'small'
    /** 附带的补充文案，如面积 */
    note?: string
  }>(),
  { showIcon: true, size: 'default', note: '' }
)

const iconMap = { Sunny, WarningFilled, Cloudy, Scissor, Moon }

const color = computed(() => DAMAGE_TYPE_COLOR[props.type])
const label = computed(() => DAMAGE_TYPE_LABEL[props.type])
const icon = computed(() => iconMap[DAMAGE_TYPE_ICON[props.type] as keyof typeof iconMap] ?? Sunny)
</script>

<template>
  <el-tag
    class="damage-tag"
    :class="{ 'is-small': size === 'small' }"
    :style="{ background: `${color}1f`, color, borderColor: `${color}66` }"
    effect="plain"
    round
  >
    <el-icon v-if="showIcon" class="damage-tag__icon"><component :is="icon" /></el-icon>
    <span>{{ label }}</span>
    <span v-if="note" class="damage-tag__note">{{ note }}</span>
  </el-tag>
</template>

<style scoped>
.damage-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 500;
}

.damage-tag.is-small {
  height: 20px;
  padding: 0 6px;
  font-size: 12px;
}

.damage-tag__icon {
  font-size: 12px;
}

.damage-tag__note {
  font-size: 12px;
  opacity: 0.8;
}
</style>
