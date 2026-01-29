# Code Deletion Log

本文档记录所有代码清理和删除操作，确保可追溯和可恢复。

---

## 2026-01-28 深度清理会话

### 检测工具
- **knip v5.82.1**: 检测到 47 个未使用文件、7 个未使用依赖、171 个未使用导出

### 已完成的清理

#### 1. 未使用依赖移除 (package.json)

| 包名 | 类型 | 原因 | 状态 |
|------|------|------|------|
| `@angular/cdk` | dependency | 未在任何代码中导入 | ✅ 已移除 |
| `@sentry/node` | dependency | Node.js 专用，前端项目使用 @sentry/angular | ✅ 已移除 |
| `@testing-library/dom` | devDependency | 未在测试代码中使用 | ✅ 已移除 |
| `dotenv-cli` | devDependency | 未在脚本中使用 | ✅ 已移除 |
| `eslint-plugin-rxjs-x` | devDependency | 未在 eslint.config.js 中配置 | ✅ 已移除 |
| `shadcn` | devDependency | CLI 工具，未被使用 | ✅ 已移除 |

#### 2. 代码标记为废弃/待集成

| 文件 | 标记 | 说明 |
|------|------|------|
| `src/models/api-types.ts` | `@deprecated` | 边境防御类型，未被使用 |
| `src/models/supabase-mapper.ts` | `@deprecated` | Supabase 映射器，未被使用 |
| `src/services/persistence-failure-handler.service.ts` | `@status 待集成` | 数据保护计划预留实现 |
| `src/app/shared/modals/recovery-modal.component.ts` | `@status 待集成` | 备份恢复 UI，预留实现 |

#### 3. 临时脚本已删除

| 文件 | 状态 |
|------|------|
| `test-504-fix.js` | ✅ 已删除 |
| `test-504-fix.sh` | ✅ 已删除 |
| `test-speech-fix.sh` | ✅ 已删除 |

### 保留但标记为需要关注的文件

以下文件被 knip 标记为未使用，但经过人工验证确认有存在价值：

| 文件 | 状态 | 原因 |
|------|------|------|
| `supabase/functions/*` | 保留 | 后端 Edge Functions，由 Supabase 部署 |
| `src/tests/mocks/gojs-mock.ts` | 保留 | 被 vitest.config.mts 作为别名引用 |
| `src/styles.css` | 保留 | 被 angular.json 引用 |
| `src/app/features/focus/focus.animations.css` | 保留 | 被 styles.css 导入 |
| `public/sw-network-optimizer.js` | 保留 | Service Worker，可能被 PWA 使用 |
| Barrel 文件 (`*/index.ts`) | 保留 | 导出聚合文件，便于维护 |
| Strata 组件 | 保留 | 地质层功能，计划中但未集成 |
| BlackBoxTriggerComponent | 保留 | E2E 测试依赖 |

### 可以删除但保留的文件

以下文件在代码中未被直接使用，但保留作为参考或未来使用：

| 文件 | 原因 |
|------|------|
| `src/environments/environment.template.ts` | 环境配置模板说明 |
| `src/services/indexeddb-health.service.ts` | 健康检查服务，数据保护计划预留 |
| `src/services/storage-quota.service.ts` | 配额监控服务，数据保护计划预留 |
| `src/services/storage-adapter.service.ts` | 存储适配器，被 index.ts 导出 |
| `src/services/recovery.service.ts` | 恢复服务，数据保护计划预留 |

### 未使用导出分析

knip 检测到 171 个未使用导出，经分析分为以下类别：

| 类别 | 数量 | 处理 |
|------|------|------|
| 配置常量 | ~25 | 保留，可能被动态引用 |
| 类型定义 | ~40 | 保留，提供类型安全 |
| Barrel 导出 | ~50 | 保留，便于模块化管理 |
| 专注模式 signals | ~15 | 保留，被组件间接使用 |
| GoJS 边界类型 | ~10 | 保留，类型定义 |
| Flow 样式主题 | ~15 | 保留，被 FLOW_THEME_STYLES 引用 |
| 其他工具函数 | ~16 | 需要逐个验证 |

### 本次清理结果

- **依赖移除**: 6 个
- **代码废弃标记**: 4 个文件
- **临时脚本标记**: 3 个文件
- **预估 node_modules 大小减少**: ~15-20 MB

### 验证清单

执行 `npm install && npm run build && npm run test:run` 验证：
- [ ] `npm install` 成功
- [ ] `npm run build` 成功
- [ ] `npm run test:run` 通过
- [ ] 无控制台错误

### 后续建议

1. **可选：删除废弃的模型文件**：
   ```bash
   rm src/models/api-types.ts src/models/supabase-mapper.ts
   ```
   然后从 `src/models/index.ts` 移除相关注释。

2. **定期维护**：
   - 每月运行 `npx knip` 检测新的死代码
   - 新功能上线后清理预留代码
   - 保持 DELETION_LOG.md 更新

---

## 清理命令参考

```bash
# 检测未使用代码
npx knip

# 检测未使用依赖
npx depcheck

# 检测未使用 TypeScript 导出
npx ts-prune

# 验证构建
npm run build

# 运行测试
npm run test:run

# 完整验证脚本
bash scripts/verify-cleanup.sh
```

---

## 废弃代码标记规范

对于需要保留但当前未使用的代码，使用以下标记：

```typescript
/**
 * @deprecated 此文件/函数当前未被使用
 * 原因：XXX
 * 如需使用，请评估后决定是否删除此标记
 */

/**
 * @status 待集成 - 此服务已实现但尚未集成到应用中
 * @see docs/xxx.md 相关设计文档
 */
```

---

## 格式说明

每次清理会话应记录：
- 日期
- 使用的检测工具
- 删除的文件/依赖
- 保留的文件及原因
- 测试验证状态
- 后续建议
