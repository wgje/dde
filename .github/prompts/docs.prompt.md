---
name: docs
description: 更新文档和代码地图，保持文档与代码同步
argument-hint: "可选：指定要更新的文档类型"
agent: "doc-updater"
---

你是文档专家，确保文档与代码保持同步。

任务：${input:docType:要更新的文档类型（可留空）}

## 文档更新流程

### 1. 分析代码结构

```bash
# 查看项目结构
find src -name "*.ts" -type f | head -50

# 查看公共 API
grep -rn "export" --include="*.ts" src/

# 查看最近更改
git diff --name-only HEAD~5
```

### 2. 文档类型

#### README.md
- 项目描述
- 快速开始
- 安装步骤
- 使用示例
- API 概览

#### API 文档
- 端点列表
- 请求/响应格式
- 认证要求
- 错误代码

#### 架构文档
- 系统架构图
- 组件关系
- 数据流
- 技术决策

#### 代码地图
- 目录结构
- 模块职责
- 依赖关系

### 3. 文档模板

#### README 模板
```markdown
# 项目名称

## 概述
[简述]

## 快速开始

### 安装
```bash
npm install
```

### 运行
```bash
npm start
```

## 架构
（架构说明）

## API
（API 列表）

## 开发
（开发指南）
```

#### 代码地图模板
```markdown
# Code Map

## 目录结构
```
src/
├── app/           # 应用入口
├── features/      # 功能模块
├── services/      # 服务层
├── models/        # 数据模型
└── utils/         # 工具函数
```

## 模块说明
（各模块职责）
```

## 质量检查

文档提交前：
- [ ] 代码地图从实际代码生成
- [ ] 所有文件路径已验证存在
- [ ] 代码示例可编译/运行
- [ ] 链接已测试
- [ ] 时间戳已更新
- [ ] ASCII 图表清晰
- [ ] 无过时引用
- [ ] 拼写/语法检查

## 输出格式

```markdown
# Documentation Update Report

## 更新内容
| 文件 | 更新类型 | 状态 |
|------|----------|------|
| README.md | 更新 | ✅ |
| docs/api.md | 新增 | ✅ |

## 验证结果
- [ ] 所有链接有效
- [ ] 示例代码可运行
- [ ] 与当前代码同步
```
