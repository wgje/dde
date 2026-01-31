<!-- markdownlint-disable-file -->

# Task Details: 技术债务清理计划审查与更新

## Research Reference

**Source Research**: #file:../research/20260131-tech-debt-remediation-research.md

---

## Phase 1: 数据验证

### Task 1.1: 验证 console.* 调用数量

验证技术债务计划中声称的 console.* 调用数量。

- **Files**:
  - src/**/*.ts - 所有 TypeScript 源文件
- **验证命令**:
  ```bash
  grep -r "console\." /workspaces/dde/src --include="*.ts" | wc -l
  ```
- **Success**:
  - 实际值: 344
  - 计划声称: 343
  - 偏差: +0.3% ✅ 可接受
- **Research References**:
  - #file:../research/20260131-tech-debt-remediation-research.md (Lines 25-35)

---

### Task 1.2: 验证 setTimeout 使用数量

验证 setTimeout 滥用的实际数量。

- **Files**:
  - src/**/*.ts - 所有 TypeScript 源文件
- **验证命令**:
  ```bash
  grep -r "setTimeout" /workspaces/dde/src --include="*.ts" | wc -l
  ```
- **Success**:
  - 实际值: 191
  - 计划声称: 191
  - 偏差: 0% ✅ 完全准确
- **Research References**:
  - #file:../research/20260131-tech-debt-remediation-research.md (Lines 25-35)

---

### Task 1.3: 验证 @deprecated 方法数量

验证 deprecated 方法的实际数量。

- **Files**:
  - src/**/*.ts - 所有 TypeScript 源文件
- **验证命令**:
  ```bash
  grep -r "@deprecated" /workspaces/dde/src --include="*.ts" | wc -l
  ```
- **Success**:
  - 实际值: 27
  - 计划声称: 27
  - 偏差: 0% ✅ 完全准确
- **Research References**:
  - #file:../research/20260131-tech-debt-remediation-research.md (Lines 25-35)

---

### Task 1.4: 验证 any 类型数量

验证 any 类型使用的实际数量。

- **Files**:
  - src/**/*.ts - 所有 TypeScript 源文件
- **验证命令**:
  ```bash
  grep -r ": any" /workspaces/dde/src --include="*.ts" | wc -l
  ```
- **Success**:
  - 实际值: 36
  - 计划声称: 36
  - 偏差: 0% ✅ 完全准确
- **Research References**:
  - #file:../research/20260131-tech-debt-remediation-research.md (Lines 25-35)

---

### Task 1.5: 验证超 800 行文件数量

验证超大文件（>800 行）的实际数量和清单。

- **Files**:
  - src/**/*.ts - 所有 TypeScript 源文件（排除 spec）
- **验证命令**:
  ```bash
  find /workspaces/dde/src -name "*.ts" -not -name "*.spec.ts" \
    -exec wc -l {} + | awk '$1 > 800 {print}' | sort -rn
  ```
- **Success**:
  - 实际值: 27 个文件
  - 计划声称: 27 个文件
  - 偏差: 0% ✅ 完全准确
- **详细清单**:

| 排名 | 文件 | 行数 |
|------|------|------|
| 1 | simple-sync.service.ts | 4918 |
| 2 | flow-view.component.ts | 2555 |
| 3 | flow-diagram.service.ts | 2385 |
| 4 | task-operation.service.ts | 2279 |
| 5 | store-persistence.service.ts | 1550 |
| 6 | app.component.ts | 1499 |
| 7 | supabase.ts (类型定义) | 1492 |
| 8 | sync-coordinator.service.ts | 1463 |
| 9 | task-operation-adapter.service.ts | 1453 |
| 10 | action-queue.service.ts | 1429 |
| 11 | task-repository.service.ts | 1236 |
| 12 | flow-template.service.ts | 1231 |
| 13 | text-view.component.ts | 1206 |
| 14 | flow-task-detail.component.ts | 1143 |
| 15 | flow-link.service.ts | 1123 |
| 16 | migration.service.ts | 1074 |
| 17 | conflict-resolution.service.ts | 1057 |
| 18 | minimap-math.service.ts | 967 |
| 19 | change-tracker.service.ts | 958 |
| 20 | store.service.ts | 944 |
| 21 | dashboard-modal.component.ts | 902 |
| 22 | user-session.service.ts | 895 |
| 23 | indexeddb-health.service.ts | 838 |
| 24 | undo.service.ts | 827 |
| 25 | attachment-export.service.ts | 817 |
| 26 | text-view-drag-drop.service.ts | 809 |
| 27 | recovery-modal.component.ts | 803 |

- **Research References**:
  - #file:../research/20260131-tech-debt-remediation-research.md (Lines 40-85)

---

## Phase 2: 遗漏项发现

### Task 2.1: 发现额外的超大文件

计划中仅列出了 12 个致命级（>1200 行）文件，但实际存在更多需要关注的超大文件。

- **新发现的文件（800-1200 行，计划未提及）**:

| 文件 | 行数 | 建议优先级 | 建议处理方式 |
|------|------|------------|--------------|
| flow-task-detail.component.ts | 1143 | P2 | 提取子组件 |
| flow-link.service.ts | 1123 | P2 | 职责拆分 |
| migration.service.ts | 1074 | P3 | 保持（迁移逻辑复杂） |
| conflict-resolution.service.ts | 1057 | P2 | 策略模式拆分 |
| minimap-math.service.ts | 967 | P3 | 保持（数学计算） |
| change-tracker.service.ts | 958 | P2 | 提取辅助类 |
| store.service.ts | 944 | P1 | 继续删除代理方法 |
| dashboard-modal.component.ts | 902 | P3 | 提取子组件 |
| user-session.service.ts | 895 | P2 | 职责拆分 |
| indexeddb-health.service.ts | 838 | P3 | 保持 |
| undo.service.ts | 827 | P2 | 提取历史记录管理 |
| attachment-export.service.ts | 817 | P3 | 保持 |
| text-view-drag-drop.service.ts | 809 | P2 | 合并到统一交互服务 |
| recovery-modal.component.ts | 803 | P3 | 保持 |

- **建议**: 将以上文件加入技术债务清理计划的 Phase 3 或 Phase 4
- **Research References**:
  - #file:../research/20260131-tech-debt-remediation-research.md (Lines 86-110)

---

### Task 2.2: 验证 ESLint 禁用注释统计

验证 ESLint 禁用注释的实际数量。

- **验证命令**:
  ```bash
  # 仅生产代码（排除 spec）
  grep -rn "eslint-disable\|@ts-ignore\|@ts-expect-error" \
    /workspaces/dde/src --include="*.ts" | grep -v spec.ts | wc -l
  
  # 包含所有文件
  grep -rn "eslint-disable\|@ts-ignore\|@ts-expect-error" \
    /workspaces/dde/src --include="*.ts" | wc -l
  ```
- **发现**:
  - 生产代码: 4 处
  - 计划声称: 31 处
  - **偏差原因**: 计划可能包含了 spec 文件中的统计
- **建议**: 
  - 澄清统计口径（生产代码 vs 全部代码）
  - 如果 31 处包含测试文件，需要单独分类处理
- **Research References**:
  - #file:../research/20260131-tech-debt-remediation-research.md (Lines 111-125)

---

### Task 2.3: 验证 prompt 文件问题数量

验证包含无效 `tools:` 语法的 prompt 文件数量。

- **验证命令**:
  ```bash
  grep -l "tools:" /workspaces/dde/.github/prompts/*.md
  ```
- **发现**:
  - 实际数量: 8 个文件
  - 计划声称: 5 个文件
  - 偏差: +60%
- **受影响文件完整清单**:
  1. Bug Context Fixer.prompt.md
  2. gilfoyle.prompt.md
  3. implement.prompt.md
  4. refactor-clean.prompt.md
  5. research-technical-spike.prompt.md
  6. sql-optimization.prompt.md
  7. task-planner.agent.prompt.md
  8. task-researcher.prompt.md
- **建议**: 更新计划中的 M-05 任务，扩大修复范围
- **Research References**:
  - #file:../research/20260131-tech-debt-remediation-research.md (Lines 126-145)

---

### Task 2.4: 验证 injector hack 位置

验证使用 Injector 绕过依赖注入的位置。

- **验证命令**:
  ```bash
  grep -rn "injector\.get\|inject(Injector)" \
    /workspaces/dde/src --include="*.ts" | grep -v spec.ts
  ```
- **发现位置**:
  1. `src/services/auth.service.ts:48` - inject(Injector)
  2. `src/services/auth.service.ts:615` - injector.get()
  3. `src/services/task-operation-adapter.service.ts:72` - inject(Injector)
  4. `src/services/task-operation-adapter.service.ts:1170` - injector.get()
  5. `src/app/shared/components/attachment-manager.component.ts:261` - inject(Injector)
  6. `src/app/features/flow/components/flow-view.component.ts:699` - inject(Injector)
- **结论**: 与计划一致，确认需要通过事件总线模式解决循环依赖
- **Research References**:
  - #file:../research/20260131-tech-debt-remediation-research.md (Lines 146-170)

---

## Phase 3: 计划更新建议

### Task 3.1: 补充遗漏的超大文件到拆分计划

将 14 个遗漏的 800-1200 行文件加入技术债务清理计划。

- **建议添加到计划的位置**: Phase 3 或 Phase 4
- **预估额外工作量**: 7-10 人天
- **优先级排序**:
  - P1: store.service.ts (944行) - 继续清理代理方法
  - P2: 6 个服务文件（总计约 5,800 行）
  - P3: 7 个组件/低优先级文件

---

### Task 3.2: 更新 prompt 文件数量统计

更新计划中 M-05 任务的范围。

- **当前计划描述**: "prompt 文件配置错误 (5个)"
- **建议更新为**: "prompt 文件 tools: 语法错误 (8个)"
- **工作量调整**: 从 0.5d 调整为 1d

---

### Task 3.3: 澄清 ESLint 禁用注释统计口径

明确统计范围以便正确评估工作量。

- **建议**:
  - 分开统计：生产代码 4 处 / 测试代码 27 处
  - 优先处理生产代码中的禁用注释
  - 测试代码可作为低优先级处理

---

### Task 3.4: 更新工作量估算

考虑遗漏项后的工作量重新估算。

| 阶段 | 原修正估算 | 补充后估算 | 增幅 |
|------|------------|------------|------|
| 致命级 | 35-45 人天 | 35-45 人天 | 0% |
| 严重级 | 15-20 人天 | 17-22 人天 | +10% |
| 中等级 | 8-12 人天 | 12-16 人天 | +35% |
| 设计级 | 15-20 人天 | 18-24 人天 | +20% |
| **总计** | **73-97 人天** | **82-107 人天** | +10% |

**建议**: 
- 总工作量预留 20% 缓冲
- 最终估算: **100-130 人天** (约 20-26 周)

---

## Dependencies

- 研究文件已创建
- 计划文件待创建
- 原技术债务计划文档

## Success Criteria

- [x] 所有定量数据经过验证
- [x] 遗漏项被发现并记录
- [x] 统计口径偏差被识别
- [x] 计划更新建议已执行
