# Current Focus

> 上次更新：2025-01-28
> 来源：[everything-claude-code Memory Persistence](https://github.com/affaan-m/everything-claude-code)

## 当前工作焦点

### 正在进行

- [x] 完成 everything-claude-code 到 VS Code + Copilot 的全面映射
- [x] 为所有 Agent 添加 tools 配置
- [ ] 专注模式 (Focus Mode) 功能开发
  - Gate（大门）：用户每日首次打开应用时的仪式感入口
  - Spotlight（聚光灯）：高亮当前最重要的任务
  - Strata（地质层）：按日期分层展示历史记录
  - BlackBox（黑匣子）：语音转写快捷记录

### 已完成

- [x] 核心同步架构（Offline-first + LWW）
- [x] GoJS 流程图渲染
- [x] 基础认证流程
- [x] AI 工作流配置（agents/prompts/skills）
- [x] Agent tools 配置完善

### 阻塞问题

_目前无阻塞问题_

---

## 技术决策记录

### 最近决策

| 日期 | 决策 | 原因 |
|------|------|------|
| 2025-01-28 | 语音转写使用 Groq Edge Function 代理 | 安全性：API Key 不暴露在前端 |
| 2025-01-27 | 黑匣子条目使用客户端 UUID | 符合项目 ID 策略规范 |

---

## 关键上下文

- **项目**: NanoFlow
- **技术栈**: Angular 19 + Supabase + GoJS
- **当前分支**: main

---

## 下一步行动

1. 完成 Gate 组件的动画效果
2. 实现 BlackBox 录音按钮的 iOS Safari 兼容
3. 添加 Strata 视图的虚拟滚动

---

## 会话恢复提示

当开始新会话时，请：

1. 读取此文件了解当前焦点
2. 查看 `.github/learned/patterns.md` 了解已学习的模式
3. 使用 `@planner` 规划下一步任务
