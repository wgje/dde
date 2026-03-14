# Focus Console 实施差异映射（2026-03-03）

## 审计结论

本次按 `docs/focus-console-design.md` 的 G 表优先级执行，针对“二级级联缺口”完成链路补齐。以下表格是代码证据与测试证据映射。

| 链路 | 关键改动 | 代码位置 | 测试覆盖 | 状态 |
|---|---|---|---|---|
| Session 生命周期链 | 固定 `sessionId/sessionStartedAt`，不再每次导出重建；恢复链补全默认值 | `src/services/dock-engine.service.ts` | `src/services/dock-engine.service.spec.ts` | 已落地 |
| HUD 展示链 | Focus 模式下始终渲染状态机；scrim on=full、off=minimal | `src/app/features/parking/parking-dock.component.ts`, `src/app/features/parking/components/dock-status-machine.component.ts` | `dock-status-machine.component.spec.ts`, `parking-dock.component.spec.ts` | 已落地 |
| 黑匣子归属链 | `createInDock` 默认 `sourceProjectId=null`；UI 新建改走 `createInDock` | `src/services/dock-engine.service.ts`, `src/app/features/parking/parking-dock.component.ts` | `dock-engine.service.spec.ts`, `parking-dock.component.spec.ts` | 已落地 |
| 离线写入链 | Focus/Routine 写入改为 ActionQueue 入队，移除 DockEngine 直写 sync | `src/services/dock-engine.service.ts`, `src/services/action-queue-processors.service.ts` | `dock-engine.service.spec.ts` | 已落地 |
| 完成记录 ID 链 | routine completion 改为 `completionId(UUID)` 载荷，不再拼接复合主键 | `src/models/parking-dock.ts`, `src/app/core/services/sync/focus-console-sync.service.ts` | `dock-engine.service.spec.ts` | 已落地 |
| 多 Tab 控制链 | 新增 leader/follower 服务，follower 只读 + 接管按钮 | `src/services/focus-dock-leader.service.ts`, `src/app/features/parking/parking-dock.component.ts` | `focus-dock-leader.service.spec.ts`, `parking-dock.component.spec.ts` | 已落地 |
| 性能降级链 | 新增 FPS 分级服务 `T0/T1/T2`，UI 按 tier 降级动画 | `src/services/performance-tier.service.ts`, `src/app/features/parking/parking-dock.component.ts` | `performance-tier.service.spec.ts` | 已落地 |

## 数据迁移映射（UUID 化）

| 阶段 | 迁移文件 | 目标 |
|---|---|---|
| Phase 1 | `supabase/migrations/20260303010000_focus_console_uuid_phase1_additive.sql` | 增加 UUID 影子列与 `date_key_v2`，历史回填 |
| Phase 2 | `supabase/migrations/20260303010001_focus_console_uuid_phase2_backfill_dualread.sql` | 切换主键至 UUID，替换 `completed_date -> date_key`，重建索引 |
| Phase 3 | `supabase/migrations/20260303010002_focus_console_uuid_phase3_cleanup.sql` | 清理旧索引/旧列并加固唯一约束 |

## 回归重点

1. 离线态新增/完成 routine 是否正确入队并重放。
2. Focus 切换期间 `sessionId` 是否稳定且可恢复。
3. follower 标签页是否全链路只读，接管后可恢复写入。
4. HUD 拖拽位置是否持久化并跨刷新恢复。

## v3.3 缺口闭环映射（2026-03-04）

| 缺口编号 | 实现点 | 代码位置 | 测试证据 | 状态 |
|---|---|---|---|---|
| G-36 | 专注态备选区 FAB（走现有 `createInDock`） | `src/app/features/parking/parking-dock.component.ts` | `parking-dock.component.spec.ts` (`createBackupTaskFromFab`) | 已实现 |
| G-32 | 雷达来源色点（显式色优先，缺省哈希）+ 项目名可访问文本 | `src/app/features/parking/components/dock-radar-zone.component.ts` | `dock-radar-zone.component.spec.ts` (`project source color dot`) | 已实现 |
| §4.2.3/§4.3.3 | 组合区 8、备选区 10、`+N` 折叠与面板访问 | `dock-radar-zone.component.ts` + `parking.config.ts` | `dock-radar-zone.component.spec.ts` (`overflow trigger/panel`) | 已实现 |
| G-28 | 排序：手动顺序 > 同项目 > 调度分数；手动重排持久化 | `dock-scheduler.rules.ts`, `dock-engine.service.ts`, `parking-dock.component.ts` | `dock-scheduler.rules.spec.ts`, `dock-engine.service.spec.ts` (`reorderDockEntries`) | 已实现 |
| FC-01 | 首次主任务 3s 覆盖提示与改选入口 | `dock-engine.service.ts`, `parking-dock.component.ts` | `dock-engine.service.spec.ts`, `parking-dock.component.spec.ts` | 已实现 |
| §16 | `Alt+H`、`aria-keyshortcuts`、退出确认焦点陷阱与 Esc 优先级 | `parking-dock.component.ts` | `parking-dock.component.spec.ts` (`Alt+H`) | 已实现 |
| §5 | HUD 最小态：顶部居中 200px、禁拖拽、恢复坐标 | `parking-dock.component.ts`, `parking.config.ts` | `parking-dock.component.spec.ts` (`hud minimal mode`) | 已实现 |
| G-37 | 退出专注三分支动作语义 | `parking-dock.component.ts`, `models/parking-dock.ts` | `parking-dock.component.spec.ts`, `dock-engine.service.spec.ts` | 已实现 |
| Hard Rule | Focus 会话推送防抖统一 `3000ms` | `dock-engine.service.ts` (`CLOUD_PUSH_DEBOUNCE_MS`) | `dock-engine.service.spec.ts` (`holdNonCriticalWork should defer cloud push timer`) | 已实现 |
| Shared BlackBox | `BlackBoxEntry.projectId: string \| null`，同步保留 `null` | `models/focus.ts`, `black-box.service.ts`, `black-box-sync.service.ts` | `black-box.service.spec.ts` + `focus-console-sync.service.spec.ts` | 已实现 |
| Sync 测试缺口 | 新增 Focus Console Sync Service 规格测试 | `src/app/core/services/sync/focus-console-sync.service.spec.ts` | `focus-console-sync.service.spec.ts` | 已实现 |

## E2E 关键路径增补（2026-03-04）

| 场景 | 用例位置 | 说明 |
|---|---|---|
| 断网创建 -> 恢复联网 | `e2e/critical-paths/parking-dock.spec.ts` (`offline backup FAB creation should keep working and survive reconnect`) | 专注态离线点击备选 FAB 可写入，恢复联网后会话保持可用 |
| 退出三分支 | `e2e/critical-paths/parking-dock.spec.ts` (`exit confirm should support keep/clear/save three branches`) | 覆盖 keep/clear/save 三分支行为语义 |
| 共享仓条目留存 | `e2e/critical-paths/parking-dock.spec.ts` (`shared black-box entries should persist sourceProjectId=null in local snapshot`) | 验证本地快照中共享条目 `sourceProjectId` 保持 `null` |

- 2026-03-04 复测补丁：修复专注入口 selector 漂移（`project-shell-focus-session-toggle` -> `spotlight-trigger`），并保留 `dock-focus-session-toggle` 事件兜底，当时 `npx playwright test e2e/critical-paths/parking-dock.spec.ts` 10/10 通过。
- 2026-03-12 复测更新：`parking-dock` 的 planner / touch-target / build budget 主链已重新拉绿，但 `parking-notice` 的 eviction notice 浏览器链仍未通过，不能再把 2026-03-04 的通过记录当作当前分支签收依据。

## 迁移补充

- 新增：`supabase/migrations/20260304000000_focus_console_gap_fill.sql`
  - `black_box_entries.project_id` 显式允许 `NULL`
  - 增加共享仓增量同步索引 `idx_black_box_entries_user_shared_updated`

## v3.3 收口补全（2026-03-04，Final）

| 闭环 | 实现点 | 代码位置 | 验收证据 | 状态 |
|---|---|---|---|---|
| 就地创建立即持久化 | `createInDock` 写共享黑匣子条目并回填 `sourceBlackBoxEntryId`，失败不阻断 UI 且标记 `inlineArchiveStatus='failed'` | `src/services/dock-engine.service.ts` | `dock-engine.service.spec.ts`（create + fallback） | 已实现 |
| 退出归档引导 + 执行 | `save-exit/clear-exit` 统一进入归档引导（60s 倒计时 + 立即归档 + 失败重试） | `src/app/features/parking/parking-dock.component.ts` | `parking-dock.component.spec.ts`（save/clear/keep 分支 + countdown） | 已实现 |
| 归档替换轻量闭环 | `dock-created -> project-task`（active project, stage=null）并回写 planner 字段、完成态、黑匣子归档 | `src/services/dock-engine.service.ts` | `dock-engine.service.spec.ts`（success/partial/no-active-project） | 已实现 |
| 黑匣子 `focus_meta` 数据链 | Supabase 类型、同步 upsert/select/map、迁移列与校验约束 | `src/models/supabase-types.ts`, `src/services/black-box-sync.service.ts`, `supabase/migrations/20260304010000_focus_console_inline_blackbox_meta.sql` | `black-box.service.spec.ts`, `black-box-sync.service.spec.ts` | 已实现 |
| E2E 语义对齐 | 专注切换 selector 漂移修复（spotlight-trigger 优先 + 事件兜底）、退出链路在 keep 后回切 scrim 再确认、归档路径断言对齐 | `e2e/critical-paths/parking-dock.spec.ts` | `npx playwright test e2e/critical-paths/parking-dock.spec.ts`（2026-03-04：10/10） | 已修复并复测通过 |
