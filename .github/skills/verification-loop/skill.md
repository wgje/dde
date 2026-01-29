---
name: verification-loop
description: 实现后自动验证的循环机制，确保代码质量
version: 1.0.0
triggers:
  - "@implementation"
  - "/verify"
---

# 验证循环技能

确保每次代码变更后都经过完整的验证流程。

## 验证循环流程

```
代码变更
    │
    ▼
┌─────────────────────────────────────────┐
│  1. 类型检查 (TypeScript)               │
│     npm run typecheck                   │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  2. Lint 检查                           │
│     npm run lint                        │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  3. 单元测试                            │
│     npm run test:run                    │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  4. 构建验证                            │
│     npm run build                       │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│  5. E2E 测试（如果涉及用户流程）         │
│     npm run test:e2e                    │
└─────────────────────────────────────────┘
    │
    ▼
    ✅ 全部通过 → 完成
    ❌ 有失败 → 修复后重新验证
```

## 验证级别

| 级别 | 检查项 | 触发条件 |
|------|--------|----------|
| **快速** | TypeScript + Lint | 每次保存 |
| **标准** | + 单元测试 | 每次提交前 |
| **完整** | + 构建 + E2E | 每次 PR/推送前 |

## 使用方式

### 1. 快速验证

```
/verify quick

只运行类型检查和 lint
```

### 2. 标准验证

```
/verify

运行完整的测试套件
```

### 3. 完整验证

```
/verify full

包括 E2E 测试
```

## 验证失败处理

当验证失败时：

1. **分析错误**: 查看具体失败原因
2. **定位问题**: 使用错误信息定位代码
3. **修复问题**: 进行最小化修复
4. **重新验证**: 确保修复没有引入新问题

```
验证失败示例：

❌ TypeScript 错误: src/services/task.service.ts:42
   Property 'foo' does not exist on type 'Task'

修复建议：
1. 检查 Task 接口定义
2. 添加缺失的属性或修正属性名
3. 重新运行 /verify
```

## 与 CI/CD 集成

本技能与 Git Hooks 配合使用：

```bash
# .husky/pre-commit
npm run lint
npm run test:run

# .husky/pre-push
npm run build
npm run test:e2e
```

## 与 everything-claude-code 的映射

| everything-claude-code | 本项目实现 |
|------------------------|------------|
| PostToolUse 自动检查 | 依赖 VS Code 保存时检查 |
| Stop hook 最终验证 | 手动 `/verify` |
| TypeScript check hook | `npm run typecheck` |
| Prettier hook | `formatOnSave` 设置 |

## 最佳实践

1. **频繁验证**: 小步修改，频繁验证
2. **修复优先**: 验证失败时先修复再继续
3. **不跳过验证**: 即使 "只是小改动" 也要验证
4. **关注警告**: 警告可能演变为错误

## NanoFlow 项目特定验证

```bash
# 快速验证
npm run lint

# 标准验证
npm run test:run

# 完整验证
npm run build && npm run test:e2e

# Supabase 类型验证
npm run update-types
```
