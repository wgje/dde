# 专注模式（Focus Mode）策划案

> **核心理念**：任务不是静态的文本，而是必须流动的流体。堵住了，就得先疏通；流下去了，就变成了地基。

---

## 〇、审查摘要与变更记录

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| 1.0 | 2026-01-22 | 初始策划案 |
| 1.1 | 2026-01-22 | 深度审查优化：补充离线同步、权限校验、API 成本控制、错误处理、可访问性、数据迁移等 |
| 1.2 | 2026-01-23 | 技术架构升级：采用 Groq + Supabase Edge Function 三明治架构，替换 OpenAI Whisper |
| 1.3 | 2026-01-23 | 代码实现验证：修复 Edge Function Deno 语法、RLS 策略拆分、iOS Safari 兼容、完整离线队列 |
| 1.4 | 2026-02-07 | 实现审查修复：BlackBoxSync 持久化队列集成、FocusPreference 云同步、离线录音自动创建条目、键盘/ARIA 无障碍完善 |
| 1.5 | 2026-02-27 | 停泊坞专注控制台策划案独立成文（详见 [`focus-console-design.md`](./focus-console-design.md)）；本文聚焦大门/聚光灯/地质层/黑匣子模块 |
| 1.6 | 2026-03-08 | 联动口径同步：专注控制台术语改为“主控台 + 组合选择区域 + 备选区域”；主任务与当前 C 位分离；等待调度只推荐不强切；退出专注保留三分支；就地新建任务静默留在共享黑匣子，后续手动归档 |

### 技术架构亮点

```
┌─────────────────┐     ┌──────────────────────────┐     ┌─────────────────┐
│  Angular 前端    │     │  Supabase Edge Function  │     │    Groq API     │
│  ─────────────  │ ──► │  ──────────────────────  │ ──► │  ─────────────  │
│  采集麦克风数据   │     │  持有 GROQ_API_KEY       │     │  whisper-large  │
│  打包成 Blob     │     │  接收 Blob，转发给 Groq   │     │  -v3 转写       │
└─────────────────┘     └──────────────────────────┘     └─────────────────┘
```

**三明治架构优势**：
- ✅ **安全**：API Key 永不暴露在前端（通过 `supabase secrets set` 存储）
- ✅ **极速**：Groq 转写响应通常 1-2 秒（比 OpenAI 快 5-10 倍）
- ✅ **低成本**：Groq 比 OpenAI Whisper 更便宜
- ✅ **无需自建后端**：Supabase Edge Function 即开即用

### 审查发现的问题（已全部解决）

| 问题 | 状态 | 解决方案 |
|------|------|----------|
| ID 策略违规 | ✅ 已修复 | 移除 `DEFAULT gen_random_uuid()`，客户端生成 |
| 缺少离线同步 | ✅ 已修复 | 遵循 Offline-first，IndexedDB + RetryQueue |
| API Key 硬编码 | ✅ 已修复 | Edge Function 代理，`supabase secrets` 存储 |
| 缺少错误处理 | ✅ 已修复 | Result Pattern + FocusErrorCodes |
| 缺少可访问性 | ✅ 已修复 | 键盘快捷键 + ARIA 标签 |
| 缺少配额控制 | ✅ 已修复 | 每用户每日 50 次限额 |
| 缺少用户偏好 | ✅ 已修复 | 可在设置中禁用大门 |
| Edge Function 语法错误 | ✅ 已修复 | 更新 Deno 导入、FormData 类型安全、错误类型守卫 |
| RLS 策略单一 | ✅ 已修复 | 按操作拆分（SELECT/INSERT/UPDATE/DELETE） |
| iOS Safari 不支持 webm | ✅ 已修复 | 动态检测 mimeType，回退到 mp4 |
| 离线队列不完整 | ✅ 已修复 | IndexedDB 存储 + 网络恢复自动重试 |
| 配额检查 RLS 绕过问题 | ✅ 已修复 | 使用 service_role 密钥 |

---

## 一、功能概述

### 1.1 设计背景

传统任务管理工具存在的问题：
- 把所有未完成条目堆积在一起，像一座随时会坍塌的垃圾山
- 列表给人虚假的掌控感，看到昨天没勾掉的红字，大脑的第一反应是"逃跑"而非"开工"
- 自动顺延过期任务导致麻木，失去对时间的敏感度


### 1.2 核心模块

| 模块 | 命名 | 功能 |
|------|------|------|
| 大门 | Gate | 强制结算昨日遗留，不处理不放行 |
| 聚光灯 | Spotlight | 极简单任务执行，屏蔽一切噪音 |
| 地质层 | Strata | 已完成任务堆叠可视化，历史即地基 |
| 黑匣子 | Black Box | 语音转文字的紧急捕捉，允许"精神坠机" |
| **停泊坞** | **Docking Bay** | **跨项目任务资源池，从任意板块拖入任务，切换项目不收回。详见 [`parking-dock-modular-design.md`](./parking-dock-modular-design.md)** |
| **专注控制台** | **Focus Console** | **停泊坞进入专注模式后的三区可视化界面（主控台 + 组合选择区域 + 备选区域）。主任务是本轮锚点，不等于当前 C 位。详见 [`focus-console-design.md`](./focus-console-design.md)** |

> **Focus Console 联动摘要（2026-03-08）**：
> 1. 主任务与当前 C 位分离，等待结束只提醒不强切。
> 2. 等待期间系统只给三类推荐，不再自动晋升副任务。
> 3. 就地新建任务进入共享黑匣子；退出专注不做强制归档，后续由用户手动归档。
> 4. 日常任务槽仅在全悬挂留白期自动出现，不在普通碎片期打断。

### 1.3 核心流向

```
┌─────────────────────────────────────────────────────────────────┐
│  启动应用                                                        │
└─────────────────┬───────────────────────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  🚪 大门 (Gate)                                                  │
│  ────────────────                                                │
│  昨日未完成条目逐一展示                                            │
│  必须对每个条目做出裁决：已读 / 完成                                │
│  全部处理完毕才能通过                                              │
└─────────────────┬───────────────────────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  🔦 聚光灯 (Spotlight)                                           │
│  ────────────────                                                │
│  屏幕正中央只显示一件事                                            │
│  做完划走，下一件才浮现                                            │
│  背景隐约可见地质层                                                │
└─────────────────┬───────────────────────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  🗻 地质层 (Strata)                                              │
│  ────────────────                                                │
│  已完成任务下沉堆叠                                                │
│  新记录覆盖旧记录                                                  │
│  下滑可见层层战绩                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、模块详细设计

### 2.1 大门 (Gate)

> **设计理念**：  
> 大门并非为了"惩罚"，而是为了"阻断"。视觉上采用**沉浸式地质层纹理 (Sedimentary Texture)**，像一块巨石挡在面前，代表着昨天积累的重量。用户必须"搬开"（处理）这些重量，才能进入今日的轻盈状态。质感上与"地质层"模块呼应，采用厚重的岩石色调与层积纹理。

#### 2.1.1 触发条件

- 每日首次打开应用
- 存在前一天未标记"完成"的黑匣子条目

#### 2.1.2 交互逻辑

```
┌──────────────────────────────────────────────────┐
│                    大门界面                        │
│  ┌────────────────────────────────────────────┐  │
│  │                                            │  │
│  │  📋 昨日遗留 (2/5)                          │  │
│  │                                            │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │                                      │  │  │
│  │  │  "先做A模块，然后连B数据库，          │  │  │
│  │  │   不对，那个接口有问题，要先弄C..."   │  │  │
│  │  │                                      │  │  │
│  │  │  ─────────────────────────────────   │  │  │
│  │  │  🕐 昨天 21:34                        │  │  │
│  │  │                                      │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  │                                            │  │
│  │  ┌─────────────┐    ┌─────────────────┐   │  │
│  │  │   👁️ 已读   │    │   ✅ 已完成     │   │  │
│  │  └─────────────┘    └─────────────────┘   │  │
│  │                                            │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│  (背景模糊遮罩，阻止点击后方内容)                    │
└──────────────────────────────────────────────────┘
```

#### 2.1.3 按钮行为

| 按钮 | 行为 | 条目状态变更 |
|------|------|-------------|
| 👁️ 已读 | 条目标记为已读，进入下一条 | `isRead: true` |
| ✅ 已完成 | 条目标记为完成，进入下一条 | `isCompleted: true` |
| ⏭️ 稍后提醒 | 跳过当前条目，下次打开再提醒 | `snoozeUntil: tomorrow` |

> **🆕 新增"稍后提醒"**：缓解用户因强制阻塞产生的烦躁情绪，允许最多跳过 3 次

#### 2.1.4 状态机

```typescript
type GateState = 
  | 'checking'      // 检查是否有遗留条目
  | 'reviewing'     // 展示遗留条目中
  | 'completed'     // 全部处理完毕
  | 'bypassed'      // 无遗留条目，直接通过
  | 'disabled';     // 用户禁用大门功能（在设置中关闭）

interface GateContext {
  pendingItems: BlackBoxEntry[];
  currentIndex: number;
  state: GateState;
  snoozeCount: number;  // 🆕 当日已跳过次数，上限 3
}
```

#### 2.1.5 用户偏好（🆕 新增）

```typescript
// 允许用户在设置中关闭大门功能
interface FocusPreferences {
  gateEnabled: boolean;           // 是否启用大门（默认 true）
  spotlightEnabled: boolean;      // 是否启用聚光灯模式
  blackBoxEnabled: boolean;       // 是否启用黑匣子
  maxSnoozePerDay: number;        // 每日最大跳过次数（默认 3）
}
```

#### 2.1.6 UI 规范

```css
/* 大门遮罩层 */
.gate-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  backdrop-filter: blur(12px); /* 加重模糊，增强隔绝感 */
  background: rgba(28, 25, 23, 0.7); /* stone-950 alpha */
}

/* 大门卡片 - 地质层设计语言 */
.gate-card {
  /* 基础质感：沉积岩/石板 */
  @apply bg-stone-50/98 dark:bg-stone-800/98;
  
  /* 轮廓：厚重且有层次感 */
  @apply rounded-xl;
  @apply border-x-2 border-t-2 border-stone-300 dark:border-stone-600;
  @apply border-b-8 border-b-stone-400 dark:border-b-stone-700; /* 加厚底部，模拟重力与沉积 */
  
  /* 深度与阴影 */
  @apply shadow-2xl shadow-stone-900/50;
  @apply max-w-md mx-auto;
  @apply animate-slide-up;
}

/* 进度指示器 */
.gate-progress {
  @apply text-xs font-bold tracking-wider;
  @apply text-stone-500 dark:text-stone-400;
  @apply uppercase; /* 类似铭文的刻印感 */
}

/* 🆕 焦点捕获：确保键盘可访问 */
.gate-overlay:focus-within {
  outline: none;
}

.gate-card:focus-visible {
  @apply ring-4 ring-stone-400/50 ring-offset-2 ring-offset-stone-900;
}
```

---

### 2.2 聚光灯 (Spotlight)

#### 2.2.1 设计原则

- **切断选择**：选择是痛苦的、耗能的，系统替你屏蔽干扰
- **单点聚焦**：屏幕正中央只显示一件事
- **连续性提示**：背景隐约可见地质层，提醒进度的连续性

#### 2.2.2 界面结构

```
┌──────────────────────────────────────────────────┐
│                                                  │
│                 🔦 今日专注                       │
│                                                  │
│     ┌────────────────────────────────────┐       │
│     │                                    │       │
│     │      完成用户认证模块重构            │       │
│     │                                    │       │
│     │  ────────────────────────────────  │       │
│     │                                    │       │
│     │  "需要先处理OAuth回调问题，         │       │
│     │   然后测试JWT刷新逻辑..."          │       │
│     │                                    │       │
│     │          ┌──────────────┐          │       │
│     │          │   ✅ 完成    │          │       │
│     │          └──────────────┘          │       │
│     │                                    │       │
│     └────────────────────────────────────┘       │
│                                                  │
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│  (下方隐约可见已完成任务的地质层)                   │
│                                                  │
└──────────────────────────────────────────────────┘
```

#### 2.2.3 交互行为

| 操作 | 行为 |
|------|------|
| 点击"完成" | 当前任务下沉至地质层，下一个任务浮现 |
| 向下滑动 | 查看地质层历史记录 |
| 长按任务卡片 | 展开详情/编辑 |

#### 2.2.4 任务来源优先级

```typescript
// 聚光灯任务选择逻辑
function getSpotlightTask(): Task | null {
  // 1. 优先显示黑匣子中标记为"已读但未完成"的条目
  const pendingBlackBox = getUncompletedReadEntries();
  if (pendingBlackBox.length > 0) {
    return convertToTask(pendingBlackBox[0]);
  }
  
  // 2. 其次显示待办事项中排序最高的任务
  const todoTasks = getTodoTasks();
  if (todoTasks.length > 0) {
    return todoTasks[0];
  }
  
  // 3. 无任务时显示空状态
  return null;
}
```

---

### 2.3 地质层 (Strata)

#### 2.3.1 设计理念

- 已完成任务不该是点击归档才能看到的历史记录
- 像地质层一样沉淀在界面底部
- 物理上的堆叠感比冷冰冰的打勾更有力量

#### 2.3.2 视觉结构

```
┌──────────────────────────────────────────────────┐
│                                                  │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │  ← 今日新增层
│  ░░ ✅ 完成用户认证模块重构  ░░░░░░░░░░░░░░░░░░  │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│  ──────────────────────────────────────────────  │  ← 日期分隔线
│  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  │  ← 昨日层
│  ▒▒ ✅ 修复支付接口bug  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  │
│  ▒▒ ✅ 优化首页加载速度  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  │
│  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  │
│  ──────────────────────────────────────────────  │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │  ← 更早的层
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │
│                                                  │
└──────────────────────────────────────────────────┘
```

#### 2.3.3 视觉层级

| 时间 | 透明度 | 颜色 | 交互 |
|------|--------|------|------|
| 今日 | 100% | 主色调 | 可展开查看详情 |
| 昨日 | 70% | 次色调 | 可展开查看详情 |
| 更早 | 40% | 灰色调 | 折叠为摘要 |

---

### 2.4 黑匣子 (Black Box)

#### 2.4.1 设计理念

> 飞机坠毁了，只有黑匣子能告诉后人（明天的你）当时发生了什么。

- 允许"精神坠机"的宽容设计
- 降低记录精度以对抗厌倦
- 把"说话"当作输入方式，而非"录音"当作存储格式

#### 2.4.2 核心交互

```
┌──────────────────────────────────────────────────┐
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  📦 黑匣子                          展开 ▼  │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │                                            │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │  🎤  按住说话，松开转文字             │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  │                                            │  │
│  │  ─────────── 2025-01-22 ───────────       │  │
│  │                                            │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │ "先做A模块，然后连B数据库..."        │  │  │
│  │  │                              21:34   │  │  │
│  │  │  ┌─────┐ ┌─────┐ ┌─────────┐        │  │  │
│  │  │  │ 👁️  │ │ ✅  │ │ 📁 归档 │        │  │  │
│  │  │  └─────┘ └─────┘ └─────────┘        │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  │                                            │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │ "那个接口有问题，要先弄C..."         │  │  │
│  │  │                              21:32   │  │  │
│  │  │  ┌─────┐ ┌─────┐ ┌─────────┐        │  │  │
│  │  │  │ 👁️  │ │ ✅  │ │ 📁 归档 │        │  │  │
│  │  │  └─────┘ └─────┘ └─────────┘        │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  │                                            │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
└──────────────────────────────────────────────────┘
```

#### 2.4.3 条目状态

```typescript
interface BlackBoxEntry {
  id: string;                    // UUID
  content: string;               // 语音转写的文本
  createdAt: string;             // ISO 时间戳
  date: string;                  // YYYY-MM-DD，用于按日分组
  
  // 状态
  isRead: boolean;               // 是否已读
  isCompleted: boolean;          // 是否已完成
  isArchived: boolean;           // 是否已归档
  
  // 元数据
  originalAudioDuration?: number; // 原始音频时长（秒），转写后删除音频
}
```

#### 2.4.4 按钮行为

| 按钮 | 图标 | 行为 |
|------|------|------|
| 已读 | 👁️ | 标记为已读，不会在大门中出现 |
| 完成 | ✅ | 标记为完成，计入地质层 |
| 归档 | 📁 | 移入归档区，不显示在主列表 |

#### 2.4.5 语音转文字技术方案

> **架构原则**：三明治架构 - Angular（前端采集）→ Supabase Edge Function（中转代理）→ Groq（引擎）

```
┌─────────────────┐     ┌──────────────────────────┐     ┌─────────────────┐
│  Angular 前端    │     │  Supabase Edge Function  │     │    Groq API     │
│  ─────────────  │ ──► │  ──────────────────────  │ ──► │  ─────────────  │
│  采集麦克风数据   │     │  持有 GROQ_API_KEY       │     │  whisper-large  │
│  打包成 Blob     │     │  接收 Blob，转发给 Groq   │     │  -v3 转写       │
│  调用 Edge Func  │ ◄── │  拿到文字返回             │ ◄── │  返回转写文本    │
└─────────────────┘     └──────────────────────────┘     └─────────────────┘
```

**⚠️ 安全原则**：千万不要把 API Key 放在 Angular 前端代码里（即使是 environment.ts 也不行）。浏览器是透明的，任何人都能 F12 拿走你的 Key。

**选型理由：Groq vs OpenAI Whisper**

| 对比项 | Groq (whisper-large-v3) | OpenAI Whisper |
|--------|------------------------|----------------|
| 速度 | 极快（1-2秒内响应） | 较慢（5-10秒） |
| 成本 | 更低 | 较高 |
| 模型 | 开源 whisper-large-v3 | 闭源 |
| 中文支持 | ✅ 优秀 | ✅ 优秀 |

```typescript
// ⚠️ 重要：API Key 不能暴露在前端！
// 技术选型：前端采集 + Supabase Edge Function 代理转写

// 前端采集（浏览器原生API）
async function startRecording(): Promise<MediaRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream, { 
    mimeType: 'audio/webm;codecs=opus' 
  });
  return recorder;
}

// 🆕 通过 Supabase Edge Function 调用 Groq 转写（保护 API Key）
async function transcribeAudio(audioBlob: Blob): Promise<Result<string, OperationError>> {
  const formData = new FormData();
  formData.append('file', audioBlob, 'recording.webm');
  
  try {
    // 调用 Supabase Edge Function，而非直接调用 Groq
    const { data, error } = await supabase.functions.invoke('transcribe', {
      body: formData,
    });
    
    if (error) {
      return failure(ErrorCodes.TRANSCRIBE_FAILED, error.message);
    }
    
    return success(data.text);
  } catch (error) {
    return failure(ErrorCodes.NETWORK_ERROR, '转写请求失败');
  }
}

// 关键原则：转写完成后立即删除音频源文件
// 只存储文本，不维护音频文件
// 音频文件在整个过程中只是一个过客，用完即弃，没有任何存储成本
```

#### 2.4.6 Edge Function 实现（Groq + Deno）

**初始化函数**：
```bash
# 假设你已经装了 supabase cli
supabase functions new transcribe
```

**设置环境变量**（把 Groq Key 安全存储在 Supabase）：
```bash
# ⚠️ 永远不要把 Key 写在代码里
supabase secrets set GROQ_API_KEY=gsk_your_actual_key_here
```

**部署函数**：
```bash
supabase functions deploy transcribe
```

**Edge Function 代码**：
```typescript
// supabase/functions/transcribe/index.ts
// 注意：这里是用 Deno 运行的 TypeScript

// Deno 标准库和 Supabase 依赖
// 需要在 supabase/functions/transcribe/deno.json 中配置 import_map
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const DAILY_QUOTA_PER_USER = 50 // 每用户每日限额

serve(async (req: Request) => {
  // 处理跨域预检
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. 认证检查
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }), 
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ⚠️ 使用 SUPABASE_SERVICE_ROLE_KEY 查询配额（绕过 RLS）
    // 但用户认证仍使用传入的 authHeader
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!  // Edge Function 可以安全使用 service_role
    )
    
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }), 
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 2. 配额检查（使用 service_role 查询，确保准确）
    const today = new Date().toISOString().split('T')[0]
    const { count, error: countError } = await supabaseAdmin
      .from('transcription_usage')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('date', today)

    if (countError) {
      console.error('Quota check error:', countError)
      // 配额检查失败时仍允许请求，避免影响正常使用
    } else if ((count ?? 0) >= DAILY_QUOTA_PER_USER) {
      return new Response(
        JSON.stringify({ error: '今日转写次数已达上限', code: 'QUOTA_EXCEEDED' }), 
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 3. 从 Angular 接收 FormData (包含录音文件)
    const formData = await req.formData()
    const audioFile = formData.get('file') as File | null

    if (!audioFile || !(audioFile instanceof File)) {
      return new Response(
        JSON.stringify({ error: 'No audio file uploaded' }), 
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 4. 检查文件大小（限制 25MB，Groq 限制）
    const MAX_FILE_SIZE = 25 * 1024 * 1024
    if (audioFile.size > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ error: '音频文件过大，请控制在 25MB 以内' }), 
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 5. 准备发给 Groq 的数据
    const groqFormData = new FormData()
    groqFormData.append('file', audioFile)
    groqFormData.append('model', 'whisper-large-v3')  // Groq 目前最强的开源模型
    // 可选：设置 prompt 引导模型输出简体中文
    groqFormData.append('prompt', '这是一段关于软件开发的项目思路，请用简体中文转写')
    groqFormData.append('language', 'zh')  // 强制中文

    // 6. 调用 Groq API（走 OpenAI 兼容接口）
    const groqApiKey = Deno.env.get('GROQ_API_KEY')
    if (!groqApiKey) {
      console.error('GROQ_API_KEY not configured')
      return new Response(
        JSON.stringify({ error: '转写服务未配置' }), 
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const groqResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
      },
      body: groqFormData,
    })

    if (!groqResponse.ok) {
      const errorText = await groqResponse.text()
      console.error('Groq Error:', groqResponse.status, errorText)
      
      // 根据 Groq 错误码返回合适的响应
      if (groqResponse.status === 429) {
        return new Response(
          JSON.stringify({ error: 'Groq API 请求过于频繁，请稍后再试' }), 
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      return new Response(
        JSON.stringify({ error: '转写服务暂不可用' }), 
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const data = await groqResponse.json()

    // 7. 记录使用量（异步，不阻塞响应）
    // 使用 EdgeRuntime.waitUntil 确保后台任务完成
    const recordUsage = async () => {
      try {
        await supabaseAdmin.from('transcription_usage').insert({
          id: crypto.randomUUID(),
          user_id: user.id,
          date: today,
          audio_seconds: Math.round(audioFile.size / 16000)  // 估算：webm opus 约 16KB/s
        })
      } catch (e) {
        console.error('Failed to record usage:', e)
      }
    }
    // Deno Deploy 支持 waitUntil
    // @ts-ignore - EdgeRuntime 在 Supabase Edge Functions 中可用
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      EdgeRuntime.waitUntil(recordUsage())
    } else {
      // 本地开发时同步执行
      await recordUsage()
    }

    // 8. 返回转写后的文本给 Angular
    return new Response(JSON.stringify({ text: data.text }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error: unknown) {
    console.error('Transcribe Error:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
```

**关键点说明**：
- **Groq 速度极快**：`Thinking...` 状态通常在 1-2 秒内结束
- **OpenAI 兼容接口**：Groq 使用 `/openai/v1/audio/transcriptions`，方便迁移
- **安全隔离**：GROQ_API_KEY 安全地躺在 Supabase 环境变量里，前端只负责传 Blob
- **配额控制**：每用户每日 50 次，防止滥用

#### 2.4.7 开源参考

| 项目 | 用途 | 链接 |
|------|------|------|
| Lobe Chat | 语音输入交互参考 | [lobehub/lobe-chat](https://github.com/lobehub/lobe-chat) |
| use-whisper | React Whisper封装 | [chengsokdara/use-whisper](https://github.com/chengsokdara/use-whisper) |

---

## 三、UI 组件规范

### 3.1 集成位置

基于现有 UI 结构，专注模式组件将集成在侧边栏区域：

```html
<!-- 现有结构 -->
<div class="flex-1 overflow-y-auto overflow-x-hidden p-3 flex flex-col gap-3">
  
  <!-- 待办事项（保留） -->
  <div class="rounded-xl bg-orange-50/60 dark:bg-stone-800/60">
    ...
  </div>
  
  <!-- 待分配（保留） -->
  <div class="rounded-xl bg-teal-50/60 dark:bg-stone-800/60">
    ...
  </div>
  
  <!-- 🆕 黑匣子（新增） -->
  <div class="rounded-xl bg-amber-50/60 dark:bg-stone-800/60">
    ...
  </div>
  
  <!-- 🆕 地质层（新增） -->
  <div class="rounded-xl bg-stone-100/60 dark:bg-stone-800/60">
    ...
  </div>
  
</div>

<!-- 🆕 大门遮罩层（全局） -->
<div class="gate-overlay" *ngIf="gateService.isActive()">
  ...
</div>
```

### 3.2 色彩规范

| 模块 | 浅色模式 | 深色模式 | 强调色 |
|------|----------|----------|--------|
| 大门 | `bg-stone-50/95` | `bg-stone-800/95` | `stone-600` |
| 聚光灯 | `bg-white` | `bg-stone-900` | `blue-500` |
| 地质层 | `bg-stone-100/60` | `bg-stone-800/60` | `stone-400` |
| 黑匣子 | `bg-amber-50/60` | `bg-stone-800/60` | `amber-500` |

### 3.3 动画规范

```css
/* 大门入场（巨石坠落感） */
@keyframes gate-enter {
  0% {
    opacity: 0;
    transform: translateY(-40px) scale(0.98); /* 从上方坠落 */
  }
  60% {
    opacity: 1;
    transform: translateY(10px) scale(1.02); /* 撞击回弹 */
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* 任务下沉到地质层 */
@keyframes task-sink {
  from {
    opacity: 1;
    transform: translateY(0);
  }
  to {
    opacity: 0.7;
    transform: translateY(20px);
  }
}

/* 下一个任务浮现 */
@keyframes task-emerge {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 录音按钮脉冲 */
@keyframes recording-pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4);
  }
  50% {
    box-shadow: 0 0 0 12px rgba(239, 68, 68, 0);
  }
}
```

---

## 四、数据模型

### 4.1 黑匣子条目

```typescript
interface BlackBoxEntry {
  id: string;                    // crypto.randomUUID() - ⚠️ 必须客户端生成！
  projectId: string;             // 所属项目
  userId: string;                // 所属用户
  
  // 内容
  content: string;               // 转写文本
  
  // 时间
  createdAt: string;             // ISO 时间戳
  date: string;                  // YYYY-MM-DD
  updatedAt: string;             // LWW 关键
  
  // 状态
  isRead: boolean;
  isCompleted: boolean;
  isArchived: boolean;
  
  // 🆕 跳过/稍后提醒
  snoozeUntil?: string;          // ISO 日期，跳过至该日期
  snoozeCount?: number;          // 已跳过次数
  
  // 软删除
  deletedAt: string | null;
  
  // 🆕 离线同步元数据
  syncStatus?: 'pending' | 'synced' | 'conflict';
  localCreatedAt?: string;       // 本地创建时间（用于离线排序）
}
```

### 4.2 转写使用量表（配额控制）

```sql
-- 转写 API 使用量追踪（防止滥用）
-- ⚠️ 注意：此表需要 service_role 才能绕过 RLS 进行可靠的配额检查
CREATE TABLE transcription_usage (
  id UUID PRIMARY KEY,  -- ⚠️ 由 Edge Function 使用 crypto.randomUUID() 生成
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  audio_seconds INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 每日使用量索引（确保同一用户同一天只能有多条记录用于计数）
CREATE INDEX idx_transcription_usage_user_date 
  ON transcription_usage(user_id, date);

-- RLS
-- ⚠️ 重要：Edge Function 使用 service_role 绕过 RLS 进行配额检查和记录
-- 普通用户只能读取自己的使用量（用于前端显示剩余配额）
ALTER TABLE transcription_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "用户只能读取自己的使用量"
  ON transcription_usage FOR SELECT
  USING (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE 由 service_role 执行，无需用户策略
```

### 4.3 数据库 Schema

```sql
-- 黑匣子条目表
-- ⚠️ 重要：移除 DEFAULT gen_random_uuid()，遵循项目核心规则
CREATE TABLE black_box_entries (
  id UUID PRIMARY KEY,  -- 由客户端 crypto.randomUUID() 生成
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  content TEXT NOT NULL,
  
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  is_read BOOLEAN DEFAULT FALSE,
  is_completed BOOLEAN DEFAULT FALSE,
  is_archived BOOLEAN DEFAULT FALSE,
  
  -- 跳过/稍后提醒
  snooze_until DATE DEFAULT NULL,
  snooze_count INTEGER DEFAULT 0,
  
  deleted_at TIMESTAMPTZ DEFAULT NULL
);

-- 索引
CREATE INDEX idx_black_box_user_date ON black_box_entries(user_id, date);
CREATE INDEX idx_black_box_project ON black_box_entries(project_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_black_box_pending ON black_box_entries(user_id, is_read, is_completed) 
  WHERE deleted_at IS NULL AND is_archived = FALSE;
-- 增量同步索引（与现有架构一致）
CREATE INDEX idx_black_box_updated_at ON black_box_entries(updated_at);

-- updated_at 触发器（与现有表结构一致）
-- ⚠️ 前提：update_updated_at_column() 函数已在 init-supabase.sql 中定义
DROP TRIGGER IF EXISTS update_black_box_entries_updated_at ON black_box_entries;
CREATE TRIGGER update_black_box_entries_updated_at
  BEFORE UPDATE ON black_box_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS - 与现有 tasks 表策略保持一致
ALTER TABLE black_box_entries ENABLE ROW LEVEL SECURITY;

-- SELECT：用户只能查看自己的条目，或所属项目的条目
CREATE POLICY "black_box_select_policy" ON black_box_entries 
  FOR SELECT USING (
    auth.uid() = user_id OR
    project_id IN (
      SELECT id FROM projects WHERE owner_id = auth.uid()
      UNION
      SELECT project_id FROM project_members WHERE user_id = auth.uid()
    )
  );

-- INSERT：用户只能创建自己的条目
CREATE POLICY "black_box_insert_policy" ON black_box_entries
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- UPDATE：用户只能更新自己的条目
CREATE POLICY "black_box_update_policy" ON black_box_entries
  FOR UPDATE USING (auth.uid() = user_id);

-- DELETE：用户只能删除自己的条目
CREATE POLICY "black_box_delete_policy" ON black_box_entries
  FOR DELETE USING (auth.uid() = user_id);
```

### 4.4 用户偏好扩展（🆕 新增）

```typescript
// 扩展现有 user_preferences.data JSONB
interface UserPreferencesData {
  // ... 现有偏好
  focus?: FocusPreferences;
}

interface FocusPreferences {
  gateEnabled: boolean;           // 是否启用大门（默认 true）
  spotlightEnabled: boolean;      // 是否启用聚光灯模式
  blackBoxEnabled: boolean;       // 是否启用黑匣子
  maxSnoozePerDay: number;        // 每日最大跳过次数（默认 3）
}
```

### 4.5 状态管理

```typescript
// stores.ts 扩展

// 黑匣子状态
export const blackBoxEntriesMap = signal<Map<string, BlackBoxEntry>>(new Map());
export const blackBoxEntriesByDate = signal<Map<string, Set<string>>>(new Map());

// 大门状态
export const gateState = signal<GateState>('checking');
export const gatePendingItems = signal<BlackBoxEntry[]>([]);
export const gateCurrentIndex = signal<number>(0);
export const gateSnoozeCount = signal<number>(0);  // 🆕 当日跳过次数

// 聚光灯状态
export const spotlightTask = signal<Task | null>(null);
export const isSpotlightMode = signal<boolean>(false);

// 🆕 用户偏好
export const focusPreferences = signal<FocusPreferences>({
  gateEnabled: true,
  spotlightEnabled: true,
  blackBoxEnabled: true,
  maxSnoozePerDay: 3
});

// 计算属性
export const pendingBlackBoxEntries = computed(() => {
  const entries = Array.from(blackBoxEntriesMap().values());
  const yesterday = getYesterdayDate();
  const today = getTodayDate();
  
  return entries.filter(e => 
    e.date <= yesterday && 
    !e.isRead && 
    !e.isCompleted && 
    !e.isArchived &&
    !e.deletedAt &&
    // 🆕 排除被跳过且未到提醒日期的条目
    (!e.snoozeUntil || e.snoozeUntil <= today)
  );
});

// 🆕 可跳过检查
export const canSnooze = computed(() => {
  return gateSnoozeCount() < focusPreferences().maxSnoozePerDay;
});
```

---

## 五、服务架构

### 5.1 新增服务

```
src/services/
├── black-box.service.ts         # 黑匣子 CRUD
├── black-box-sync.service.ts    # 黑匣子同步（持久化 RetryQueue 集成）
├── gate.service.ts              # 大门逻辑
├── spotlight.service.ts         # 聚光灯逻辑
├── strata.service.ts            # 地质层逻辑
├── speech-to-text.service.ts    # 语音转文字
└── focus-preference.service.ts  # 专注模式偏好管理（含云同步）
```

### 5.2 服务职责

#### BlackBoxService（🆕 补充离线同步逻辑）

```typescript
@Injectable({ providedIn: 'root' })
export class BlackBoxService {
  private syncService = inject(BlackBoxSyncService);
  
  /**
   * 创建黑匣子条目
   * 遵循 Offline-first：本地写入 → UI 更新 → 后台推送
   */
  create(data: Partial<BlackBoxEntry>): Result<BlackBoxEntry, OperationError> {
    const entry: BlackBoxEntry = {
      id: crypto.randomUUID(),  // ⚠️ 客户端生成 UUID
      projectId: this.projectState.currentProjectId()!,
      userId: this.auth.currentUserId()!,
      content: data.content ?? '',
      date: getTodayDate(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isRead: false,
      isCompleted: false,
      isArchived: false,
      deletedAt: null,
      syncStatus: 'pending',  // 🆕 标记待同步
      localCreatedAt: new Date().toISOString()
    };
    
    // 1. 本地写入 IndexedDB
    this.localStorage.save('black_box_entries', entry);
    
    // 2. 更新状态
    blackBoxEntriesMap.update(map => {
      const newMap = new Map(map);
      newMap.set(entry.id, entry);
      return newMap;
    });
    
    // 3. 后台推送（防抖 3s，与现有架构一致）
    this.syncService.scheduleSync(entry);
    
    return success(entry);
  }
  
  /**
   * 更新条目
   */
  update(id: string, updates: Partial<BlackBoxEntry>): Result<void, OperationError> {
    const entry = blackBoxEntriesMap().get(id);
    if (!entry) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '条目不存在');
    }
    
    const updated = {
      ...entry,
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    // 本地优先
    this.localStorage.save('black_box_entries', updated);
    blackBoxEntriesMap.update(map => {
      const newMap = new Map(map);
      newMap.set(id, updated);
      return newMap;
    });
    
    // 后台同步
    this.syncService.scheduleSync(updated);
    
    return success(undefined);
  }
}
```

#### GateService

```typescript
@Injectable({ providedIn: 'root' })
export class GateService {
  private state = gateState;
  private pendingItems = gatePendingItems;
  private currentIndex = gateCurrentIndex;
  private snoozeCount = gateSnoozeCount;
  private preferences = inject(PreferenceService);
  private blackBoxService = inject(BlackBoxService);
  
  /**
   * 检查是否需要显示大门
   * 🆕 尊重用户偏好设置
   */
  checkGate(): void {
    // 检查用户是否禁用了大门
    if (!focusPreferences().gateEnabled) {
      this.state.set('disabled');
      return;
    }
    
    const pending = pendingBlackBoxEntries();
    if (pending.length > 0) {
      this.pendingItems.set(pending);
      this.currentIndex.set(0);
      this.resetDailySnoozeCount();
      this.state.set('reviewing');
    } else {
      this.state.set('bypassed');
    }
  }
  
  // 标记当前条目为已读
  markAsRead(): void {
    const current = this.getCurrentEntry();
    if (current) {
      this.blackBoxService.update(current.id, { isRead: true });
      this.nextEntry();
    }
  }
  
  // 标记当前条目为完成
  markAsCompleted(): void {
    const current = this.getCurrentEntry();
    if (current) {
      this.blackBoxService.update(current.id, { isCompleted: true });
      this.nextEntry();
    }
  }
  
  /**
   * 🆕 跳过当前条目（稍后提醒）
   */
  snooze(): Result<void, OperationError> {
    if (!canSnooze()) {
      return failure(ErrorCodes.QUOTA_EXCEEDED, '今日跳过次数已达上限');
    }
    
    const current = this.getCurrentEntry();
    if (current) {
      const tomorrow = getTomorrowDate();
      this.blackBoxService.update(current.id, { 
        snoozeUntil: tomorrow,
        snoozeCount: (current.snoozeCount ?? 0) + 1
      });
      this.snoozeCount.update(c => c + 1);
      this.nextEntry();
    }
    
    return success(undefined);
  }
  
  // 切换到下一个条目
  private nextEntry(): void {
    const nextIndex = this.currentIndex() + 1;
    if (nextIndex >= this.pendingItems().length) {
      this.state.set('completed');
    } else {
      this.currentIndex.set(nextIndex);
    }
  }
  
  /**
   * 🆕 重置每日跳过次数（新的一天）
   */
  private resetDailySnoozeCount(): void {
    const lastResetDate = localStorage.getItem('gate_snooze_reset_date');
    const today = getTodayDate();
    if (lastResetDate !== today) {
      this.snoozeCount.set(0);
      localStorage.setItem('gate_snooze_reset_date', today);
    }
  }
  
  // 是否大门激活中
  isActive(): boolean {
    return this.state() === 'reviewing';
  }
  
  // 🆕 获取当前条目
  getCurrentEntry(): BlackBoxEntry | null {
    const items = this.pendingItems();
    const index = this.currentIndex();
    return items[index] ?? null;
  }
}
```

#### SpeechToTextService（使用 Supabase Edge Function 调用 Groq）

```typescript
// speech-to-text.service.ts
import { Injectable, signal, inject } from '@angular/core';
import { SupabaseClientService } from '../../services/supabase-client.service';
import { ToastService } from '../../services/toast.service';
import { NetworkAwarenessService } from '../../services/network-awareness.service';

@Injectable({ providedIn: 'root' })
export class SpeechToTextService {
  private supabaseClient = inject(SupabaseClientService);
  private toast = inject(ToastService);
  private network = inject(NetworkAwarenessService);
  
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  
  // 使用 Signal 管理状态，组件直接读取
  isRecording = signal(false);
  isTranscribing = signal(false);
  offlinePendingCount = signal(0);  // 离线待处理数量
  
  // IndexedDB 存储键
  private readonly IDB_STORE = 'offline_audio_cache';
  
  /**
   * 开始录音
   * ⚠️ iOS Safari 兼容性：需要在用户手势内调用
   */
  async startRecording(): Promise<void> {
    try {
      // iOS Safari 兼容性检查
      const mimeType = this.getSupportedMimeType();
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000  // Whisper 最佳采样率
        } 
      });
      
      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 128000
      });
      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      // 每秒收集一次数据，避免丢失
      this.mediaRecorder.start(1000);
      this.isRecording.set(true);
    } catch (err) {
      console.error('无法调用麦克风', err);
      // 更友好的错误提示
      if (err instanceof DOMException) {
        if (err.name === 'NotAllowedError') {
          this.toast.show('请允许麦克风权限后重试', 'error');
        } else if (err.name === 'NotFoundError') {
          this.toast.show('未找到麦克风设备', 'error');
        }
      }
      throw err;
    }
  }
  
  /**
   * 获取浏览器支持的音频格式
   * iOS Safari 不支持 webm，需要使用 mp4
   */
  private getSupportedMimeType(): string {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/wav'
    ];
    
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    
    // 默认不指定，让浏览器选择
    return '';
  }
  
  /**
   * 停止录音并转写
   * 使用 Supabase Edge Function 调用 Groq API
   */
  async stopAndTranscribe(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error('未开始录音'));
        return;
      }

      this.mediaRecorder.onstop = async () => {
        this.isRecording.set(false);
        this.isTranscribing.set(true);

        const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
        const audioBlob = new Blob(this.audioChunks, { type: mimeType });
        
        // 检查录音是否太短
        if (audioBlob.size < 1000) {
          this.isTranscribing.set(false);
          this.toast.show('录音太短，请按住久一点', 'warning');
          resolve('');
          return;
        }

        try {
          // 检查网络状态
          if (!this.network.isOnline()) {
            // 离线：暂存到 IndexedDB，稍后重试
            await this.saveToOfflineCache(audioBlob);
            this.toast.show('已保存，联网后自动转写', 'info');
            resolve('[离线录音，稍后转写]');
            return;
          }
          
          // 在线：直接转写
          const text = await this.transcribeBlob(audioBlob);
          resolve(text);
        } catch (error) {
          console.error('转写失败', error);
          
          // 网络错误时也暂存
          if (error instanceof TypeError && error.message.includes('fetch')) {
            await this.saveToOfflineCache(audioBlob);
            this.toast.show('网络错误，已保存待重试', 'warning');
            resolve('[转写失败，稍后重试]');
          } else {
            reject(error);
          }
        } finally {
          this.isTranscribing.set(false);
          // 清理流，释放麦克风
          this.mediaRecorder?.stream.getTracks().forEach(track => track.stop());
        }
      };

      this.mediaRecorder.stop();
    });
  }
  
  /**
   * 实际调用 Edge Function 进行转写
   */
  private async transcribeBlob(audioBlob: Blob): Promise<string> {
    const formData = new FormData();
    // 根据 mimeType 设置正确的文件扩展名
    const ext = audioBlob.type.includes('mp4') ? 'mp4' : 'webm';
    formData.append('file', audioBlob, `recording.${ext}`);

    const { data, error } = await this.supabaseClient.client().functions.invoke('transcribe', {
      body: formData,
    });

    if (error) {
      // 处理特定错误
      if (error.message?.includes('QUOTA_EXCEEDED')) {
        this.toast.show('今日转写次数已达上限', 'warning');
        throw new Error('配额已用完');
      }
      throw error;
    }
    
    return data.text;
  }
  
  /**
   * 离线时暂存录音到 IndexedDB
   */
  private async saveToOfflineCache(blob: Blob): Promise<void> {
    try {
      const db = await this.openIndexedDB();
      const tx = db.transaction(this.IDB_STORE, 'readwrite');
      const store = tx.objectStore(this.IDB_STORE);
      
      await store.add({
        id: crypto.randomUUID(),
        blob: blob,
        createdAt: new Date().toISOString(),
        mimeType: blob.type
      });
      
      this.offlinePendingCount.update(c => c + 1);
    } catch (e) {
      console.error('Failed to cache audio offline:', e);
    }
  }
  
  /**
   * 网络恢复后处理离线缓存
   */
  async processOfflineCache(): Promise<void> {
    if (!this.network.isOnline()) return;
    
    try {
      const db = await this.openIndexedDB();
      const tx = db.transaction(this.IDB_STORE, 'readonly');
      const store = tx.objectStore(this.IDB_STORE);
      const items = await store.getAll();
      
      for (const item of items) {
        try {
          const text = await this.transcribeBlob(item.blob);
          // TODO: 创建 BlackBoxEntry
          console.log('Offline transcription:', text);
          
          // 删除已处理的缓存
          const deleteTx = db.transaction(this.IDB_STORE, 'readwrite');
          await deleteTx.objectStore(this.IDB_STORE).delete(item.id);
          this.offlinePendingCount.update(c => Math.max(0, c - 1));
        } catch (e) {
          console.error('Failed to process offline item:', e);
        }
      }
    } catch (e) {
      console.error('Failed to process offline cache:', e);
    }
  }
  
  private async openIndexedDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('focus_mode', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.IDB_STORE)) {
          db.createObjectStore(this.IDB_STORE, { keyPath: 'id' });
        }
      };
    });
  }
  
  /**
   * 检查浏览器是否支持录音
   */
  isSupported(): boolean {
    return !!(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
  }
  
  /**
   * 🆕 获取不支持时的降级方案提示
   */
  getFallbackMessage(): string {
    if (!this.isSupported()) {
      return '当前浏览器不支持录音，请使用文字输入';
    }
    return '';
  }
}
```

**关键点**：
- **使用 Supabase SDK**：`supabase.functions.invoke('transcribe')` 而非直接 fetch
- **Signal 状态管理**：`isRecording` 和 `isTranscribing` 直接暴露给组件
- **自动清理**：录音停止后立即释放麦克风资源
- **数据流向**：Mic → Browser Blob → Edge Function → Groq → Text → Browser → 存入 DB

---

## 六、组件结构

### 6.1 新增组件

```
src/app/features/focus/
├── components/
│   ├── gate/
│   │   ├── gate-overlay.component.ts      # 大门遮罩
│   │   ├── gate-card.component.ts         # 大门卡片
│   │   └── gate-actions.component.ts      # 大门按钮组
│   │
│   ├── spotlight/
│   │   ├── spotlight-view.component.ts    # 聚光灯视图
│   │   └── spotlight-card.component.ts    # 聚光灯任务卡
│   │
│   ├── strata/
│   │   ├── strata-view.component.ts       # 地质层视图
│   │   ├── strata-layer.component.ts      # 单日层
│   │   └── strata-item.component.ts       # 单个已完成项
│   │
│   └── black-box/
│       ├── black-box-panel.component.ts   # 黑匣子面板
│       ├── black-box-recorder.component.ts # 录音按钮
│       ├── black-box-entry.component.ts   # 单个条目
│       └── black-box-date-group.component.ts # 日期分组
│
└── services/
    ├── gate.service.ts
    ├── spotlight.service.ts
    ├── strata.service.ts
    └── speech-to-text.service.ts
```

### 6.2 黑匣子面板组件

```typescript
// black-box-panel.component.ts
@Component({
  selector: 'app-black-box-panel',
  standalone: true,
  imports: [CommonModule, BlackBoxRecorderComponent, BlackBoxEntryComponent],
  template: `
    <div class="rounded-xl bg-amber-50/60 dark:bg-stone-800/60 
                border border-amber-100/50 dark:border-stone-700/50 
                backdrop-blur-md overflow-hidden">
      
      <!-- 标题栏 -->
      <div class="px-3 py-2.5 cursor-pointer flex justify-between items-center 
                  group select-none hover:bg-amber-100/30 dark:hover:bg-stone-700/30"
           (click)="toggleExpand()">
        <span class="font-bold text-stone-700 dark:text-stone-100 text-xs 
                     flex items-center gap-2">
          <span class="w-1.5 h-1.5 rounded-full bg-amber-500 
                       shadow-[0_0_6px_rgba(245,158,11,0.4)]"></span>
          📦 黑匣子
          @if (pendingCount() > 0) {
            <span class="bg-amber-500 text-white text-[9px] px-1.5 py-0.5 
                         rounded-full font-mono">
              {{ pendingCount() }}
            </span>
          }
        </span>
        <span class="text-stone-300 dark:text-stone-500 text-[10px] 
                     transition-transform duration-300"
              [class.rotate-180]="isExpanded()">
          ▼
        </span>
      </div>
      
      <!-- 内容区 -->
      @if (isExpanded()) {
        <div class="px-2 pb-2 animate-slide-down">
          
          <!-- 录音按钮 -->
          <app-black-box-recorder 
            (transcribed)="onTranscribed($event)" />
          
          <!-- 条目列表（按日期分组） -->
          @for (group of entriesByDate(); track group.date) {
            <div class="mt-3">
              <div class="text-[10px] text-stone-400 dark:text-stone-500 
                          font-mono mb-1.5 px-1">
                {{ group.date | date:'yyyy-MM-dd' }}
              </div>
              
              @for (entry of group.entries; track entry.id) {
                <app-black-box-entry 
                  [entry]="entry"
                  (markRead)="onMarkRead(entry.id)"
                  (markCompleted)="onMarkCompleted(entry.id)"
                  (archive)="onArchive(entry.id)" />
              }
            </div>
          }
          
        </div>
      }
      
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlackBoxPanelComponent {
  private blackBoxService = inject(BlackBoxService);
  
  isExpanded = signal(true);
  entriesByDate = this.blackBoxService.entriesByDate;
  pendingCount = this.blackBoxService.pendingCount;
  
  toggleExpand(): void {
    this.isExpanded.update(v => !v);
  }
  
  onTranscribed(text: string): void {
    this.blackBoxService.create({ content: text });
  }
  
  onMarkRead(id: string): void {
    this.blackBoxService.update(id, { isRead: true });
  }
  
  onMarkCompleted(id: string): void {
    this.blackBoxService.update(id, { isCompleted: true });
  }
  
  onArchive(id: string): void {
    this.blackBoxService.update(id, { isArchived: true });
  }
}
```

### 6.3 录音按钮组件（对讲机交互）

```typescript
// black-box-recorder.component.ts
@Component({
  selector: 'app-black-box-recorder',
  standalone: true,
  template: `
    <div class="black-box-container">
      <!-- 转写结果展示 -->
      @if (transcription()) {
        <div class="result-card mb-2 p-2 bg-amber-50 dark:bg-stone-700 rounded-lg text-xs">
          <p>{{ transcription() }}</p>
        </div>
      }

      <!-- 录音按钮：类似对讲机的按住说话效果 -->
      <button 
        class="record-btn w-full px-4 py-5 rounded-lg transition-all
               flex items-center justify-center gap-2 text-sm font-medium
               select-none touch-none"
        [class.recording]="voiceService.isRecording()"
        [class.loading]="voiceService.isTranscribing()"
        [class]="voiceService.isRecording() 
          ? 'bg-red-500 text-white shadow-lg shadow-red-500/30 scale-[0.98]' 
          : voiceService.isTranscribing()
            ? 'bg-stone-200 dark:bg-stone-600 cursor-wait'
            : 'bg-amber-100/80 dark:bg-stone-700/80 text-amber-700 dark:text-amber-300 
               hover:bg-amber-200 dark:hover:bg-stone-600 border-2 border-dashed border-amber-300 dark:border-stone-500'"
        (mousedown)="start()" 
        (mouseup)="stop()"
        (mouseleave)="stop()" 
        (touchstart)="start()" 
        (touchend)="stop()">
        
        @if (voiceService.isTranscribing()) {
          <span class="animate-spin">⏳</span>
          <span>Thinking...</span>
        } @else if (voiceService.isRecording()) {
          <span class="w-3 h-3 rounded-full bg-white animate-ping"></span>
          <span>Listening...</span>
        } @else {
          <span>🎤</span>
          <span>Hold to Dump Brain</span>
        }
      </button>
    </div>
  `,
  styles: [`
    /* 录音按钮脉冲效果 */
    .recording {
      animation: recording-pulse 1.5s ease-in-out infinite;
    }
    
    @keyframes recording-pulse {
      0%, 100% {
        box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4);
      }
      50% {
        box-shadow: 0 0 0 12px rgba(239, 68, 68, 0);
      }
    }
    
    /* 防止长按选中文本 */
    .record-btn {
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlackBoxRecorderComponent {
  voiceService = inject(SpeechToTextService);
  transcription = signal('');
  
  @Output() transcribed = new EventEmitter<string>();

  start() {
    if (this.voiceService.isTranscribing()) return;
    this.voiceService.startRecording();
  }

  async stop() {
    if (!this.voiceService.isRecording()) return;
    
    try {
      // 停止录音并立刻触发转写
      const text = await this.voiceService.stopAndTranscribe();
      // 更新本地状态用于展示
      this.transcription.set(text);
      // 通知父组件
      if (text.trim()) {
        this.transcribed.emit(text);
        // TODO: 这里可以直接调用 BlackBoxService 存入数据库
        // this.blackBoxService.create({ content: text });
      }
    } catch (e) {
      console.error('Failed', e);
    }
  }
}
```

**关键设计点**：
- **OnPush 与 Signals**：状态变化自动触发 UI 刷新，无需手动 `detectChanges`
- **对讲机交互**：按住说话、松开转写，`Thinking...` 状态极短（1-2 秒）
- **防误触**：`user-select: none` + `touch-callout: none` 防止长按选中文本
- **数据流向**：Mic → Browser Blob → Edge Function → Groq → Text → Browser → 存入 DB

---

## 七、配置常量

```typescript
// src/config/focus.config.ts

export const FOCUS_CONFIG = {
  // 大门配置
  GATE: {
    // 检查遗留条目的时间范围（天）
    PENDING_DAYS_RANGE: 7,
    // 动画时长（毫秒）
    TRANSITION_DURATION: 300,
  },
  
  // 聚光灯配置
  SPOTLIGHT: {
    // 任务完成后延迟显示下一个（毫秒）
    NEXT_TASK_DELAY: 500,
    // 背景地质层透明度
    STRATA_BACKGROUND_OPACITY: 0.3,
  },
  
  // 地质层配置
  STRATA: {
    // 显示的最大天数
    MAX_DISPLAY_DAYS: 30,
    // 透明度衰减系数
    OPACITY_DECAY: 0.15,
    // 最小透明度
    MIN_OPACITY: 0.3,
  },
  
  // 黑匣子配置
  BLACK_BOX: {
    // 录音最大时长（秒）
    MAX_RECORDING_DURATION: 120,
    // 转写 API 超时（毫秒）- Groq 极快，通常 1-2 秒
    TRANSCRIBE_TIMEOUT: 10000,
    // 条目每日显示上限
    MAX_ENTRIES_PER_DAY: 50,
  },
  
  // 语音转文字配置（Groq + whisper-large-v3）
  SPEECH_TO_TEXT: {
    // 🆕 Groq 使用的模型（目前最强的开源模型）
    MODEL: 'whisper-large-v3',
    // 语言
    LANGUAGE: 'zh',
    // 音频格式
    AUDIO_MIME_TYPE: 'audio/webm;codecs=opus',
    // 每日配额限制
    DAILY_QUOTA: 50,
    // 🆕 Edge Function 名称
    EDGE_FUNCTION_NAME: 'transcribe',
    // 🆕 Groq API 端点（仅在 Edge Function 中使用）
    GROQ_API_ENDPOINT: 'https://api.groq.com/openai/v1/audio/transcriptions',
  },
  
  // 同步配置（与主架构对齐）
  SYNC: {
    // 防抖延迟（与 SYNC_CONFIG.DEBOUNCE_DELAY 一致）
    DEBOUNCE_DELAY: 3000,
    // IndexedDB 存储键前缀
    IDB_PREFIX: 'focus_',
  },
} as const;

// 错误码
export const FocusErrorCodes = {
  QUOTA_EXCEEDED: 'FOCUS_QUOTA_EXCEEDED',
  TRANSCRIBE_FAILED: 'FOCUS_TRANSCRIBE_FAILED',
  RECORDING_NOT_SUPPORTED: 'FOCUS_RECORDING_NOT_SUPPORTED',
  RECORDING_PERMISSION_DENIED: 'FOCUS_RECORDING_PERMISSION_DENIED',
} as const;
```

---

## 八、实现路线图

### Phase 0: 准备工作

- [ ] 在 `src/utils/result.ts` 中添加专注模式错误码
- [ ] 在 `src/models/index.ts` 中添加 `BlackBoxEntry` 类型定义
- [ ] 创建 Edge Function `supabase/functions/transcribe`
- [ ] 在 Supabase 添加 `GROQ_API_KEY` 环境变量：`supabase secrets set GROQ_API_KEY=gsk_xxx`
- [ ] 部署 Edge Function：`supabase functions deploy transcribe`
- [ ] 创建 `transcription_usage` 表（配额控制）

### Phase 1: 黑匣子基础功能（1-2 周）

- [ ] 创建 `black_box_entries` 数据库表
- [ ] 实现 `BlackBoxService` CRUD（含离线同步）
- [ ] 实现 `BlackBoxSyncService` 同步逻辑
- [ ] 实现 `SpeechToTextService` 录音功能
- [ ] 集成 Groq API 转写（通过 Edge Function）
- [ ] 完成 `BlackBoxPanelComponent` UI
- [ ] 完成 `BlackBoxRecorderComponent` 录音按钮
- [ ] 实现文字输入降级方案

### Phase 2: 大门机制（1 周）

- [ ] 实现 `GateService` 状态管理
- [ ] 完成 `GateOverlayComponent` 遮罩层
- [ ] 完成 `GateCardComponent` 条目展示
- [ ] 实现每日首次打开检测逻辑
- [ ] 添加已读/完成按钮交互
- [ ] 添加"稍后提醒"功能
- [ ] 添加用户偏好设置（可禁用大门）

### Phase 3: 聚光灯模式（1 周）

- [ ] 实现 `SpotlightService` 任务选择逻辑
- [ ] 完成 `SpotlightViewComponent` 单任务界面
- [ ] 实现任务完成动画
- [ ] 添加与待办事项的联动
- [ ] 实现与现有任务系统的数据联动

### Phase 4: 地质层可视化（1 周）

- [ ] 实现 `StrataService` 历史聚合
- [ ] 完成 `StrataViewComponent` 分层显示
- [ ] 实现透明度渐变效果
- [ ] 添加滚动展开交互
- [ ] 集成现有已完成任务数据

### Phase 5: 整合与优化（1 周）

- [ ] 模块间状态联动测试
- [ ] 移动端 PWA 适配
- [ ] 性能优化
- [ ] E2E 测试覆盖
- [ ] 可访问性测试（键盘导航、屏幕阅读器）
- [ ] 离线功能测试

---

## 九、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Groq API 成本 | 高频使用产生费用 | ① 每日配额限制（50次/用户）② Groq 比 OpenAI 更便宜 |
| Groq 服务可用性 | 服务中断 | ① 监控 Edge Function 日志 ② 备选：OpenAI Whisper 降级 |
| 浏览器录音兼容性 | iOS Safari 限制 | ① 检测支持情况 ② 降级为手动文字输入 |
| 大门阻塞体验 | 用户烦躁跳过 | ① 添加"稍后提醒"（每日上限3次）② 用户可在设置中禁用 |
| 转写准确度 | 关键词识别错误 | ① prompt 引导中文输出 ② 允许手动编辑转写结果 |
| 离线录音 | 断网时无法转写 | ① 音频暂存 IndexedDB ② 恢复网络后自动重试 |
| API Key 泄露 | 安全风险 | ① 通过 Edge Function 代理 ② 永不暴露在前端 ③ 使用 `supabase secrets` |
| 数据一致性 | 多设备同步冲突 | ① LWW 策略 ② 与现有同步架构保持一致 |

---

## 十、验收标准

### 功能验收

- [ ] 首次打开应用时，若有昨日未处理条目，大门正确阻塞
- [ ] 大门中所有条目处理完毕后，自动进入主界面
- [ ] 用户可在设置中禁用大门功能
- [ ] "稍后提醒"功能正常工作，每日上限生效
- [ ] 黑匣子录音按钮按住说话、松开转文字
- [ ] 不支持录音的浏览器显示文字输入框
- [ ] 转写文本正确存储并按日期分组显示
- [ ] 达到每日配额后显示友好提示
- [ ] 条目状态（已读/完成/归档）正确切换
- [ ] 聚光灯模式只显示单个优先任务
- [ ] 地质层正确堆叠显示历史完成任务

### 性能验收

- [ ] 录音启动延迟 < 500ms
- [ ] **Groq 转写响应时间 < 3s**（60秒音频，比 OpenAI 快 5-10 倍）
- [ ] 大门动画流畅，无卡顿
- [ ] 地质层滚动流畅
- [ ] 离线时黑匣子条目可正常创建

### 兼容性验收

- [ ] Chrome / Edge / Safari 桌面端正常
- [ ] iOS Safari PWA 正常（含降级方案）
- [ ] Android Chrome PWA 正常
- [ ] 键盘导航正常（Tab/Enter/Escape）
- [ ] 屏幕阅读器友好

### 安全验收

- [ ] GROQ_API_KEY 不暴露在前端代码中
- [ ] Edge Function 正确校验用户身份
- [ ] 配额限制生效，防止滥用

---

## 十一、与现有系统的集成（🆕 新增章节）

### 11.1 数据迁移策略

专注模式不需要迁移现有数据，但需要与现有任务系统联动：

```typescript
// 聚光灯任务来源优先级
function getSpotlightTask(): Task | null {
  // 1. 黑匣子中"已读未完成"的条目（转换为虚拟任务）
  const pendingBlackBox = getUncompletedReadEntries();
  if (pendingBlackBox.length > 0) {
    return convertBlackBoxToTask(pendingBlackBox[0]);
  }
  
  // 2. 现有任务系统中的待办任务
  const todoTasks = tasksMap().values()
    .filter(t => t.status === 'active' && !t.deletedAt)
    .sort((a, b) => a.order - b.order);
  
  if (todoTasks.length > 0) {
    return todoTasks[0];
  }
  
  return null;
}
```

### 11.2 地质层数据来源

地质层需要整合两个数据源：
1. 黑匣子中标记为"完成"的条目
2. 现有任务系统中 `status === 'completed'` 的任务

```typescript
interface StrataItem {
  type: 'black_box' | 'task';
  id: string;
  title: string;
  completedAt: string;
  source: BlackBoxEntry | Task;
}

function getStrataItems(date: string): StrataItem[] {
  const blackBoxItems = getCompletedBlackBoxEntries(date)
    .map(e => ({ type: 'black_box', id: e.id, title: e.content, completedAt: e.updatedAt, source: e }));
  
  const taskItems = getCompletedTasks(date)
    .map(t => ({ type: 'task', id: t.id, title: t.title, completedAt: t.updatedAt, source: t }));
  
  return [...blackBoxItems, ...taskItems]
    .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
}
```

### 11.3 IndexedDB 存储结构

```typescript
// 新增 IndexedDB Object Store
const FOCUS_STORES = {
  BLACK_BOX_ENTRIES: 'black_box_entries',
  FOCUS_PREFERENCES: 'focus_preferences',
  TRANSCRIPTION_CACHE: 'transcription_cache'  // 离线时暂存音频
};

// 与现有 IndexedDB 结构保持一致
interface FocusDatabase {
  black_box_entries: {
    key: string;  // entry.id
    value: BlackBoxEntry;
    indexes: {
      'by-date': string;
      'by-updated': string;
      'by-sync-status': string;
    };
  };
}
```

### 11.4 同步策略

黑匣子同步遵循现有架构，通过 RetryQueue 持久化队列确保数据安全：

```typescript
// BlackBoxSyncService 通过回调模式集成 RetryQueue
class BlackBoxSyncService {
  private retryQueueHandler: ((entry: BlackBoxEntry) => void) | null = null;

  // SimpleSyncService 调用此方法注入 RetryQueue 回调
  setRetryQueueHandler(handler: (entry: BlackBoxEntry) => void): void {
    this.retryQueueHandler = handler;
  }

  // 调度同步：IndexedDB 标记 pending → 防抖 → 推入 RetryQueue
  scheduleSync(entry: BlackBoxEntry): void {
    // 1. 保存到 IndexedDB，标记 syncStatus: 'pending'
    this.saveToLocal(entry);

    // 2. 防抖 3s 后推入 RetryQueue（持久化）
    this.debouncedFlush(entry);
  }

  // 增量拉取：updated_at > last_sync_time
  async pullChanges(): Promise<void> {
    const lastSync = await this.getLastSyncTime('black_box');
    const { data } = await supabase
      .from('black_box_entries')
      .select('*')
      .gt('updated_at', lastSync)
      .order('updated_at', { ascending: true });

    // 合并到本地 IndexedDB（LWW 策略）
    for (const entry of data ?? []) {
      await this.mergeWithLocal(entry);
    }
  }

  // 网络恢复时：扫描 IndexedDB 中 syncStatus === 'pending' 的条目
  async recoverPendingEntries(): Promise<void> {
    const pendingEntries = await this.getPendingFromLocal();
    for (const entry of pendingEntries) {
      if (this.retryQueueHandler) {
        this.retryQueueHandler(entry);
      }
    }
  }

  // 冲突解决：LWW
  private async mergeWithLocal(remote: BlackBoxEntry): Promise<void> {
    const local = await this.localStorage.get(remote.id);
    if (!local || remote.updatedAt > local.updatedAt) {
      await this.localStorage.save(remote);
      this.updateSignal(remote);
    }
  }
}

// SimpleSyncService 中的集成
this.blackBoxSync.setRetryQueueHandler((entry: BlackBoxEntry) => {
  this.retryQueueService.add('blackbox', 'upsert', entry, entry.projectId);
});
```

**关键架构改进（v1.4）**：
- 替换内存队列为 RetryQueue 持久化队列，消除浏览器崩溃/关闭导致的数据丢失
- 通过回调模式避免 `src/services/` 与 `src/app/core/services/sync/` 的循环依赖
- 网络恢复时自动扫描 IndexedDB 中 `syncStatus === 'pending'` 的条目

---

## 十二、可访问性设计（🆕 新增章节）

### 12.1 键盘导航

| 元素 | 快捷键 | 行为 |
|------|--------|------|
| 大门 | `1` | 标记已读 |
| 大门 | `2` | 标记完成 |
| 大门 | `3` | 稍后提醒 |
| 大门 | `Escape` | 无操作（不允许关闭） |
| 大门录音按钮 | `Space` (长按) | 开始/停止录音 |
| 聚光灯 | `Enter` | 完成当前任务 |
| 聚光灯 | `→` (ArrowRight) | 跳过当前任务 |
| 聚光灯 | `Escape` | 退出聚光灯模式 |
| 黑匣子面板/地质层 | `Enter` / `Space` | 展开/折叠面板 |
| 黑匣子录音按钮 | `Space` (长按) | 开始/停止录音 |
| 地质层日期层 | `Enter` / `Space` | 展开/折叠该日层 |

### 12.2 ARIA 标签

```html
<!-- 大门遮罩 -->
<div role="dialog"
     aria-modal="true"
     aria-labelledby="gate-title"
     aria-describedby="gate-description"
     tabindex="-1">
</div>

<!-- 聚光灯视图 -->
<div role="dialog"
     aria-modal="true"
     aria-label="专注模式">
  <!-- 任务卡片区域带 aria-live，切换任务时自动播报 -->
  <div aria-live="polite">
    <app-spotlight-card />
  </div>
</div>

<!-- 大门进度条 -->
<div role="progressbar"
     [attr.aria-valuenow]="progress().current"
     [attr.aria-valuemin]="0"
     [attr.aria-valuemax]="progress().total"
     aria-label="处理进度">
</div>

<!-- 录音按钮 -->
<button [attr.aria-pressed]="isRecording()"
        [attr.aria-label]="isRecording() ? '松开停止录音' : '按住开始录音'">
</button>

<!-- 可折叠面板标题栏 -->
<div role="button"
     tabindex="0"
     [attr.aria-expanded]="isExpanded()"
     aria-label="黑匣子"
     (keydown.enter)="toggleExpand()"
     (keydown.space)="toggleExpand(); $event.preventDefault()">
</div>

<!-- 地质层列表 -->
<div role="list" aria-label="已完成任务列表">
  <div role="listitem">
    <div role="button" tabindex="0"
         [attr.aria-expanded]="!isCollapsed()">
    </div>
  </div>
</div>
```

### 12.3 屏幕阅读器支持

- 大门出现时自动聚焦，播报"昨日遗留 X 项待处理"
- 录音状态变化时播报"开始录音"/"录音结束，正在转写"
- 条目处理后播报"已标记为已读"/"已标记为完成"

---

## 十三、测试策略（🆕 新增章节）

### 13.1 单元测试

```typescript
// black-box.service.spec.ts
describe('BlackBoxService', () => {
  it('should create entry with client-generated UUID', () => {
    const entry = service.create({ content: 'test' });
    expect(entry.ok).toBe(true);
    expect(entry.value.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  
  it('should mark entry as pending sync when offline', () => {
    networkService.setOffline(true);
    const entry = service.create({ content: 'offline test' });
    expect(entry.value.syncStatus).toBe('pending');
  });
});

// gate.service.spec.ts
describe('GateService', () => {
  it('should respect user preference to disable gate', () => {
    focusPreferences.set({ gateEnabled: false, ... });
    service.checkGate();
    expect(service.isActive()).toBe(false);
  });
  
  it('should limit snooze count per day', () => {
    // 跳过 3 次后应该失败
    for (let i = 0; i < 3; i++) {
      expect(service.snooze().ok).toBe(true);
    }
    expect(service.snooze().ok).toBe(false);
  });
});
```

### 13.2 E2E 测试

```typescript
// e2e/focus-mode.spec.ts
test('gate blocks entry until all items processed', async ({ page }) => {
  // 准备：创建昨日未处理条目
  await seedBlackBoxEntries([
    { date: yesterday, isRead: false, isCompleted: false }
  ]);
  
  // 打开应用
  await page.goto('/');
  
  // 验证大门显示
  await expect(page.locator('.gate-overlay')).toBeVisible();
  
  // 无法点击背景内容
  await expect(page.locator('.main-content')).toHaveCSS('pointer-events', 'none');
  
  // 处理条目
  await page.click('[data-action="mark-read"]');
  
  // 验证大门消失
  await expect(page.locator('.gate-overlay')).not.toBeVisible();
});

test('recording falls back to text input on unsupported browser', async ({ page }) => {
  // 模拟不支持 getUserMedia
  await page.addInitScript(() => {
    delete navigator.mediaDevices;
  });
  
  await page.goto('/');
  
  // 验证显示文字输入
  await expect(page.locator('.black-box-text-input')).toBeVisible();
  await expect(page.locator('.black-box-recorder')).not.toBeVisible();
});
```

---

## 十四、快速部署指南

### 14.1 部署 Edge Function（一次性设置）

```bash
# 1. 创建 Edge Function
supabase functions new transcribe

# 2. 复制 Edge Function 代码（见 2.4.6 节）到 supabase/functions/transcribe/index.ts

# 3. 设置 Groq API Key（安全存储在 Supabase）
supabase secrets set GROQ_API_KEY=gsk_your_actual_key_here

# 4. 部署函数
supabase functions deploy transcribe

# 5. 验证部署成功
supabase functions list
```

### 14.2 创建数据库表

```sql
-- 在 Supabase SQL Editor 中执行

-- 黑匣子条目表
CREATE TABLE black_box_entries (
  id UUID PRIMARY KEY,  -- 客户端生成
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  is_read BOOLEAN DEFAULT FALSE,
  is_completed BOOLEAN DEFAULT FALSE,
  is_archived BOOLEAN DEFAULT FALSE,
  snooze_until DATE DEFAULT NULL,
  snooze_count INTEGER DEFAULT 0,
  deleted_at TIMESTAMPTZ DEFAULT NULL
);

-- 转写使用量表（配额控制）
CREATE TABLE transcription_usage (
  id UUID PRIMARY KEY,  -- 客户端生成
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  audio_seconds INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_black_box_user_date ON black_box_entries(user_id, date);
CREATE INDEX idx_black_box_updated_at ON black_box_entries(updated_at);
CREATE UNIQUE INDEX idx_transcription_usage_user_date ON transcription_usage(user_id, date);

-- RLS
ALTER TABLE black_box_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcription_usage ENABLE ROW LEVEL SECURITY;

-- 黑匣子：按操作拆分 RLS 策略（与 4.3 节一致）
CREATE POLICY "black_box_select_policy" ON black_box_entries
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "black_box_insert_policy" ON black_box_entries
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "black_box_update_policy" ON black_box_entries
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "black_box_delete_policy" ON black_box_entries
  FOR DELETE USING (auth.uid() = user_id);

-- 使用量：仅允许读取（写入由 service_role 在 Edge Function 中执行）
CREATE POLICY "用户只能读取自己的使用量" ON transcription_usage
  FOR SELECT USING (auth.uid() = user_id);
```

### 14.3 本地测试

```bash
# 1. 启动本地 Supabase（可选）
supabase start

# 2. 本地测试 Edge Function
supabase functions serve transcribe --env-file .env.local

# 3. 测试请求
curl -X POST http://localhost:54321/functions/v1/transcribe \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -F "file=@test-audio.webm"
```

### 14.4 获取 Groq API Key

1. 访问 [console.groq.com](https://console.groq.com)
2. 注册/登录账号
3. 创建新的 API Key
4. 使用 `supabase secrets set GROQ_API_KEY=gsk_xxx` 安全存储
