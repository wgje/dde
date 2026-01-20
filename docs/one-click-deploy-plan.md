# NanoFlow 一键部署策划案（实施版 v3.0）

> **核心目标**：让用户在 5 分钟内拥有私有 NanoFlow 实例，数据完全在自己掌控中

---

## 〇、方案总览

### 用户入口矩阵

| 用户类型 | 入口 | 数据存储 | 适用场景 |
|----------|------|----------|----------|
| **体验用户** | 在线 Demo | 官方 Supabase（限时/限功能） | 快速了解产品 |
| **隐私敏感用户** | 一键部署 | 用户自己的 Supabase | 长期使用、数据私有 |
| **开发者** | 本地开发 | 本地/自选后端 | 二次开发、贡献代码 |
| **离线用户** | 本地模式 | 浏览器 IndexedDB | 无网络环境、临时使用 |

```
用户决策流程：
┌─────────────────────────────────────────────────────────────────┐
│                     NanoFlow 入口选择                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  👀 只想看看？                                                   │
│  └─→ [在线 Demo] ─→ 无需注册，数据 7 天后清理                    │
│                                                                  │
│  🔒 想长期使用 + 数据私有？                                       │
│  └─→ [一键部署] ─→ 5 分钟拥有私有实例                            │
│                                                                  │
│  💻 想本地开发/贡献代码？                                         │
│  └─→ [git clone] ─→ 完整开发环境                                 │
│                                                                  │
│  📴 没有网络？                                                   │
│  └─→ [离线模式] ─→ 数据存浏览器，联网后可迁移                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 一、在线 Demo 方案（详细设计）

### 1.1 Demo 的战略价值

| 价值 | 说明 |
|------|------|
| **降低认知门槛** | 用户无需部署即可体验核心功能 |
| **展示产品能力** | 流程图、离线同步、主题切换等 |
| **转化漏斗入口** | Demo → 私有部署 → 长期用户 |
| **减少 Issue** | 用户先体验再决定是否值得部署 |

### 1.2 Demo 技术方案选型

#### 方案 A：共享 Demo 实例（推荐）

```
架构：
┌─────────────────┐     ┌─────────────────┐
│  demo.nanoflow  │────▶│  Demo Supabase  │
│    (Vercel)     │     │  (共享数据库)    │
└─────────────────┘     └─────────────────┘
                              │
                              ▼
                        ┌─────────────┐
                        │ 定时清理任务 │
                        │ (7天数据保留)│
                        └─────────────┘
```

**优点：**
- 部署简单，只需一个 Vercel 项目 + 一个 Supabase 项目
- 用户无需任何操作即可使用
- 官方可控制数据生命周期

**需要的实现：**

1. **Demo 专用 Supabase 项目**
   - 创建独立的 Supabase 项目 `nanoflow-demo`
   - 配置定时清理任务（每天凌晨清理 7 天前的数据）

2. **Demo 访问限制**
   ```sql
   -- 限制每个匿名用户最多创建 3 个项目
   CREATE OR REPLACE FUNCTION check_demo_project_limit()
   RETURNS TRIGGER AS $$
   BEGIN
     IF (SELECT COUNT(*) FROM projects WHERE owner_id = auth.uid()) >= 3 THEN
       RAISE EXCEPTION 'Demo 模式最多创建 3 个项目';
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql;
   ```

3. **Demo 环境变量**
   ```env
   NG_APP_SUPABASE_URL=https://demo-xxx.supabase.co
   NG_APP_SUPABASE_ANON_KEY=eyJ...
   NG_APP_DEMO_MODE=true  # 新增：启用 Demo 模式限制
   ```

4. **前端 Demo 模式标识**
   ```typescript
   // 在 feature-flags.config.ts 添加
   DEMO_MODE_ENABLED: false,  // 生产版关闭
   DEMO_PROJECT_LIMIT: 3,     // Demo 版项目上限
   DEMO_DATA_RETENTION_DAYS: 7, // 数据保留天数
   ```

#### 方案 B：匿名本地模式作为 Demo

利用现有的**离线模式**作为 Demo，无需后端：

```
用户访问 demo.nanoflow.app
    │
    ▼
检测到未登录 → 自动启用本地模式
    │
    ▼
数据存储在浏览器 IndexedDB
    │
    ▼
页面顶部显示 Banner：
"您正在使用 Demo 模式，数据仅保存在本地浏览器"
[部署私有实例] [登录同步到云端]
```

**优点：**
- **零成本**：不需要维护 Demo 数据库
- **现有代码已支持**：`isLocalModeEnabled()` + `AUTH_CONFIG.LOCAL_MODE_USER_ID`
- **无数据泄露风险**：数据只在用户浏览器

**需要的改动：**
- 在 `SupabaseClientService` 检测到占位符配置时，引导进入 Demo 模式
- 添加 Demo Banner 组件提示用户状态

#### 方案对比

| 维度 | 方案 A（共享实例） | 方案 B（本地模式） |
|------|-------------------|-------------------|
| 实现成本 | 中（需额外 Supabase） | 低（利用现有代码） |
| 维护成本 | 中（需定期清理） | 无 |
| 用户体验 | 好（接近真实使用） | 一般（无云同步体验） |
| 数据隐私 | 需说明数据会被清理 | 完全私有 |
| 多设备体验 | 可演示 | 无法演示 |

**建议：先实现方案 B（成本最低），验证需求后再考虑方案 A。**

### 1.3 Demo 页面设计

```
┌─────────────────────────────────────────────────────────────────┐
│  🎯 NanoFlow Demo                                    [部署私有版] │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ⚠️ Demo 模式：数据仅保存在当前浏览器，清除缓存会丢失数据         │
│     想要永久保存？→ [一键部署私有实例] 或 [登录/注册]            │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                    （正常的 NanoFlow 界面）                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.4 Demo 数据清理策略（方案 A 专用）

```sql
-- 清理 7 天前创建的 Demo 数据
-- 建议每天凌晨 3 点执行
CREATE OR REPLACE FUNCTION cleanup_demo_data()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- 删除 7 天前创建的项目（级联删除任务和连接）
  WITH deleted AS (
    DELETE FROM projects 
    WHERE created_date < NOW() - INTERVAL '7 days'
    RETURNING id
  )
  SELECT COUNT(*) INTO deleted_count FROM deleted;
  
  -- 记录清理日志
  INSERT INTO cleanup_logs (type, details)
  VALUES ('demo_cleanup', jsonb_build_object(
    'deleted_projects', deleted_count,
    'timestamp', NOW()
  ));
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- pg_cron 定时任务
SELECT cron.schedule('cleanup-demo-data', '0 3 * * *', $$SELECT cleanup_demo_data()$$);
```

---

## 二、现状分析

### 2.1 NanoFlow 当前部署架构

```
NanoFlow 技术栈：
├── 前端：Angular 19.x（静态 SPA）
├── 后端：Supabase（PostgreSQL + Auth + Storage）
├── 构建输出：dist/browser/（静态文件）
└── 环境变量：通过 scripts/set-env.cjs 在构建时注入
```

**已有的优势：**
- ✅ `vercel.json` 已配置好（SPA 重写、缓存、安全头）
- ✅ `scripts/set-env.cjs` 已支持从环境变量生成 `environment.ts`
- ✅ `scripts/init-supabase.sql` 包含完整的数据库初始化（2500+ 行）
- ✅ `.env.template` 已提供环境变量模板
- ✅ README 已有 Supabase 配置的详细说明
- ✅ `SupabaseClientService` 已有占位符检测和离线模式支持
- ✅ `config-help-modal` 已有配置指引 UI

**需要解决的问题：**
- ❌ 没有 Deploy 按钮，用户不知道可以一键部署
- ❌ 没有在线 Demo，用户无法快速体验
- ❌ SQL 脚本 2500 行太长，用户复制粘贴容易出错
- ❌ Storage bucket 需要手动创建
- ❌ 缺少升级和维护指南

### 2.2 现有环境变量机制

项目已有完善的环境变量机制：

**构建时注入** ([scripts/set-env.cjs](../scripts/set-env.cjs))：
```javascript
// 读取优先级：进程环境变量 > .env.local 文件
const supabaseUrl = process.env.NG_APP_SUPABASE_URL || localEnv.NG_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.NG_APP_SUPABASE_ANON_KEY || localEnv.NG_APP_SUPABASE_ANON_KEY;

// 未配置时使用占位符，进入离线模式
const useOfflineMode = !supabaseUrl || !supabaseAnonKey;
```

**运行时检测** ([src/services/supabase-client.service.ts](../src/services/supabase-client.service.ts))：
```typescript
// 检查是否为模板占位符
const isPlaceholder = (val: string) => 
  !val || val === 'YOUR_SUPABASE_URL' || val === 'YOUR_SUPABASE_ANON_KEY';

if (isPlaceholder(supabaseUrl) || isPlaceholder(supabaseAnonKey)) {
  this.isOfflineMode.set(true);  // 自动进入离线模式
}
```

**关键发现：Vercel 部署已经可以工作！**

只需要在 Vercel 设置环境变量 `NG_APP_SUPABASE_URL` 和 `NG_APP_SUPABASE_ANON_KEY`，构建脚本会自动注入。

---

## 三、一键部署实施方案

### 3.1 Vercel 部署按钮（零代码改动）

**立即可用的部署链接：**

```markdown
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fdydyde%2Fdde&env=NG_APP_SUPABASE_URL,NG_APP_SUPABASE_ANON_KEY&envDescription=Supabase%20%E9%85%8D%E7%BD%AE%EF%BC%88%E4%BB%8E%20Supabase%20Dashboard%20%3E%20Settings%20%3E%20API%20%E8%8E%B7%E5%8F%96%EF%BC%89&envLink=https%3A%2F%2Fgithub.com%2Fdydyde%2Fdde%23supabase-%E9%83%A8%E7%BD%B2%E9%85%8D%E7%BD%AE&project-name=my-nanoflow&repository-name=my-nanoflow)
```

**渲染效果：**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fdydyde%2Fdde&env=NG_APP_SUPABASE_URL,NG_APP_SUPABASE_ANON_KEY&envDescription=Supabase%20配置&envLink=https%3A%2F%2Fgithub.com%2Fdydyde%2Fdde%23supabase-部署配置&project-name=my-nanoflow&repository-name=my-nanoflow)

**参数说明：**

| 参数 | 值 | 说明 |
|------|-----|------|
| `repository-url` | `github.com/dydyde/dde` | 源仓库 |
| `env` | `NG_APP_SUPABASE_URL,NG_APP_SUPABASE_ANON_KEY` | 必填环境变量 |
| `envDescription` | Supabase 配置说明 | 提示文字 |
| `envLink` | README 锚点链接 | 配置教程链接 |
| `project-name` | `my-nanoflow` | 建议项目名 |

### 3.2 现有 vercel.json 验证

当前 [vercel.json](../vercel.json) 配置已经完善：

```json
{
  "buildCommand": "npm run build",           // ✅ 会执行 npm run config
  "outputDirectory": "dist/browser",         // ✅ 正确的输出目录
  "rewrites": [{ "source": "/:path(...)", "destination": "/index.html" }],  // ✅ SPA 路由
  "headers": [...]                           // ✅ 安全头 + 缓存策略
}
```

**构建流程验证：**
```bash
npm run build
# 等价于：npm run config && rm -rf dist .angular && ng build
# npm run config 会调用 set-env.cjs，读取环境变量生成 environment.ts
```

### 3.3 SQL 初始化脚本使用指南

**使用完整版脚本：** `scripts/init-supabase.sql`

虽然脚本有 2500+ 行，但 **用户无需理解内容，只需复制粘贴执行即可**。

#### 为什么推荐完整版

| 优势 | 说明 |
|------|------|
| ✅ 功能完整 | 包含所有生产级功能：批量操作、定时清理、病毒扫描等 |
| ✅ 幂等设计 | 使用 `IF NOT EXISTS`，重复执行不会报错 |
| ✅ 向后兼容 | 未来升级无需额外迁移 |
| ✅ 安全加固 | 包含完整的 RLS 策略和 Tombstone 防复活机制 |

#### SQL 脚本包含的功能

```
脚本结构（约 2500 行）：
├── 核心表结构
│   ├── projects     - 项目表
│   ├── tasks        - 任务表（含软删除）
│   ├── connections  - 任务连接表
│   └── user_preferences - 用户偏好
│
├── 安全策略 (RLS)
│   ├── 项目只有 owner 可访问
│   ├── 任务/连接通过项目关联校验
│   └── 用户偏好只能访问自己的
│
├── 高级功能
│   ├── 批量操作 RPC (batch_upsert_tasks)
│   ├── 附件管理 RPC (add_attachment, remove_attachment)
│   ├── 仪表盘统计 RPC (get_dashboard_stats)
│   ├── 定时清理函数 (cleanup_old_data)
│   └── Tombstone 防复活机制
│
└── 索引优化
    ├── 项目/任务/连接的主要字段索引
    └── updated_at 索引（增量同步必需）
```

#### 执行方法（简单 3 步）

```
步骤 1：打开 SQL Editor
┌─────────────────────────────────────────────┐
│  Supabase Dashboard                      │
│  └── SQL Editor（左侧菜单）               │
└─────────────────────────────────────────────┘

步骤 2：复制完整脚本
┌─────────────────────────────────────────────┐
│  打开 scripts/init-supabase.sql         │
│  点击 "Raw" 或 复制全部内容              │
│  （Ctrl+A 全选，Ctrl+C 复制）            │
└─────────────────────────────────────────────┘

步骤 3：粘贴并执行
┌─────────────────────────────────────────────┐
│  粘贴到 SQL Editor                       │
│  点击 "Run" 或按 Ctrl+Enter             │
│  等待 5-10 秒，看到绿色 ✓ Success        │
└─────────────────────────────────────────────┘
```

> 💡 **提示**：如果执行时间较长（>30秒），刷新页面后到 Table Editor 检查是否已创建 `projects`、`tasks` 等表。

---

## 四、安全性设计

### 4.1 密钥安全

**现有保护措施：**

1. **敏感密钥检测** ([supabase-client.service.ts](../src/services/supabase-client.service.ts))：
   ```typescript
   const SENSITIVE_KEY_PATTERNS = ['service_role', 'secret', 'private', 'admin'];
   
   if (this.isSensitiveKey(supabaseAnonKey)) {
     throw new Error('检测到敏感密钥，请使用 anon public key');
   }
   ```

2. **环境变量校验** ([validate-env.cjs](../scripts/validate-env.cjs))：
   ```javascript
   // 生产构建前检查密钥格式
   if (value.length < 100) return 'Key 长度异常，请检查是否完整复制';
   ```

3. **RLS 策略**：所有表启用 Row Level Security，用户只能访问自己的数据

### 4.2 部署安全检查清单

| 检查项 | 说明 | 验证方式 |
|--------|------|----------|
| ✅ 使用 anon key | 不要使用 service_role key | 构建时自动检测 |
| ✅ RLS 已启用 | 所有表有 RLS 策略 | SQL 脚本已包含 |
| ✅ HTTPS 强制 | Vercel 自动提供 | 默认配置 |
| ✅ 安全头配置 | X-Frame-Options 等 | vercel.json 已配置 |
| ⚠️ Supabase 邮件验证 | 可选启用 | 用户自行配置 |

### 4.3 用户数据隔离

```sql
-- RLS 策略确保用户只能访问自己的数据
CREATE POLICY "projects_owner" ON public.projects
  USING (owner_id = auth.uid())        -- SELECT/UPDATE/DELETE
  WITH CHECK (owner_id = auth.uid());  -- INSERT

-- 任务通过项目关联隔离
CREATE POLICY "tasks_via_project" ON public.tasks
  USING (EXISTS (
    SELECT 1 FROM projects 
    WHERE id = project_id AND owner_id = auth.uid()
  ));
```

---

## 五、升级与维护

### 5.1 版本升级流程

**用户私有实例升级方式：**

```
方式 1：Vercel 自动部署（推荐）
├── 用户 Fork 的仓库开启 "Sync fork" 功能
├── 上游更新后，GitHub 自动同步
└── Vercel 检测到更新，自动重新部署

方式 2：手动重新部署
├── 进入 Vercel Dashboard
├── 选择项目 → Deployments
└── 点击 "Redeploy" 拉取最新代码

方式 3：更新数据库迁移（如有）
├── 检查 CHANGELOG 是否有数据库变更
├── 如有，执行对应的迁移 SQL
└── 通常是追加字段，无需担心数据丢失
```

### 5.2 数据库迁移策略

**设计原则：**
- 所有迁移脚本向后兼容
- 新增字段使用 `IF NOT EXISTS` + 默认值
- 不删除旧字段，只标记废弃

**迁移脚本位置：**
```
supabase/migrations/
├── 20241201_xxx.sql
├── 20250101_xxx.sql
└── ...

scripts/
├── init-supabase.sql        # 完整版（包含所有迁移）
└── migrate-to-v2.sql        # 增量迁移脚本
```

**用户升级数据库：**
1. 检查 [CHANGELOG](../CHANGELOG.md) 确认是否有数据库变更
2. 如有，到 Supabase SQL Editor 执行对应迁移脚本
3. 迁移脚本通常是幂等的，重复执行不会出错

### 5.3 备份建议

**用户应定期备份：**

| 备份方式 | 操作 | 频率建议 |
|----------|------|----------|
| **应用内导出** | 设置 → 导出数据 → JSON | 每周一次 |
| **Supabase 备份** | Dashboard → Database → Backups | 自动（Pro 计划）|
| **本地自动备份** | 设置 → 本地自动备份 | 每 30 分钟 |

---

## 六、故障排查指南

### 6.1 常见部署错误

#### 错误 1：构建失败 - 环境变量未设置

```
Error: Supabase 环境变量未配置
```

**原因：** Vercel 环境变量未正确设置

**解决：**
1. 进入 Vercel Dashboard → Settings → Environment Variables
2. 确认 `NG_APP_SUPABASE_URL` 和 `NG_APP_SUPABASE_ANON_KEY` 已设置
3. 重新部署

#### 错误 2：登录失败 - 401 Unauthorized

```
Error: Invalid API key
```

**原因：** 
- 使用了错误的 Supabase Key
- Supabase 项目未完成初始化

**解决：**
1. 确认使用的是 `anon public` key（不是 `service_role`）
2. 等待 Supabase 项目初始化完成（约 2 分钟）
3. 检查 Key 是否完整复制（无多余空格）

#### 错误 3：数据库操作失败 - 42P01 relation does not exist

```
Error: relation "projects" does not exist
```

**原因：** SQL 初始化脚本未执行

**解决：**
1. 进入 Supabase Dashboard → SQL Editor
2. 执行 `init-supabase.sql` 或 `init-supabase-quick.sql`
3. 确认执行成功（绿色 Success 提示）

#### 错误 4：附件上传失败 - Storage bucket not found

```
Error: Bucket not found
```

**原因：** 未创建 Storage bucket

**解决：**
1. 进入 Supabase Dashboard → Storage
2. 点击 "New bucket"
3. 名称填入 `attachments`，取消勾选 "Public bucket"
4. 点击创建

### 6.2 健康检查

**用户可以通过以下方式验证部署是否成功：**

1. **访问应用** - 能正常打开页面
2. **注册/登录** - 能完成认证流程
3. **创建项目** - 能保存到数据库
4. **刷新页面** - 数据仍然存在
5. **上传附件** - 文件能正常保存（需要 Storage bucket）

### 6.3 日志查看

| 平台 | 日志位置 |
|------|----------|
| Vercel | Dashboard → Project → Logs |
| Supabase | Dashboard → Logs（按服务筛选）|
| 浏览器 | 开发者工具 → Console |

---

## 七、详细部署步骤（图文指南）

> 本节提供完整的分步骤部署指南，确保零基础用户也能顺利完成。

### 7.1 第一步：创建 Supabase 项目（约 3 分钟）

```
┌─────────────────────────────────────────────────────────────────┐
│                     创建 Supabase 项目                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. 打开 https://supabase.com                                   │
│     └── 点击 "Start your project" 或 "Dashboard"                │
│                                                                  │
│  2. 用 GitHub 账号登录（首选）或邮箱注册                          │
│     └── GitHub 登录最快，授权后自动进入 Dashboard                │
│                                                                  │
│  3. 点击 "New project"                                          │
│     ├── Name: my-nanoflow（或任意名称）                          │
│     ├── Database Password: 设置一个强密码 ⚠️ 务必保存！          │
│     ├── Region: 选择离你最近的区域                               │
│     │   └── 推荐：Northeast Asia (Tokyo) 或 Singapore           │
│     └── 点击 "Create new project"                               │
│                                                                  │
│  4. 等待项目初始化（约 1-2 分钟）                                │
│     └── 看到 "Project is ready" 即可进行下一步                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 第二步：创建 Storage 存储桶（约 30 秒）

```
┌─────────────────────────────────────────────────────────────────┐
│                     创建 Storage 存储桶                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. 在左侧菜单找到 "Storage"，点击进入                           │
│                                                                  │
│  2. 点击 "New bucket" 按钮                                      │
│     ├── Name: attachments（必须是这个名称）                      │
│     ├── Public bucket: ❌ 不要勾选（保持私有）                   │
│     └── 点击 "Create bucket"                                    │
│                                                                  │
│  ✅ 完成！你会看到 attachments 出现在存储桶列表中                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 7.3 第三步：执行数据库初始化脚本（约 1 分钟）

```
┌─────────────────────────────────────────────────────────────────┐
│                     执行 SQL 初始化脚本                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. 在左侧菜单找到 "SQL Editor"，点击进入                        │
│                                                                  │
│  2. 在 GitHub 仓库中打开 scripts/init-supabase.sql              │
│     └── 点击 "Raw" 按钮查看原始文件                              │
│     └── Ctrl+A 全选，Ctrl+C 复制全部内容                         │
│                                                                  │
│  3. 回到 Supabase SQL Editor                                    │
│     └── 点击 "+ New query"                                      │
│     └── Ctrl+V 粘贴刚才复制的内容                                │
│                                                                  │
│  4. 点击 "Run" 按钮（或按 Ctrl+Enter）                          │
│     └── 等待执行完成（5-15 秒）                                  │
│     └── 看到 ✓ Success 表示成功                                 │
│                                                                  │
│  5. 验证：点击左侧 "Table Editor"                                │
│     └── 应该能看到 projects、tasks、connections 等表              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

> ⚠️ **常见问题**：如果提示 "syntax error"，检查是否完整复制了脚本（不要遗漏开头或结尾）。

### 7.4 第四步：获取 API 密钥（约 30 秒）

```
┌─────────────────────────────────────────────────────────────────┐
│                     获取 API 密钥                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. 在左侧菜单最下方，点击 "Project Settings" ⚙️                │
│                                                                  │
│  2. 点击 "API"（在 Configuration 分组下）                       │
│                                                                  │
│  3. 找到并复制以下两个值：                                        │
│                                                                  │
│     ┌─────────────────────────────────────────────────────┐     │
│     │ Project URL                                          │     │
│     │ https://xxxxxxxx.supabase.co                        │     │
│     │ [📋 Copy]                                            │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                  │
│     ┌─────────────────────────────────────────────────────┐     │
│     │ Project API keys                                     │     │
│     │ anon public: eyJhbGciOiJIUzI1NiIs...                │     │
│     │ [📋 Copy]  ⚠️ 复制 anon public，不是 service_role！  │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                  │
│  📝 将这两个值保存到记事本，下一步要用                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

> ⚠️ **重要**：只使用 `anon public` 密钥！`service_role` 密钥有完全权限，泄露会导致数据被删除。

### 7.5 第五步：部署到 Vercel（约 2 分钟）

```
┌─────────────────────────────────────────────────────────────────┐
│                     部署到 Vercel                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. 点击下方的 "Deploy with Vercel" 按钮                        │
│     └── 会跳转到 Vercel 网站                                     │
│                                                                  │
│  2. 如果没有 Vercel 账号                                         │
│     └── 选择 "Continue with GitHub" 用 GitHub 登录              │
│                                                                  │
│  3. 在 "Configure Project" 页面                                 │
│     ├── Repository Name: my-nanoflow（会 Fork 到你的 GitHub）   │
│     │                                                            │
│     ├── Environment Variables（重要！）                          │
│     │   ┌─────────────────────────────────────────────────┐     │
│     │   │ NG_APP_SUPABASE_URL                              │     │
│     │   │ [粘贴你的 Project URL]                           │     │
│     │   │ https://xxxxxxxx.supabase.co                    │     │
│     │   └─────────────────────────────────────────────────┘     │
│     │   ┌─────────────────────────────────────────────────┐     │
│     │   │ NG_APP_SUPABASE_ANON_KEY                         │     │
│     │   │ [粘贴你的 anon public key]                       │     │
│     │   │ eyJhbGciOiJIUzI1NiIs...                         │     │
│     │   └─────────────────────────────────────────────────┘     │
│     │                                                            │
│     └── 点击 "Deploy" 按钮                                      │
│                                                                  │
│  4. 等待构建完成（约 2-3 分钟）                                  │
│     └── 看到 "Congratulations!" 表示部署成功 🎉                 │
│                                                                  │
│  5. 点击 "Continue to Dashboard" 或访问显示的 URL               │
│     └── 你的私有 NanoFlow 实例已经上线了！                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 7.6 第六步：验证部署成功

```
┌─────────────────────────────────────────────────────────────────┐
│                     验证部署成功                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  □ 1. 能访问你的 Vercel URL（如 my-nanoflow.vercel.app）         │
│                                                                  │
│  □ 2. 能看到登录/注册页面                                        │
│                                                                  │
│  □ 3. 能成功注册新账号（收到验证邮件）                            │
│                                                                  │
│  □ 4. 能创建新项目并保存                                         │
│                                                                  │
│  □ 5. 刷新页面后数据仍然存在                                      │
│                                                                  │
│  □ 6. 能上传附件（需要已创建 Storage bucket）                     │
│                                                                  │
│  全部 ✓？恭喜，你的私有 NanoFlow 已完全就绪！ 🎉                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 八、实施任务清单

### 8.1 P0：立即可做（无代码改动）

| # | 任务 | 工作量 | 产出 |
|---|------|--------|------|
| 1 | 在 README 添加快速开始章节 | 30 分钟 | README 更新 |
| 2 | 添加 Demo 链接和部署按钮 | 10 分钟 | README 更新 |
| 3 | 测试完整部署流程 | 30 分钟 | 验证报告 |

### 8.2 P1：短期改进（少量代码）

| # | 任务 | 工作量 | 产出 |
|---|------|--------|------|
| 4 | 创建详细部署教程 | 2 小时 | `docs/deploy-private-instance.md` |
| 5 | 添加 Demo Banner 组件 | 1 小时 | 前端组件 |
| 6 | 更新 .env.template | 10 分钟 | 文件更新 |

### 8.3 P2：中期增强

| # | 任务 | 工作量 | 产出 |
|---|------|--------|------|
| 7 | 前端配置状态检测 | 2 小时 | 首页提示组件 |
| 8 | Netlify 部署支持 | 30 分钟 | `netlify.toml` + 按钮 |
| 9 | Railway 部署支持 | 30 分钟 | 配置 + 按钮 |
| 10 | Demo 共享实例（方案 A） | 4 小时 | 独立 Supabase + 清理任务 |

### 8.4 P3：长期优化

| # | 任务 | 工作量 | 产出 |
|---|------|--------|------|
| 11 | 交互式部署向导网页 | 8 小时 | 独立页面 |
| 12 | `npx create-nanoflow` CLI | 4 小时 | npm 包 |
| 13 | 多语言文档（英/日） | 4 小时 | 国际化文档 |

---

## 九、完整用户旅程

### 9.1 5 分钟部署时间线

```
时间    步骤                              参考章节
────────────────────────────────────────────────────
0:00 │ 看到 README 中的部署按钮           │ -
0:30 │ 打开 Supabase，创建项目            │ 7.1
2:30 │ 创建 Storage bucket               │ 7.2
3:00 │ 执行 SQL 初始化脚本               │ 7.3
3:30 │ 复制 API 密钥                     │ 7.4
4:00 │ 点击部署按钮，填写环境变量         │ 7.5
5:00 │ ✅ 部署完成！                      │ 7.6
5:30 │ 注册账号，开始使用                 │ -
```

### 9.2 用户决策树（完整版）

```
想使用 NanoFlow？
│
├── 👀 只想快速体验（5 秒）
│   └─→ [在线 Demo] → 无需注册，数据存浏览器
│       └─→ 觉得好用？→ [一键部署] 拥有私有实例
│
├── 🔒 想长期使用 + 数据私有（5 分钟）
│   ├─→ 有 GitHub 账号？
│   │   └─→ [一键部署] → 按照第七章步骤操作
│   └─→ 没有 GitHub？
│       └─→ 先注册 GitHub → 再一键部署
│
├── 💻 想本地开发/贡献代码（10 分钟）
│   └─→ [git clone] → npm install → npm start
│
└── 📴 没有网络/临时使用
    └─→ [离线模式] → 登录页选择"本地模式"
        └─→ 数据存浏览器，联网后可登录同步
```

---

## 十、验收标准

| 指标 | 目标 | 验证方法 |
|------|------|----------|
| 部署时间 | 新用户 < 10 分钟完成 | 实际测试 |
| 部署成功率 | 按教程操作 > 90% 成功 | 用户反馈 |
| 文档自足性 | 不需要搜索其他资料 | 用户测试 |
| 错误可恢复 | 常见错误有明确解决方案 | 故障排查指南 |
| Demo 体验 | 核心功能正常使用 | 功能测试 |

---

## 十一、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 用户填错环境变量 | 部署失败 | 第 7.4 步强调只用 anon key |
| SQL 脚本复制不完整 | 数据库初始化失败 | 第 7.3 步提供复制方法 |
| Supabase 免费额度变化 | 用户成本增加 | 文档标注日期，定期更新 |
| 用户忘记 Supabase 密码 | 无法管理数据库 | 第 7.1 步强调保存密码 |
| Demo 被滥用 | 资源耗尽 | 限制项目数 + 定期清理 |
| 升级导致数据不兼容 | 数据丢失 | 迁移脚本幂等设计 |

---

## 十二、附录

### A. 现有部署相关文件

```
部署相关文件：
├── vercel.json                    # ✅ 已就绪
├── .env.template                  # ✅ 已存在，需小幅更新
├── scripts/
│   ├── set-env.cjs               # ✅ 核心：构建时注入环境变量
│   ├── validate-env.cjs          # ✅ 生产构建前校验
│   └── init-supabase.sql         # ✅ 完整版 SQL（2500 行，推荐使用）
├── src/
│   ├── services/supabase-client.service.ts  # ✅ 占位符检测 + 离线模式
│   └── config/feature-flags.config.ts       # 📝 可添加 DEMO_MODE
├── README.md                      # 📝 需添加部署按钮 + Demo 链接
└── docs/
    ├── one-click-deploy-plan.md   # 📋 本文档
    └── deploy-private-instance.md # 🆕 可选：更详细的截图教程
```

### B. 环境变量完整列表

| 变量名 | 必填 | 说明 | 默认值 |
|--------|------|------|--------|
| `NG_APP_SUPABASE_URL` | ✅ | Supabase 项目 URL | `YOUR_SUPABASE_URL` |
| `NG_APP_SUPABASE_ANON_KEY` | ✅ | Supabase 匿名公钥 | `YOUR_SUPABASE_ANON_KEY` |
| `NG_APP_SENTRY_DSN` | ❌ | Sentry 错误监控 DSN | 空 |
| `NG_APP_GOJS_LICENSE_KEY` | ❌ | GoJS 许可证（移除水印）| 空 |
| `NG_APP_DEMO_MODE` | ❌ | 启用 Demo 模式限制 | `false` |

### C. 相关现有代码

| 文件 | 功能 | 说明 |
|------|------|------|
| [supabase-client.service.ts](../src/services/supabase-client.service.ts) | 占位符检测、离线模式 | 自动检测未配置状态 |
| [config-help-modal.component.ts](../src/app/shared/modals/config-help-modal.component.ts) | 配置指引 UI | 引导用户完成配置 |
| [auth.guard.ts](../src/services/guards/auth.guard.ts) | 本地模式支持 | 离线 Demo 的基础 |
| [feature-flags.config.ts](../src/config/feature-flags.config.ts) | 功能开关 | 可添加 DEMO_MODE |
| [init-supabase.sql](../scripts/init-supabase.sql) | 数据库初始化 | 完整版，推荐使用 |

### D. SQL 脚本功能说明

`scripts/init-supabase.sql`（2500+ 行）包含的完整功能：

| 功能分类 | 包含内容 | 说明 |
|----------|----------|------|
| **核心表** | projects, tasks, connections, user_preferences | 必需 |
| **安全策略** | RLS 策略（6+ 条） | 必需：数据隔离 |
| **索引优化** | 15+ 个索引 | 性能优化 |
| **触发器** | updated_at 自动更新 | 同步必需 |
| **RPC 函数** | batch_upsert_tasks, add_attachment 等 | 批量操作 |
| **清理函数** | cleanup_old_data, purge_deleted_* | 数据维护 |
| **防复活机制** | task_tombstones 表 | 同步可靠性 |
| **仪表盘** | get_dashboard_stats | 统计功能 |

> 💡 **为什么不提供精简版**：脚本使用 `IF NOT EXISTS` 等幂等语法，用户只需复制粘贴执行，无需理解内容。精简版反而可能导致功能缺失和升级困难。

### E. 常见问题速查

| 问题 | 原因 | 解决方案 | 参考 |
|------|------|----------|------|
| 登录失败 401 | Key 错误 | 检查是否用了 anon key | 7.4 / 6.1 |
| 表不存在 | SQL 未执行 | 重新执行 init-supabase.sql | 7.3 / 6.1 |
| 附件上传失败 | 无 Storage bucket | 创建 attachments bucket | 7.2 / 6.1 |
| 页面空白 | 环境变量未设置 | 检查 Vercel 环境变量 | 7.5 / 6.1 |
| 数据不同步 | 离线模式 | 检查网络 + Supabase 状态 | - |

---

*最后更新: 2025-01-20*  
*版本: 3.1（易用性增强版）*
