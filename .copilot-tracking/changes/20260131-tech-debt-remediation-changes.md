<!-- markdownlint-disable-file -->

# Change Record: 技术债务清理计划审查与更新

**执行日期**: 2026-01-31  
**执行状态**: ✅ Sprint 1-2 实施完成

---

## 变更摘要

本次任务对 NanoFlow 技术债务清理计划进行了深度审查和更新，并执行了 Sprint 1-2 的实施工作。

---

## Sprint 1 实施完成 ✅

| 任务 | 状态 | 说明 |
|------|------|------|
| 修复 prompt 文件 tools: 语法 (8个) | ✅ | 移除无效的 tools: 行 |
| ESLint 规则升级为 error 级别 | ✅ | no-console, no-explicit-any |
| 创建测试 Mock 类型库 | ✅ | 添加索引文件和 @tests 路径别名 |

---

## Sprint 2 实施完成 ✅

| 任务 | 状态 | 说明 |
|------|------|------|
| 创建 EventBusService | ✅ | 用于解耦循环依赖 |
| 解决循环依赖 (C-05) | ✅ | 移除所有 injector hack |
| 修复相关测试文件 | ✅ | 添加 EventBusService mock |

### EventBusService 详情

创建了新的事件总线服务 `src/services/event-bus.service.ts`，提供以下事件：

- `onUndoRequest$` / `onRedoRequest$` - 撤销/重做请求
- `onProjectSwitch$` - 项目切换
- `onSyncStatus$` - 同步状态变更
- `onSessionRestored$` - 会话恢复
- `onTaskUpdate$` - 任务更新
- `onForceSyncRequest$` - 强制同步请求

### 循环依赖修复详情

1. **TaskOperationAdapterService** → 移除 `inject(Injector)` 和 `getStoreService()` hack
2. **AuthService** → 移除 `inject(Injector)` 和延迟注入 SimpleSyncService
3. **StoreService** → 订阅 EventBusService 的撤销/重做请求
4. **SimpleSyncService** → 订阅 EventBusService 的会话恢复事件

---

## Phase 1: 数据验证 ✅

| 指标 | 计划声称 | 实际验证值 | 偏差 | 状态 |
|------|----------|------------|------|------|
| console.* 调用 | 343 | 344 | +0.3% | ✅ 准确 |
| setTimeout 使用 | 191 | 191 | 0% | ✅ 准确 |
| @deprecated 方法 | 27 | 27 | 0% | ✅ 准确 |
| any 类型 | 36 | 36 | 0% | ✅ 准确 |
| 超 800 行文件 | 27 | 27 | 0% | ✅ 准确 |

---

## Phase 2: 遗漏项发现 ✅

### 发现的遗漏项

1. **14 个 800-1200 行文件** 未在原计划中
2. **ESLint 禁用注释统计口径偏差**: 生产代码 4 处 vs 测试代码 27 处
3. **prompt 文件数量偏差**: 实际 8 个（计划声称 5 个）

---

## Phase 3: 计划更新 ✅

### 变更清单

| 变更项 | 原值 | 新值 | 文件 |
|--------|------|------|------|
| 文档版本 | 1.1 | 1.2 | docs/tech-debt-remediation-plan.md |
| prompt 文件数量 | 5 个 | 8 个 | 多处 |
| ESLint 禁用注释统计 | 31 处 | 4处生产+27处测试 | 多处 |
| 总工作量估算 | 73-97 人天 | 100-130 人天 | 执行摘要 |
| Sprint 数量 | 10 | 10-13 | 实施时间线 |
| M-05 工作量 | 0.5d | 1d | Sprint 1 |

### 新增内容

1. 在附录 A 添加 14 个遗漏的 800-1200 行文件清单
2. 更新 S-05 ESLint 禁用注释清理方案，添加验证命令
3. 更新 M-05 Prompt 文件配置修复，列出完整的 8 个受影响文件

---

## 文件变更列表

| 文件 | 操作 | 说明 |
|------|------|------|
| docs/tech-debt-remediation-plan.md | 修改 | 更新版本、统计数据、工作量估算 |
| .copilot-tracking/plans/20260131-tech-debt-remediation-plan.instructions.md | 修改 | 标记所有任务完成 |
| .copilot-tracking/details/20260131-tech-debt-remediation-details.md | 修改 | 更新 Success Criteria |
| .copilot-tracking/changes/20260131-tech-debt-remediation-changes.md | 创建 | 本变更记录 |

---

## 验收检查

- [x] 文档版本已更新 (1.1 → 1.2)
- [x] prompt 文件数量已更正 (5 → 8)
- [x] ESLint 禁用注释统计已澄清
- [x] 工作量估算已更新 (+20% 缓冲)
- [x] 遗漏的超大文件已记录
- [x] 所有 checklist 任务已标记完成

---

## 后续行动建议

1. **立即可执行**: Sprint 1 任务（prompt 文件修复、ESLint 规则升级）
2. **需要评审**: 14 个新发现的 800-1200 行文件的处理优先级
3. **持续跟踪**: 使用本变更记录作为计划执行的基准

---

**变更记录完成时间**: 2026-01-31
