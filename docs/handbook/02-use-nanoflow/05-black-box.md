---
title: Black Box 黑匣子
status: canonical
audience: user
last_verified: 2026-06-13
category: use-nanoflow
source_paths:
  - README.md
  - docs/transcribe-troubleshooting.md
  - src/app/features/focus/
  - src/services/speech-to-text-offline-cache.store.ts
  - supabase/functions/transcribe/
---

# Black Box 黑匣子

Black Box 是快速记录入口。它适合在你不想打断当前工作时先把想法、语音、提醒或杂念收进去，之后再通过 Gate 决定是否转成任务。

## 本文内容

- [Black Box 适合记录什么](#black-box-适合记录什么)
- [文字记录怎么处理](#文字记录怎么处理)
- [语音记录和转写](#语音记录和转写)
- [通过 Gate 复盘](#通过-gate-复盘)
- [不要长期堆积](#不要长期堆积)
- [常见问题](#常见问题)
- [下一步](#下一步)

## Black Box 适合记录什么

适合放进 Black Box：

- 突然想到的任务；
- 一句临时想法；
- 会议中来不及整理的要点；
- 语音速记；
- 不确定是否值得处理的内容；
- 当前工作之外的提醒。

不适合长期留在 Black Box：

- 已经明确要做的任务；
- 长篇资料；
- 需要多步推进的项目；
- 已经没意义的噪声；
- 应该进入知识库维护的正文资料。

## 文字记录怎么处理

文字记录是本地可用能力。推荐流程：

1. 工作中想到内容，先快速写入 Black Box。
2. 不要立刻切换到完整任务整理流程。
3. 当前工作告一段落后，打开 Gate。
4. 判断这条记录应该变成任务、挂到已有任务、保留稍后看，还是丢弃。
5. 转成任务后，给任务补上清楚标题和下一步。

文字记录的价值在于降低打断成本，而不是替代任务树。

## 语音记录和转写

语音转写依赖云端能力，通常需要：

- 浏览器能录音；
- `transcribe` Edge Function 已部署；
- Groq API Key 已放入 Supabase Secrets；
- 当天语音转写额度未用完；
- 当前网络能访问云端函数。

如果离线时录音，系统可能先缓存，等联网后再尝试转写。不要在看不到转写结果前删除原始记录。

## 通过 Gate 复盘

Gate 里每条 Black Box 记录都应该有明确去向：

| 去向 | 什么时候选 |
| --- | --- |
| 转成任务 | 它包含可执行动作 |
| 挂到已有任务 | 它是某个任务的资料或补充说明 |
| 打盹 | 现在判断不了，但确实值得稍后再看 |
| 丢弃 | 它只是噪声、重复或已经过期 |

如果你发现自己一直打盹同一条记录，说明需要做决定：转任务、归档资料或丢弃。

## 不要长期堆积

Black Box 堆积过多会带来两个问题：

1. 真正重要的记录被噪声淹没。
2. Focus 前的 Gate 处理成本变高。

建议：

- 每天至少清一次 Gate。
- 每条记录尽量在 24 小时内处理。
- 不要把完整文章或项目计划塞进 Black Box。
- 语音转写失败时，先看排障文档，不要重复提交很多次。

## 常见问题

| 问题 | 先检查什么 |
| --- | --- |
| 没有转写结果 | Edge Function、Groq Secret、网络、额度 |
| iOS 录音格式异常 | 浏览器支持的 MIME 类型和 fallback |
| 离线记录没有转写 | 是否已经联网，离线缓存是否仍在 |
| Gate 里内容太多 | 先按“任务/资料/噪声/稍后”四类快速分流 |

更多转写问题见 [transcribe-troubleshooting.md](../../transcribe-troubleshooting.md)。

## 下一步

- 学习专注入口：[Focus 专注模式](04-focus-mode.md)。
- 学习云端函数：[Edge Functions](../04-deploy-operate/03-edge-functions.md)。
