---
applyTo: ".git/**,**/.gitignore"
---
# Git Workflow Standards

## Commit Messages

### Format
```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types
- `feat`: 新功能
- `fix`: 修复 bug
- `docs`: 文档变更
- `style`: 代码格式（不影响逻辑）
- `refactor`: 重构（非 fix/feat）
- `perf`: 性能优化
- `test`: 测试相关
- `chore`: 构建/工具变更

### Examples
```
feat(focus): add black-box voice recording

- Implement speech-to-text using Groq API
- Add recording UI with waveform visualization
- Store transcriptions in IndexedDB

Closes #123
```

```
fix(sync): prevent duplicate task creation

Race condition in offline mode caused duplicate UUIDs.
Added mutex lock during batch operations.
```

## Branch Strategy

### Naming
```
feature/focus-mode-gate
fix/sync-race-condition
refactor/store-signals
docs/api-reference
```

### Workflow
1. 从 `main` 创建分支
2. 小步提交，频繁推送
3. PR 前 rebase `main`
4. 通过 CI 后合并

## PR Guidelines

### Title
同 commit message 格式

### Description
- 变更内容
- 测试方法
- 截图（UI 变更）
- 相关 Issue

### Checklist
- [ ] 代码自审
- [ ] 测试通过
- [ ] 文档更新
- [ ] 无冲突

## .gitignore

### 必须忽略
```
node_modules/
dist/
.env
.env.local
*.log
.DS_Store
```

### 禁止忽略
```
# 不要忽略这些
package-lock.json
.github/
```

## Hooks

### Pre-commit
- Lint 检查
- 类型检查
- 单元测试

### Pre-push
- 完整测试
- 构建验证
