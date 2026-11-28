---
title: Parking Dock 停泊坞
status: canonical
audience: user
last_verified: 2026-11-28
category: use-nanoflow
source_paths:
  - README.md
  - docs/parking-dock-modular-design.md
  - src/app/features/parking/
  - src/services/dock-engine.service.ts
  - src/app/dev-preview/demo-dock-entry-preview.component.ts
---

# Parking Dock 停泊坞

Parking Dock 暂时收纳仍然重要、但现在不应占据工作区焦点的任务；停泊不是删除或归档。

## 手机端透明入口

文本视图底部只显示轻量透明的“停泊坞 · 数量”与展开箭头，不再放置整块悬浮面板。入口无填色、边框和阴影；轻触或键盘聚焦时只出现淡淡底色，触控区域仍至少 44px。Focus 保留为低强调文字操作。

- 点按停泊坞入口打开抽屉，查看当前主任务、可行动候选和等待/待命任务。
- 点任务先查看预览，预览本身不改变当前任务。
- 确认“设为当前任务”后，才通过现有 Focus/Dock 选择逻辑切换。
- 只读跟随设备可以查看，但不能确认切换。

可直接查看真实组件的开发示例：[`手机收起入口`](../../../#dev-preview/dock/mobile-entry) 和 [`手机展开抽屉`](../../../#dev-preview/dock/mobile-open)。示例任务只在当前页面内存中，不读取或写入工作区任务。
