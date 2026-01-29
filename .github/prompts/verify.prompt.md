---
name: verify
description: 运行完整验证循环：Build → Type → Lint → Test → Coverage
agent: "agent"
---

执行完整的项目验证循环。

## 验证步骤（按顺序执行）

### 1. Build 检查
```bash
npm run build
```
如果失败，报告错误并**停止**。

### 2. Type 检查
```bash
npx tsc --noEmit
```
报告所有错误及文件:行号。

### 3. Lint 检查
```bash
npm run lint
```
报告警告和错误。

### 4. 测试套件
```bash
npm run test:run
```
报告通过/失败数量和覆盖率。

### 5. Console.log 审计
```bash
grep -rn "console.log" --include="*.ts" src/
```
报告位置（测试文件除外）。

### 6. Git 状态
```bash
git status
git diff --name-only HEAD~1
```
显示未提交更改和最近修改文件。

## 输出格式

```markdown
# Verification Report

**时间**: YYYY-MM-DD HH:MM
**分支**: [branch-name]

## 状态总览

| 检查项 | 状态 | 详情 |
|--------|------|------|
| Build | ✅/❌ | - |
| Types | ✅/❌ | X errors |
| Lint | ✅/❌ | X warnings |
| Tests | ✅/❌ | X/Y passed |
| Coverage | XX% | Target: 80% |

## 详细结果

### Build
[输出或 ✅ Passed]

### Type Errors
```
[错误列表]
```

### Lint Issues
```
[警告/错误列表]
```

### Test Results
```
✅ X tests passed
❌ Y tests failed
📊 Coverage: XX%
```

### Console.log 发现
```
[位置列表]
```

### Git Status
```
Modified: X files
Staged: Y files
Untracked: Z files
```

## 总结

**状态**: ✅ Ready / ⚠️ Issues Found / ❌ Blocked

**下一步**:
1. [建议操作1]
2. [建议操作2]
```
