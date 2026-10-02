<script setup lang="ts">
/**
 * <EmptyPanel> 空数据引导与新建入口
 * 被全部列表页消费；层级路由查不到 id 时也用它给出友好空态（不白屏）。
 */
import { Plus } from '@element-plus/icons-vue'

withDefaults(
  defineProps<{
    title: string
    description?: string
    /** 主操作按钮文案；不传则不渲染 */
    actionText?: string
    /** 次操作按钮文案（如「返回列表」） */
    secondaryText?: string
    size?: 'default' | 'small'
  }>(),
  {
    description: '',
    actionText: '',
    secondaryText: '',
    size: 'default'
  }
)

const emit = defineEmits<{
  (event: 'action'): void
  (event: 'secondary'): void
}>()
</script>

<template>
  <div class="empty-panel" :class="{ 'is-small': size === 'small' }">
    <el-empty :image-size="size === 'small' ? 60 : 84">
      <template #description>
        <p class="empty-panel__title">{{ title }}</p>
        <p v-if="description" class="empty-panel__desc">{{ description }}</p>
      </template>
      <div class="empty-panel__actions">
        <el-button v-if="actionText" type="primary" :icon="Plus" @click="emit('action')">{{ actionText }}</el-button>
        <el-button v-if="secondaryText" @click="emit('secondary')">{{ secondaryText }}</el-button>
      </div>
      <slot name="extra" />
    </el-empty>
  </div>
</template>

<style scoped>
.empty-panel {
  padding: 36px 24px;
  text-align: center;
  background: #ffffff;
  border: 1px dashed #d8cbb4;
  border-radius: 10px;
}

.empty-panel.is-small {
  padding: 18px 12px;
}

.empty-panel__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #2f2a24;
}

.empty-panel__desc {
  margin: 4px 0 0;
  font-size: 13px;
  color: #8c8479;
}

.empty-panel__actions {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
}
</style>
