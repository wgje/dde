---
name: docs
description: 文档生成、更新和代码地图维护技能
triggers:
  - "@doc-updater"
  - "/docs"
---

# Documentation Skill

## 概述

此技能用于生成和维护项目文档，包括：
- README.md 更新
- API 文档生成
- 代码地图 (CODEMAPS) 维护
- 架构决策记录 (ADR)

## 使用方法

### 更新文档
```
/docs update README
```

### 生成代码地图
```
/docs codemap src/services
```

### 创建 ADR
```
/docs adr "使用 Signals 替代 BehaviorSubject"
```

## 文档模板

### README 模板
```markdown
# 项目名

> 一句话描述

## 快速开始

1. 安装依赖
   ```bash
   npm install
   ```

2. 启动开发服务器
   ```bash
   npm start
   ```

## 功能特性

- 功能1
- 功能2

## API 参考

详见 API 文档

## 贡献指南

详见贡献指南
```

### 代码地图模板
```markdown
# Code Map: [模块名]

## 目录结构
[ASCII 树]

## 模块职责
[每个文件的职责说明]

## 依赖关系
[模块间依赖图]

## 关键流程
[重要流程的序列图或流程图]
```

## 自动化检查

运行文档质量检查：
```bash
# 检查链接
npx markdown-link-check README.md

# 检查拼写
npx cspell "**/*.md"
```
