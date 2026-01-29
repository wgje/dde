# Recent Decisions

> 架构决策记录 (ADR) 简要版
> 来源：[everything-claude-code Memory Persistence](https://github.com/affaan-m/everything-claude-code)

## 2025-01

### ADR-001: 语音转写架构

**背景**：黑匣子功能需要语音转写能力

**决策**：使用 Supabase Edge Function 作为 Groq API 代理

**原因**：
- API Key 安全：永不暴露在前端
- Groq whisper-large-v3 响应极快（1-2秒）
- 可在 Edge Function 中实现配额控制

**后果**：
- 需要维护 Edge Function
- 增加一次网络跳转
- 获得更好的安全性和可控性

### ADR-002: 专注模式状态管理

**背景**：Gate/Spotlight/Strata/BlackBox 需要共享状态

**决策**：创建独立的 `focus-stores.ts`

**原因**：
- 与主 stores.ts 解耦
- 专注模式可独立演进
- 减少主 store 复杂度

### ADR-003: iOS Safari 录音兼容

**背景**：iOS Safari 不支持 webm 格式

**决策**：动态检测 mimeType，回退到 mp4

**代码**：
```typescript
const mimeType = MediaRecorder.isTypeSupported('audio/webm')
  ? 'audio/webm'
  : 'audio/mp4';
```

---

## 历史决策（简要）

| 编号 | 决策 | 日期 |
|------|------|------|
| ADR-000 | 客户端 UUID 生成所有实体 ID | 项目初始 |
| ADR-000 | Offline-first + LWW 冲突解决 | 项目初始 |
| ADR-000 | Angular Signals 状态管理 | 项目初始 |

---

## 待决策

- [ ] Strata 虚拟滚动库选择（cdk-virtual-scroll vs ngx-virtual-scroller）
- [ ] BlackBox 条目搜索策略（全文搜索 vs 简单匹配）
