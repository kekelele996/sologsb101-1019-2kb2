/**
 * 路由表（与提示词逐字一致）
 * /books、/books/:id/leaves、/papers、/repairs、/export
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/books'
  },
  {
    path: '/books',
    name: 'book-list',
    component: () => import('@/pages/BookList.vue'),
    meta: { title: '古籍与册次台账', icon: 'Reading' }
  },
  {
    path: '/books/:id/leaves',
    name: 'leaf-board',
    component: () => import('@/pages/LeafBoard.vue'),
    meta: { title: '书叶破损登记', icon: 'Document' }
  },
  {
    path: '/papers',
    name: 'paper-match',
    component: () => import('@/pages/PaperMatch.vue'),
    meta: { title: '补纸选配与染色', icon: 'Brush' }
  },
  {
    path: '/repairs',
    name: 'repair-workflow',
    component: () => import('@/pages/RepairWorkflow.vue'),
    meta: { title: '修复工序记录', icon: 'Tools' }
  },
  {
    path: '/export',
    name: 'export-view',
    component: () => import('@/pages/ExportView.vue'),
    meta: { title: '装订验收与归档', icon: 'Files' }
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/books'
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '古籍修复工序与补纸配色档案'
  document.title = `${title} · 古籍修复工序与补纸配色档案`
})

export default router
