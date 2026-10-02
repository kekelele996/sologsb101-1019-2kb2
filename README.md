# 古籍修复工序与补纸配色档案（gbbookrestore）

面向图书馆古籍修复室修复师的本地化档案工具：按叶登记破损状况、选配补纸并逐道记录修复工序，最终还原装订形式并归档验收结论。

核心动作：**建立古籍与册次 → 逐叶登记破损类型与面积 → 选配补纸并做染色比对 → 记录补破托裱等工序 → 登记装订还原与验收归档**。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据）。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22819**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbbookrestore}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地；迁移设备请使用 `/export` 页的「导出 / 导入 JSON 备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 页面按路由懒加载 |
| 语言 | TypeScript（`strict: true`，`noUnusedLocals`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、表单、对话框、单选按钮组、空态 |
| 构建工具 | Vite 6 | 开发服务器端口 22819 |
| 状态管理 | Pinia（setup store） | `bookStore` / `leafStore` / `repairStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 含数据结构版本号与 v1→v2 升级迁移 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段类型检查 + 打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22819
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22819）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、页面与路由

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/books` | 古籍与册次台账 | 新建古籍、按年代与保护级别筛选（同步 URL query），对话框内管理册次，装订完成后整册锁定只读 | Book、Volume |
| `/books/:id/leaves` | 书叶破损登记 | 册次切换、逐叶录入破损类型（可叠加）、面积与 pH，批量改状态；**直接深链不存在的 id 显示友好空态** | Leaf、Volume |
| `/papers` | 补纸选配与染色比对 | 按 ΔE 升序排列候选补纸、帘纹匹配度与综合评分，ΔE 超阈值提示重新染色 | Paper、Leaf |
| `/repairs` | 修复工序记录 | 拖拽调整工序先后并重编号、回填材料与操作人，完成即回写书叶状态，一键生成标准序列 | RepairOrder、Leaf |
| `/export` | 装订还原与验收归档 | 装订登记 + 验收结论（合格触发全册归档）、JSON 导入导出、归档清单与破损台账 CSV | Binding 及全部模型 |

`/` 与未匹配路径重定向到 `/books`。筛选条件写入 URL query（`?kw=&damageType=&state=` 等），可从任意设备复用链接。

---

## 五、数据模型

| 模型 | 文件 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| Book 古籍 | `src/types/book.ts` | `id` `title` `edition` `era` `volumeCount` `collectionNo` `level`（一级/二级/三级/普通） | 新建后进入册次登记，卡片回显待修叶数与已完成工序数 |
| Volume 册次 | `src/types/volume.ts` | `id` `bookId` `volumeNo` `leafCount` `bindingType`（线装/蝴蝶装/包背装） `state`（待修复/修复中/已装订/已归档） `revision`（修订号） | 装订完成后整册锁定为只读；修订号用于并发乐观锁，保存时比对版本，冲突则报告对方改了哪几条而不覆盖 |
| Leaf 书叶 | `src/types/leaf.ts` | `id` `volumeId` `leafNo` `damageType`（虫蛀/酸化/絮化/缺肉/水渍） `damageAreaCm2` `phValue` `state`（待修/修复中/已修复） | 同叶可叠加多种破损，按册汇总面积与平均 pH |
| Paper 补纸 | `src/types/paper.ts` | `id` `leafId` `paperType`（竹纸/皮纸/宣纸） `laidPattern` `thicknessMm` `deltaE` `dyeRecipe` | 按色差排序候选，ΔE 超阈值提示重新染色 |
| RepairOrder 修复工序 | `src/types/repairOrder.ts` | `id` `leafId` `seq` `name`（补破/托裱/溜口/裁齐/压平） `material` `operator` `date` `state`（未开始/进行中/已完成） | 拖拽调序，完成即回写书叶状态 |
| Binding 装订 | `src/types/binding.ts` | `id` `volumeId` `method` `finishDate` `verdict`（合格/返修） `inspector` | 合格触发全册归档，返修退回修复中 |

数据结构版本号 `DB_VERSION` 定义在 `src/utils/db.ts`，当前为 `v3`：
- `v1 → v2`：`papers` 表增加 `dyeRecipe` 字段，并在 Dexie `.upgrade()` 中按纸种回填默认染色配方（竹纸 / 皮纸 / 宣纸 各有基准配方）。
- `v2 → v3`：`volumes` 表增加 `revision` 修订号字段，并新增 `volumeChanges` 变更日志表（按册记录每次改动，供并发冲突时回放「哪几条已被更新」）。升级时对缺修订号的册按归档状态补齐：已归档册 `revision = 2`，其余 `revision = 1`。

### 并发乐观锁（修订号机制）

修复室常开两个窗口并发做同一部书：一个窗口登记书叶破损和补纸，另一个窗口排修复工序。为避免后保存的窗口盖掉对方刚填的内容，每册（Volume）带有修订号 `revision`：

1. **捕获版本**：打开编辑表单时，捕获当前册次的修订号作为 `baseRevision`。
2. **保存比对**：保存时在事务中比对册次当前修订号与 `baseRevision`。
   - 一致 → 执行写入，记录变更日志，修订号 +1。
   - 不一致 → 返回冲突信息，**不覆盖对方结果**，并列出对方在 `(baseRevision, 当前修订号]` 区间内做的改动。
3. **归档锁定**：册次归档后整册锁定为只读，普通编辑（书叶 / 补纸 / 工序 / 册次信息）一律禁止；仅验收人可在 `/export` 页通过「验收返修」将册次退回修复中。

冲突提示文案由 `src/utils/revision.ts` 的 `formatConflictMessage()` 生成，列出对方更新的条目与动作（新增 / 修改 / 删除）。

---

## 六、目录结构

```
sologsb101-1019/
├── frontend/                     # 前端源码
│   ├── src/
│   │   ├── types/                # book.ts volume.ts leaf.ts paper.ts repairOrder.ts binding.ts
│   │   ├── stores/               # bookStore.ts leafStore.ts repairStore.ts
│   │   ├── components/common/    # DamageTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
│   │   ├── hooks/                # useLeafStats.ts useIdbTable.ts
│   │   ├── pages/                # BookList.vue LeafBoard.vue PaperMatch.vue RepairWorkflow.vue ExportView.vue
│   │   ├── router/               # index.ts
│   │   ├── utils/                # paperColor.ts db.ts export.ts revision.ts
│   │   ├── styles/               # main.css
│   │   ├── App.vue main.ts env.d.ts
│   ├── public/favicon.svg
│   ├── index.html package.json tsconfig.json vite.config.ts
│   ├── Dockerfile                # 多阶段构建（node:20-alpine → nginx:alpine）
│   ├── nginx.conf                # SPA fallback + gzip + 静态资源缓存
│   └── .dockerignore
├── docker-compose.yml            # 顶层 name、container_name、端口映射
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── README.md
```

分层约定：页面只读 Pinia store，跨页状态不留在组件内部 `ref`；IndexedDB 读写统一走 `useIdbTable()`（`liveQuery` 响应式订阅）；筛选条件与 URL query 通过 `FilterBar.vue` 导出的 `useFilterQuery()` 同步。

---

## 七、数据存储说明

- **IndexedDB（Dexie，数据库名 `gbbookrestore`）**：6 张业务表 `books` / `volumes` / `leaves` / `papers` / `repairOrders` / `bindings`，由 `src/utils/db.ts` 统一定义 schema、版本号与升级迁移；`initDatabase()` 首次打开时自动播种**三层互相引用**的演示数据（Book → Volume → Leaf → Paper / RepairOrder，另有 Volume → Binding，固定 id 如 `book_01`、`vol_0101`、`leaf_010101`），保证 `/books/:id/leaves` 深链能命中真实 id，播种幂等。
- **localStorage**：仅存元数据 —— `gbbookrestore:db-version`（本地结构版本）、`gbbookrestore:last-backup-at`（最近导出时间）、`gbbookrestore:ui-prefs`（当前古籍 / 册次、工序排序方式）。
- **备份**：`/export` 页可导出 JSON（6 张表全量数据 + 结构版本号），导入时校验 `app` 字段与各集合数组完整性，覆盖导入前二次确认；另有归档清单 TXT 与书叶破损台账 CSV。
- **隐私与无状态**：数据不上传任何服务器，容器不挂载命名卷；清理浏览器站点数据或更换浏览器会丢失档案，请定期导出备份。

---

## 八、开发提示

- 类型检查与构建：`cd frontend && npm run build`（含 `vue-tsc --noEmit`，必须零错误）。
- 端口一致性：开发服务器（`vite.config.ts`）、预览服务、compose 的 `FRONTEND_PORT` 默认值均为 `22819`。
- 若部署在中文路径下，`docker-compose.yml` 顶层的 `name: gbbookrestore` 可保证项目名不为空，`docker compose config --quiet` 不会报错。
- 容器运行阶段执行了 `RUN chmod -R a+rX /usr/share/nginx/html`，避免宿主机静态资源权限为 0600 时 nginx worker 读取失败返回 403。
