---
name: checkpoint
description: 保存当前状态作为检查点，便于回滚
agent: "agent"
---

创建验证状态检查点。

## 检查点流程

### 1. 保存当前状态
```bash
# 暂存所有更改
git add .

# 创建检查点提交
git commit -m "checkpoint: [描述]"
```

### 2. 记录状态

```markdown
# Checkpoint: [名称]

**时间**: YYYY-MM-DD HH:MM
**分支**: [branch-name]
**Commit**: [hash]

## 当前状态
- 已完成: [列表]
- 进行中: [列表]
- 待处理: [列表]

## 验证结果
- Build: ✅/❌
- Tests: ✅/❌ (X/Y passed)
- Lint: ✅/❌

## 重要注意
[任何需要记住的事项]
```

### 3. 如何恢复

```bash
# 查看检查点
git log --oneline | grep checkpoint

# 恢复到检查点
git revert HEAD --no-commit  # 撤销最后一次
# 或
git reset --hard [checkpoint-hash]  # 硬重置（丢失之后的更改）
```

## VS Code 检查点

VS Code Copilot 也支持 Chat Checkpoints：
- 在聊天历史中找到要恢复的请求
- 点击 "Restore Checkpoint"
- 确认恢复

## 最佳实践

**何时创建检查点**:
- 风险重构前
- 主要功能完成后
- 测试全部通过时
- 要尝试新方法前

**命名约定**:
```
checkpoint: 完成用户认证模块
checkpoint: 测试全部通过 - 准备重构
checkpoint: 开始性能优化前的稳定版本
```
