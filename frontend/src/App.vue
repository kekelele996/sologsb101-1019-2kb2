<script setup lang="ts">
/**
 * 应用外壳：品牌头 + 胶囊导航 + 页脚统计
 * 首屏初始化 IndexedDB（首次自动播种演示数据）并载入 Pinia store。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Brush, Document, Files, Reading, Tools } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useRepairStore } from '@/stores/repairStore'
import { initDatabase } from '@/utils/db'
import { useLeafStats } from '@/hooks/useLeafStats'

const route = useRoute()
const router = useRouter()
const bookStore = useBookStore()
const leafStore = useLeafStore()
const repairStore = useRepairStore()
const { totals } = useLeafStats()
const ready = ref(false)

onMounted(async () => {
  try {
    await initDatabase()
    await Promise.all([bookStore.loadBooks(), bookStore.loadVolumes(), leafStore.loadLeaves(), repairStore.loadOrders()])
  } catch (error) {
    ElMessage.error(`本地数据库初始化失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    ready.value = true
  }
})

const navItems = computed(() => {
  const bookId = bookStore.currentBookId
  return [
    { path: '/books', label: '古籍与册次', icon: Reading, badge: String(bookStore.books.length), disabled: false },
    {
      path: bookId ? `/books/${bookId}/leaves` : '/books',
      label: '书叶破损',
      icon: Document,
      badge: String(leafStore.leaves.length),
      disabled: !bookId
    },
    { path: '/papers', label: '补纸选配', icon: Brush, badge: '', disabled: false },
    { path: '/repairs', label: '修复工序', icon: Tools, badge: String(repairStore.totalSteps), disabled: false },
    { path: '/export', label: '装订归档', icon: Files, badge: '', disabled: false }
  ]
})

const activePath = computed(() => (route.path.startsWith('/books/') ? route.path : route.path))

function go(path: string, disabled: boolean): void {
  if (disabled) {
    ElMessage.warning('请先在古籍台账中选择一部古籍')
    return
  }
  void router.push(path)
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="app-header__brand">
        <span class="app-header__mark">修</span>
        <div>
          <h1 class="app-header__title">古籍修复工序与补纸配色档案</h1>
          <p class="app-header__sub">gbbookrestore · 古籍 → 册次 → 书叶 → 补纸 / 工序 / 装订</p>
        </div>
      </div>
      <nav class="app-nav">
        <button
          v-for="item in navItems"
          :key="item.label"
          class="app-nav__item"
          :class="{ 'is-active': activePath === item.path, 'is-disabled': item.disabled }"
          type="button"
          @click="go(item.path, item.disabled)"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
          <em v-if="item.badge && item.badge !== '0'" class="app-nav__badge">{{ item.badge }}</em>
        </button>
      </nav>
    </header>

    <main class="app-main">
      <el-skeleton v-if="!ready" :rows="6" animated />
      <router-view v-else v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>

    <footer class="app-footer">
      <span>数据仅存于本浏览器（IndexedDB / localStorage），不上传任何服务器。</span>
      <span>
        破损记录 {{ totals.recordCount }} 条 · 总面积 {{ totals.totalAreaCm2 }} cm² · 平均 pH
        {{ totals.averagePh }} · 工序完成率 {{ totals.orderPercent }}%
      </span>
    </footer>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.app-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 24px;
  background: linear-gradient(120deg, #2f3b56 0%, #3a4a6b 55%, #56617c 100%);
  color: #f6f2e8;
}

.app-header__brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-header__mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.3);
  font-size: 20px;
  font-weight: 700;
}

.app-header__title {
  margin: 0;
  font-size: 18px;
  letter-spacing: 2px;
}

.app-header__sub {
  margin: 2px 0 0;
  font-size: 12px;
  letter-spacing: 1px;
  color: rgba(246, 242, 232, 0.75);
}

.app-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.app-nav__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #f6f2e8;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.app-nav__item:hover {
  background: rgba(255, 255, 255, 0.16);
}

.app-nav__item.is-active {
  background: #f6f2e8;
  color: #3a4a6b;
  font-weight: 600;
}

.app-nav__item.is-disabled {
  opacity: 0.45;
}

.app-nav__badge {
  font-style: normal;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.18);
}

.app-main {
  flex: 1;
  width: 100%;
  max-width: 1360px;
  margin: 0 auto;
  padding: 20px 24px 32px;
}

.app-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 24px 20px;
  font-size: 12px;
  color: #8c8479;
}
</style>
