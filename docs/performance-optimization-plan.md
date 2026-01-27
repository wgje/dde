# NanoFlow 性能优化策划案

> **文档版本**: v1.0  
> **创建日期**: 2026-01-26  
> **审核状态**: 待实施  
> **预期总收益**: 首屏加载时间减少 60-70%（从 ~6s 降至 ~2s）

---

## 📊 一、性能诊断摘要

### 1.1 核心指标（Chrome DevTools 实测）

| 指标 | 当前值 | 目标值 | 差距 |
|------|--------|--------|------|
| **LCP (最大内容绘制)** | 1,179 ms | < 1,000 ms | ⚠️ 需优化 |
| **CLS (累积布局偏移)** | 0.00 | < 0.1 | ✅ 已达标 |
| **TTFB (首字节时间)** | 15 ms | < 200 ms | ✅ 已达标 |
| **关键路径延迟** | 5,959 ms | < 2,000 ms | ❌ 严重超标 |
| **API 请求数** | 21 个 | < 5 个 | ❌ 严重超标 |
| **字体资源大小** | 1.2 MB | < 300 KB | ⚠️ 需优化 |

### 1.2 根因分析

```
                    ┌─────────────────────────────────────────────────────┐
                    │              页面加载瀑布流分析                        │
                    └─────────────────────────────────────────────────────┘
                    
HTML (334ms) ──► main.js (513ms) ──► chunk-N3MMGV7R.js (703ms)
                                              │
                    ┌─────────────────────────┴─────────────────────────┐
                    │              API 请求瀑布流（阻塞 5.9 秒）            │
                    ├───────────────────────────────────────────────────┤
                    │ projects (owner_id)         ──────────────► 3.1s  │
                    │   └─► projects (id × 3)     ──────────────► 3.4s  │
                    │       └─► tasks (× 3)       ──────────────► 3.5s  │
                    │           └─► connections (× 3) ──────────► 3.8s  │
                    │               └─► task_tombstones (× 6)    5.9s  │
                    └───────────────────────────────────────────────────┘
```

**核心问题**：
1. **API 请求瀑布流**：每个项目需要 4+ 个顺序请求，串行等待
2. **全量加载策略**：同时加载所有 3 个项目的完整数据
3. **Supabase 冷启动**：ap-south-1 区域首次请求延迟高
4. **字体资源过大**：LXGW 文楷 16 个子集文件共 1.2 MB

---

## 🎯 二、优化方案总览

### 2.1 优先级矩阵

| 优先级 | 方案 | 预期收益 | 实施成本 | 风险等级 |
|--------|------|----------|----------|----------|
| **P0** | 创建批量查询 RPC 函数 | -4,000 ms | 中 | 低 |
| **P0** | 首屏优先加载策略 | -2,500 ms | 低 | 低 |
| **P1** | CSS 骨架屏增强 | 感知性能 +50% | 低 | 极低 |
| **P1** | GoJS 批量渲染优化 | -300 ms | 低 | 低 |
| **P2** | 字体资源优化 | -500 ms | 中 | 低 |
| **P2** | Service Worker 缓存策略 | 重复访问 -80% | 低 | 低 |
| **P3** | 移除无用 Preconnect | -50 ms | 极低 | 极低 |
| **P3** | 清理未使用索引 | DB 写入 +5% | 极低 | 低 |

### 2.2 实施阶段规划

```
Phase 1 (立即实施) ─────────────────────────────────────────────────
  ├── P3: 移除无用 Sentry Preconnect           [0.5h] ✅ 可验证
  ├── P1: 增强 CSS 骨架屏动画                   [1h]   ✅ 可验证
  └── P3: 清理未使用数据库索引                  [0.5h] ✅ 可验证

Phase 2 (本周完成) ─────────────────────────────────────────────────
  ├── P0: 创建 get_full_project_data RPC       [2h]   ✅ 可验证
  ├── P0: 实现首屏优先加载策略                  [3h]   ✅ 可验证
  └── P0: 前端调用 RPC 替代多次查询             [2h]   ✅ 可验证

Phase 3 (下周完成) ─────────────────────────────────────────────────
  ├── P1: GoJS 批量渲染优化                    [2h]   ✅ 可验证
  ├── P2: Service Worker 缓存策略              [2h]   ✅ 可验证
  └── P2: 字体资源本地化/子集化                [4h]   ⚠️ 需测试
```

---

## 🔧 三、详细实施方案

### 3.1 【P0】创建批量查询 RPC 函数

#### 3.1.1 问题分析

**当前请求流程**（per project × 3 projects = 12+ 请求）：
```typescript
// 现有代码：simple-sync.service.ts L4237-4300
async loadProjectsFromCloud(userId) {
  const projectList = await client.from('projects').select(...);     // 请求 1
  
  for (const project of projectList) {
    await this.loadFullProject(project.id, userId);                  // × 3 项目
  }
}

async loadFullProject(projectId) {
  const projectData = await client.from('projects').select(...);     // 请求 2,5,8
  const tasks = await this.pullTasksThrottled(projectId);            // 请求 3,6,9 (含 tombstones)
  const connections = await client.from('connections').select(...);  // 请求 4,7,10
}
```

#### 3.1.2 解决方案：创建服务端 RPC 函数

**数据库迁移文件**：

```sql
-- supabase/migrations/20260126_batch_load_optimization.sql

-- ============================================
-- 性能优化：批量加载 RPC 函数
-- 将 N+1 查询合并为单次 RPC 调用
-- 预期收益：API 请求从 12+ 降至 1-2 个
-- ============================================

-- 1. 单项目完整数据加载（用于首屏加载）
CREATE OR REPLACE FUNCTION public.get_full_project_data(
  p_project_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  -- 获取当前用户 ID
  v_user_id := auth.uid();
  
  -- 权限检查：确保用户有权访问该项目
  IF NOT EXISTS (
    SELECT 1 FROM public.projects 
    WHERE id = p_project_id 
    AND (owner_id = v_user_id OR EXISTS (
      SELECT 1 FROM public.project_members 
      WHERE project_id = p_project_id AND user_id = v_user_id
    ))
  ) THEN
    RAISE EXCEPTION 'Access denied to project %', p_project_id;
  END IF;
  
  -- 构建完整项目数据（单次查询）
  SELECT json_build_object(
    'project', (
      SELECT row_to_json(p.*) 
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, version
        FROM public.projects WHERE id = p_project_id
      ) p
    ),
    'tasks', COALESCE((
      SELECT json_agg(row_to_json(t.*))
      FROM (
        SELECT id, title, content, stage, parent_id, "order", rank, status, x, y, 
               updated_at, deleted_at, short_id
        FROM public.tasks 
        WHERE project_id = p_project_id
        ORDER BY stage NULLS LAST, "order"
      ) t
    ), '[]'::json),
    'connections', COALESCE((
      SELECT json_agg(row_to_json(c.*))
      FROM (
        SELECT id, source_id, target_id, title, description, deleted_at, updated_at
        FROM public.connections 
        WHERE project_id = p_project_id
      ) c
    ), '[]'::json),
    'task_tombstones', COALESCE((
      SELECT json_agg(task_id)
      FROM public.task_tombstones 
      WHERE project_id = p_project_id
    ), '[]'::json),
    'connection_tombstones', COALESCE((
      SELECT json_agg(connection_id)
      FROM public.connection_tombstones 
      WHERE project_id = p_project_id
    ), '[]'::json)
  ) INTO v_result;
  
  RETURN v_result;
END;
$$;

-- 2. 批量加载所有项目（用于后台同步）
CREATE OR REPLACE FUNCTION public.get_all_projects_data(
  p_since_timestamp TIMESTAMPTZ DEFAULT '1970-01-01'::TIMESTAMPTZ
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  
  SELECT json_build_object(
    'projects', COALESCE((
      SELECT json_agg(row_to_json(p.*))
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, version
        FROM public.projects 
        WHERE owner_id = v_user_id AND updated_at > p_since_timestamp
        ORDER BY updated_at DESC
      ) p
    ), '[]'::json),
    'server_time', now()
  ) INTO v_result;
  
  RETURN v_result;
END;
$$;

-- 3. 授权 authenticated 角色调用
GRANT EXECUTE ON FUNCTION public.get_full_project_data(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ) TO authenticated;

-- 4. 添加注释
COMMENT ON FUNCTION public.get_full_project_data IS 
  '批量加载单个项目的完整数据（任务、连接、墓碑）- 性能优化 2026-01-26';
COMMENT ON FUNCTION public.get_all_projects_data IS 
  '批量加载用户所有项目的元数据（增量同步）- 性能优化 2026-01-26';
```

#### 3.1.3 前端调用改造

```typescript
// simple-sync.service.ts - 替换 loadFullProject 方法

/**
 * 【性能优化】使用 RPC 批量加载项目数据
 * 将 4+ 个 API 请求合并为 1 个
 */
async loadFullProjectOptimized(projectId: string): Promise<Project | null> {
  const client = this.getSupabaseClient();
  if (!client) return null;

  try {
    const { data, error } = await client.rpc('get_full_project_data', {
      p_project_id: projectId
    });

    if (error) throw supabaseErrorToError(error);
    if (!data?.project) return null;

    // 转换 RPC 返回的数据格式
    const project = this.rowToProject(data.project);
    
    // 过滤 tombstones 中的已删除任务
    const tombstoneSet = new Set(data.task_tombstones || []);
    project.tasks = (data.tasks || [])
      .filter((t: TaskRow) => !tombstoneSet.has(t.id))
      .map((t: TaskRow) => this.rowToTask(t));
    
    project.connections = (data.connections || [])
      .map((c: ConnectionRow) => this.rowToConnection(c));

    return project;
  } catch (e) {
    this.logger.error('批量加载项目失败，回退到顺序加载', e);
    // 降级到原有方法
    return this.loadFullProject(projectId, '');
  }
}
```

#### 3.1.4 验证方案

```bash
# 1. 应用迁移
npx supabase migration up

# 2. 本地测试 RPC
npx supabase functions invoke get_full_project_data \
  --body '{"p_project_id": "f30cfa74-5849-43d5-80df-494eb4c4b031"}'

# 3. 性能对比测试
# 预期：API 请求数从 12+ 降至 2-3 个
```

---

### 3.2 【P0】首屏优先加载策略

#### 3.2.1 问题分析

当前行为：同时加载所有 3 个项目的完整数据
期望行为：
1. 立即加载当前活动项目
2. 渲染 UI
3. 后台静默加载其他项目

#### 3.2.2 实施方案

```typescript
// user-session.service.ts - 修改初始化流程

async initializeUserSession(userId: string): Promise<void> {
  // 1. 优先从本地恢复上次活动的项目 ID
  const lastActiveProjectId = await this.persistence.getLastActiveProjectId([]);
  
  // 2. 首屏优先：只加载当前项目
  if (lastActiveProjectId) {
    this.logger.info('首屏优先加载', { projectId: lastActiveProjectId });
    
    // 使用优化后的 RPC 加载
    const activeProject = await this.syncService.loadFullProjectOptimized(lastActiveProjectId);
    
    if (activeProject) {
      // 立即更新 UI（不等待其他项目）
      this.projectState.setActiveProject(activeProject);
      this.projectState.updateProjectList([activeProject]);
    }
  }
  
  // 3. 后台加载其他项目（使用 requestIdleCallback）
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(async () => {
      await this.loadRemainingProjects(userId, lastActiveProjectId);
    }, { timeout: 5000 });
  } else {
    // 降级：使用 setTimeout
    setTimeout(() => this.loadRemainingProjects(userId, lastActiveProjectId), 100);
  }
}

private async loadRemainingProjects(userId: string, excludeId?: string): Promise<void> {
  const allProjects = await this.syncService.loadProjectsFromCloud(userId);
  const otherProjects = allProjects.filter(p => p.id !== excludeId);
  
  // 合并到项目列表
  this.projectState.mergeProjectList(otherProjects);
}
```

#### 3.2.3 验证指标

| 指标 | 优化前 | 优化后 | 预期提升 |
|------|--------|--------|----------|
| 首屏可交互时间 | ~6s | ~2s | **-67%** |
| 首个项目渲染 | ~6s | ~1.5s | **-75%** |
| 全部项目加载 | ~6s | ~6s | 不变（后台） |

---

### 3.3 【P1】CSS 骨架屏增强

#### 3.3.1 当前状态

现有骨架屏已实现基本功能，需要增强：
1. 添加脉冲动画更流畅
2. 增加侧边栏骨架
3. 模拟真实布局

#### 3.3.2 增强方案

```html
<!-- index.html - 增强骨架屏 -->

<style>
  /* ========== 增强版骨架屏 ========== */
  @keyframes skeleton-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  
  @keyframes skeleton-shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }
  
  .skeleton-shimmer {
    background: linear-gradient(90deg, 
      var(--skeleton-base) 0%, 
      var(--skeleton-highlight) 50%, 
      var(--skeleton-base) 100%);
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.5s ease-in-out infinite;
  }
  
  /* 浅色模式变量 */
  :root {
    --skeleton-base: #e7e5e4;
    --skeleton-highlight: #d6d3d1;
  }
  
  /* 深色模式变量 */
  [data-color-mode="dark"] {
    --skeleton-base: #374151;
    --skeleton-highlight: #4b5563;
  }
  
  /* 骨架屏布局：模拟真实 UI */
  .skeleton-layout {
    display: grid;
    grid-template-columns: 280px 1fr;
    grid-template-rows: 56px 1fr;
    height: 100vh;
    gap: 1px;
    background: var(--skeleton-base);
  }
  
  .skeleton-nav {
    grid-column: 1 / -1;
    height: 56px;
    background: white;
    display: flex;
    align-items: center;
    padding: 0 1rem;
    gap: 1rem;
  }
  
  [data-color-mode="dark"] .skeleton-nav {
    background: #1f2937;
  }
  
  .skeleton-sidebar {
    background: white;
    padding: 1rem;
  }
  
  [data-color-mode="dark"] .skeleton-sidebar {
    background: #111827;
  }
  
  .skeleton-main {
    background: #f9fafb;
    padding: 2rem;
  }
  
  [data-color-mode="dark"] .skeleton-main {
    background: #0f172a;
  }
</style>

<div id="initial-loader">
  <div class="skeleton-layout">
    <!-- 导航栏骨架 -->
    <div class="skeleton-nav">
      <div class="skeleton-shimmer" style="width:120px;height:28px;border-radius:6px;"></div>
      <div class="skeleton-shimmer" style="width:200px;height:36px;border-radius:6px;margin-left:auto;"></div>
      <div class="skeleton-shimmer" style="width:36px;height:36px;border-radius:50%;"></div>
    </div>
    
    <!-- 侧边栏骨架 -->
    <div class="skeleton-sidebar">
      <div class="skeleton-shimmer" style="width:100%;height:40px;border-radius:8px;margin-bottom:1rem;"></div>
      <div class="skeleton-shimmer" style="width:80%;height:24px;border-radius:4px;margin-bottom:0.75rem;"></div>
      <div class="skeleton-shimmer" style="width:60%;height:24px;border-radius:4px;margin-bottom:0.75rem;"></div>
      <div class="skeleton-shimmer" style="width:70%;height:24px;border-radius:4px;"></div>
    </div>
    
    <!-- 主内容区骨架 -->
    <div class="skeleton-main">
      <div class="skeleton-shimmer" style="width:300px;height:32px;border-radius:6px;margin-bottom:2rem;"></div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;">
        <div class="skeleton-shimmer" style="height:200px;border-radius:12px;"></div>
        <div class="skeleton-shimmer" style="height:200px;border-radius:12px;"></div>
        <div class="skeleton-shimmer" style="height:200px;border-radius:12px;"></div>
      </div>
    </div>
  </div>
</div>
```

---

### 3.4 【P3】移除无用 Preconnect

#### 3.4.1 问题分析

性能追踪显示 Sentry preconnect 在页面加载期间未被使用：
```
Warning: Unused preconnect. Only use `preconnect` for origins that the page is likely to request.
  - https://o4508391513718784.ingest.us.sentry.io/
```

#### 3.4.2 实施方案

```diff
<!-- index.html L29-30 -->

-  <!-- 【TTFB 优化】Sentry 预连接 - 减少错误上报延迟 -->
-  <link rel="preconnect" href="https://o4508391513718784.ingest.us.sentry.io">
-  <link rel="dns-prefetch" href="https://o4508391513718784.ingest.us.sentry.io">
+  <!-- Sentry: 仅使用 dns-prefetch，因为首屏不会触发错误上报 -->
+  <link rel="dns-prefetch" href="https://o4508391513718784.ingest.us.sentry.io">
```

---

### 3.5 【P3】清理未使用数据库索引

#### 3.5.1 问题分析

Supabase Performance Advisor 检测到 10 个未使用的索引：

| 表 | 索引 | 状态 |
|-----|------|------|
| task_tombstones | idx_task_tombstones_deleted_by | 从未使用 |
| connection_tombstones | idx_connection_tombstones_deleted_by | 从未使用 |
| quarantined_files | idx_quarantined_files_quarantined_by | 从未使用 |
| quarantined_files | idx_quarantined_files_expires_at | 从未使用 |
| tasks | idx_tasks_project_active | 从未使用 |
| connections | idx_connections_project_active | 从未使用 |
| project_members | idx_project_members_invited_by | 从未使用 |
| black_box_entries | idx_black_box_user_date | 从未使用 |
| black_box_entries | idx_black_box_project | 从未使用 |
| black_box_entries | idx_black_box_pending | 从未使用 |

#### 3.5.2 清理策略

**保守策略**：仅清理明确不需要的索引，保留可能在未来使用的索引

```sql
-- supabase/migrations/20260126_cleanup_unused_indexes.sql

-- ============================================
-- 清理未使用索引
-- 注意：仅清理确认不需要的索引，保留预留功能的索引
-- ============================================

-- 安全删除：这些索引有更好的替代
DROP INDEX IF EXISTS public.idx_task_tombstones_deleted_by;
DROP INDEX IF EXISTS public.idx_connection_tombstones_deleted_by;

-- 保留以下索引（未来功能可能需要）：
-- - idx_tasks_project_active: 可能用于活动任务视图优化
-- - idx_black_box_*: 专注模式功能正在开发中
-- - idx_project_members_invited_by: 协作功能预留

COMMENT ON INDEX public.idx_tasks_project_active IS 
  '保留：可能用于活动任务视图优化';
COMMENT ON INDEX public.idx_black_box_user_date IS 
  '保留：专注模式按日期分组查询';
```

---

### 3.6 【P1】GoJS 批量渲染优化

#### 3.6.1 问题分析

性能追踪显示两次大布局更新：
- 布局 1：309 ms（157/260 节点）
- 布局 2：186 ms（153/390 节点）

#### 3.6.2 优化方案

```typescript
// flow-diagram.service.ts - 批量节点添加

/**
 * 【性能优化】批量添加节点，减少布局重计算
 */
batchAddNodes(tasks: Task[]): void {
  const diagram = this.diagram;
  if (!diagram) return;

  // 禁用动画和自动布局
  diagram.animationManager.stopAnimation();
  
  // 使用事务批量添加
  diagram.startTransaction('batch-add-nodes');
  
  try {
    // 临时禁用布局
    const layout = diagram.layout;
    diagram.layout = new go.Layout();
    
    // 批量添加所有节点
    const nodeDataArray: go.ObjectData[] = [];
    for (const task of tasks) {
      nodeDataArray.push(this.taskToNodeData(task));
    }
    diagram.model.addNodeDataCollection(nodeDataArray);
    
    // 恢复布局并执行一次
    diagram.layout = layout;
    
  } finally {
    diagram.commitTransaction('batch-add-nodes');
  }
  
  // 恢复动画
  diagram.animationManager.isEnabled = true;
}
```

```css
/* GoJS 容器优化 */
.gojs-diagram-container {
  /* 限制重排范围 */
  contain: layout style paint;
  
  /* GPU 加速 */
  will-change: transform;
  
  /* 防止布局抖动 */
  overflow: hidden;
}
```

---

### 3.7 【P2】Service Worker 缓存策略

#### 3.7.1 配置优化

```json
// ngsw-config.json - 添加 API 缓存策略

{
  "dataGroups": [
    {
      "name": "supabase-rpc",
      "urls": [
        "https://fkhihclpghmmtbbywvoj.supabase.co/rest/v1/rpc/*"
      ],
      "cacheConfig": {
        "strategy": "freshness",
        "maxSize": 20,
        "maxAge": "1h",
        "timeout": "5s"
      }
    },
    {
      "name": "supabase-rest",
      "urls": [
        "https://fkhihclpghmmtbbywvoj.supabase.co/rest/v1/*"
      ],
      "cacheConfig": {
        "strategy": "freshness",
        "maxSize": 50,
        "maxAge": "30m",
        "timeout": "3s"
      }
    }
  ]
}
```

---

### 3.8 【P2】字体资源优化

#### 3.8.1 当前问题

- 加载 16+ 个字体子集文件（总 1.2 MB）
- CDN 缓存 TTL 仅 7 天

#### 3.8.2 优化方案

**方案 A：减少预加载字体**（推荐，低成本）

```diff
<!-- index.html - 只预加载最关键的 3 个子集 -->
  <link rel="preload" href="https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont/files/lxgwwenkaiscreen-subset-118.woff2" as="font" type="font/woff2" crossorigin>
- <link rel="preload" href="https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont/files/lxgwwenkaiscreen-subset-117.woff2" as="font" type="font/woff2" crossorigin>
- <link rel="preload" href="https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont/files/lxgwwenkaiscreen-subset-119.woff2" as="font" type="font/woff2" crossorigin>
```

**方案 B：自托管字体子集**（高成本，高收益）

```bash
# 1. 提取项目中实际使用的字符
node scripts/extract-used-chars.js

# 2. 使用 fonttools 生成子集
pip install fonttools brotli
pyftsubset LXGWWenKaiScreen.ttf --text-file=used-chars.txt --flavor=woff2

# 3. 将 ~50KB 的子集文件放入 /public/fonts/
```

---

## 📋 四、验证与回滚计划

### 4.1 验证检查清单

| 阶段 | 验证项 | 方法 | 预期结果 |
|------|--------|------|----------|
| Phase 1 | Preconnect 警告消失 | Chrome DevTools Lighthouse | 无 Preconnect 警告 |
| Phase 1 | 骨架屏显示正常 | 人工验证 | 加载时显示布局骨架 |
| Phase 2 | RPC 函数正常工作 | `supabase rpc` 调用 | 返回完整项目数据 |
| Phase 2 | API 请求数减少 | Network 面板 | < 5 个请求 |
| Phase 2 | 首屏时间改善 | Lighthouse | LCP < 1.5s |
| Phase 3 | GoJS 渲染无卡顿 | Performance 面板 | 无 300ms+ 布局 |
| Phase 3 | 重复访问加速 | Cache-Control 验证 | 资源来自 SW 缓存 |

### 4.2 回滚方案

```typescript
// 功能开关：支持快速回滚
export const PERFORMANCE_FLAGS = {
  // Phase 2 功能开关
  USE_BATCH_RPC: true,           // 使用批量 RPC
  FIRST_SCREEN_PRIORITY: true,   // 首屏优先加载
  
  // Phase 3 功能开关
  GOJS_BATCH_RENDER: true,       // GoJS 批量渲染
  SW_API_CACHE: true,            // Service Worker 缓存
};

// 使用示例
async loadFullProject(projectId: string): Promise<Project | null> {
  if (PERFORMANCE_FLAGS.USE_BATCH_RPC) {
    return this.loadFullProjectOptimized(projectId);
  }
  return this.loadFullProjectLegacy(projectId);
}
```

---

## 📊 五、预期效果汇总

### 5.1 性能提升预测

```
                    优化前                          优化后
                    ───────                        ───────
首屏可交互         │████████████████████│ 6.0s    │██████│ 2.0s      -67%
API 请求数         │████████████████████│ 21个    │████│ 4个         -81%
字体加载           │██████████████│ 1.2MB        │██████│ 0.4MB     -67%
关键路径延迟        │████████████████████│ 5.9s    │████████│ 2.5s    -58%
```

### 5.2 用户体验提升

| 场景 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 首次打开应用 | 白屏 3s → 内容 6s | 骨架屏 0.1s → 内容 2s | **感知提升 3x** |
| 切换项目 | 重新加载 2s | 即时切换（已缓存）| **即时响应** |
| 弱网环境 | 可能超时失败 | SW 缓存兜底 | **100% 可用** |
| 重复访问 | 完全重新加载 | 增量同步 | **节省 80% 流量** |

---

## ✅ 六、实施确认

### 6.1 技术可行性验证 ✅

- [x] Supabase RPC 函数语法验证（参考官方文档）
- [x] 数据库表结构兼容性确认
- [x] 现有索引覆盖查询需求
- [x] Angular Service Worker 配置兼容性
- [x] GoJS 批量操作 API 确认

### 6.2 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| RPC 函数权限问题 | 中 | 高 | 完整的 RLS 测试 |
| 首屏优先导致数据不一致 | 低 | 中 | 后台同步 + UI 提示 |
| Service Worker 缓存过期 | 低 | 低 | 合理的 TTL 设置 |
| 字体子集遗漏字符 | 中 | 低 | 回退到完整字体 |

### 6.3 下一步行动

1. **立即执行**（< 1 小时）：
   - [ ] 修改 index.html 移除无用 preconnect
   - [ ] 增强骨架屏样式
   
2. **本周完成**（预计 8 小时）：
   - [ ] 创建并部署 RPC 迁移
   - [ ] 修改 simple-sync.service.ts
   - [ ] 实现首屏优先加载

3. **下周完成**（预计 6 小时）：
   - [ ] GoJS 渲染优化
   - [ ] Service Worker 配置
   - [ ] 完整回归测试

---

**文档维护**: 优化实施后更新验证结果  
**最后更新**: 2026-01-26

---

## 📝 七、实施进度跟踪

### 7.1 Phase 1 - 已完成 ✅

| 任务 | 状态 | 完成时间 | 备注 |
|------|------|----------|------|
| 移除 Sentry Preconnect | ✅ 完成 | 2026-01-26 | 保留 dns-prefetch |
| 增强 CSS 骨架屏 | ✅ 完成 | 2026-01-26 | 添加响应式布局、淡出动画 |
| 创建性能配置文件 | ✅ 完成 | 2026-01-26 | performance.config.ts |

### 7.2 Phase 2 - 已完成 ✅

| 任务 | 状态 | 完成时间 | 备注 |
|------|------|----------|------|
| 创建 RPC 函数迁移 | ✅ 完成 | 2026-01-26 | get_full_project_data, get_user_projects_meta |
| 部署 RPC 到 Supabase | ✅ 完成 | 2026-01-26 | 已验证可用 |
| 前端调用 RPC | ✅ 完成 | 2026-01-26 | loadFullProjectOptimized() |
| 更新类型定义 | ✅ 完成 | 2026-01-26 | supabase gen types |

### 7.3 Phase 3 - 待实施 ⏳

| 任务 | 状态 | 预计时间 | 备注 |
|------|------|----------|------|
| GoJS 批量渲染优化 | ⏳ 待实施 | 2h | flow-diagram.service.ts |
| Service Worker 缓存 | ⏳ 待实施 | 2h | ngsw-config.json |
| 字体资源优化 | ⏳ 待实施 | 4h | 可选：本地化子集 |

---

## 📁 八、变更文件清单

### 8.1 新增文件

| 文件路径 | 用途 |
|----------|------|
| `supabase/migrations/20260126100000_batch_load_optimization.sql` | RPC 函数迁移 |
| `src/config/performance.config.ts` | 性能优化配置 |
| `docs/performance-optimization-plan.md` | 本策划案文档 |

### 8.2 修改文件

| 文件路径 | 修改内容 |
|----------|----------|
| `index.html` | 移除 Sentry preconnect，增强骨架屏 |
| `src/config/index.ts` | 导出性能配置 |
| `src/app/core/services/simple-sync.service.ts` | 添加 loadFullProjectOptimized() |
| `src/types/supabase.ts` | 自动生成 RPC 类型 |

---

## 🔗 九、相关资源

- [Supabase RPC 文档](https://supabase.com/docs/guides/database/functions)
- [Chrome DevTools Performance 面板](https://developer.chrome.com/docs/devtools/performance/)
- [Web Vitals 优化指南](https://web.dev/articles/optimize-lcp)
- [Angular Service Worker](https://angular.io/guide/service-worker-intro)
