# 项目上下文

> 此目录用于会话间的上下文持久化。
>
> **来源**: [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) 的 Memory Persistence 功能

## 目录结构

```
context/
├── README.md           # 此文件
├── current-focus.md    # 当前工作焦点
├── recent-decisions.md # 近期重要决策
└── blockers.md         # 当前阻塞问题
```

## 使用方式

### 1. 保存上下文

在完成重要工作或切换任务前：

```
/checkpoint "完成了用户认证模块的基本实现"
```

或手动更新 `current-focus.md`。

### 2. 恢复上下文

在新对话开始时：

```
请阅读 .github/context/ 目录中的文件，恢复工作上下文
```

### 3. 更新焦点

当任务变化时，更新 `current-focus.md`。

## 与 everything-claude-code 的对应

| 原始 Hook | 本目录实现 |
|-----------|------------|
| SessionStart | 开始时读取 context/ |
| PreCompact | 更新 context/ 后压缩 |
| Stop | 结束时更新 context/ |
