---
applyTo: "**/*"
---
# General Coding Standards

## Core Philosophy
- 不要造轮子：使用成熟的工具和库
- 代码简洁、可读、可维护
- 小步迭代、频繁提交

## Code Style
- 使用中文注释描述业务逻辑
- 代码标识符、变量名使用英文
- 单个文件 200-400 行为宜，最大不超过 800 行
- 函数不超过 50 行
- 嵌套不超过 4 层

## Error Handling
- 使用 Result 模式而非 try/catch 地狱
- 错误消息要有意义、可定位
- 关键路径必须有错误处理

## Performance
- 优先考虑算法复杂度
- 避免不必要的计算和渲染
- 使用适当的缓存策略

## Documentation
- 公共 API 必须有文档注释
- 复杂逻辑需要解释「为什么」
- README 保持最新