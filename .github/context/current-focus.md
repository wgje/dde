# Current Focus

> 上次更新：2026-02-27
> 来源：[everything-claude-code Memory Persistence](https://github.com/affaan-m/everything-claude-code)

## 当前工作焦点

### 正在进行

- [ ] 停泊坞（Parking Dock）组件测试稳定化
  - `parking-dock.component.spec.ts` 在 vitest.components 环境下存在失败
  - 相关组件：`DockStatusMachineComponent`、`DockRadarZoneComponent`、`DockConsoleStackComponent`、`DockDailySlotComponent`

### 已完成（核心功能）

- [x] 核心同步架构（Offline-first + LWW + RetryQueue）
- [x] GoJS 流程图渲染（双视图：文本/流程图无缝切换）
- [x] 基础认证流程（Supabase Auth + Local Mode）
- [x] 专注模式全量实现
  - [x] Gate（大门）：`GateOverlayComponent` + `GateActionsComponent` + `GateCardComponent`
  - [x] Strata（地质层）：`StrataViewComponent` + `StrataLayerComponent` + `StrataItemComponent`
  - [x] BlackBox（黑匣子）：`BlackBoxPanelComponent` + `BlackBoxRecorderComponent` + `BlackBoxEntryComponent`
- [x] 停泊坞（Parking Dock）功能实现
  - [x] `ParkingDockComponent`（主容器）
  - [x] `ParkingNoticeComponent`（提醒通知）
  - [x] `DockStatusMachineComponent`（状态机视图）
  - [x] `DockRadarZoneComponent`（雷达区域）
  - [x] `DockConsoleStackComponent`（控制台栈）
  - [x] `DockDailySlotComponent`（每日时间槽）
- [x] AI 工作流配置（agents/prompts/skills）
- [x] 测试矩阵重构（run-test-matrix.cjs + Lane/Quarantine 系统）
- [x] 性能门禁体系（perf-startup-guard + no-regression-guard）

---

## 关键上下文

- **项目**: NanoFlow
- **技术栈**: Angular 19.2.x + Supabase 2.84+ + GoJS 3.1.x
- **当前分支**: main
- **测试框架**: Vitest 4.0.x + Playwright 1.48+
- **TypeScript**: 5.8.x（严格模式）

---

## 下一步行动

1. 修复停泊坞组件测试（`npx vitest run --config vitest.components.config.mts -- parking-dock`）
2. 运行全量测试确认无回归（`npm run test:run:full`）
3. 更新 `supabase/migrations` 如有数据库变更，并同步 `scripts/init-supabase.sql`

---

## 会话恢复提示

当开始新会话时，请：

1. 读取此文件了解当前焦点
2. 查看 `AGENTS.md` 了解 Hard Rules 和配置基线
3. 查看 `.github/context/recent-decisions.md` 了解近期架构决策
4. 运行 `npm run test:run` 确认当前测试状态
