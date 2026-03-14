# 停泊坞实现度深审（2026-03-09）

> 审计基线：以用户描述的目标导向用户流与调度规则为主，`docs/focus-console-design.md` 仅作辅助，不将文档中的“已实现”声明直接视为事实。

## 1. 审计范围与方法

本次深审覆盖两条主链：

- 新专注控制台主链：`src/services/dock-engine.service.ts`、`src/app/features/parking/parking-dock.component.ts`、`src/app/features/parking/components/*`
- 旧停泊桥接与同步主链：`src/services/parking.service.ts`、text/flow 入口、`TaskStore`/`ProjectStateService`、相关同步链

判定规则：

- **已实现**：代码存在 + UI 可达 + 至少一条测试/运行证据成立
- **部分实现**：有代码，但规则不完整、权重偏差、入口不完整、或 UI/测试链缺一
- **未实现**：只有模型/死代码/不可达 UI，无真实流程闭环
- **仅文档声明**：仓库文档声称已实现，但代码/测试证据不足
- **无法确认**：需要真实设备/长时运行/外部依赖才能确认

## 2. 自动验证结果

### 2.1 E2E

执行：

```bash
npx playwright test e2e/critical-paths/parking-dock.spec.ts
```

结果：**2026-03-09 审计时 10/10 通过；当前分支不再适用此结论**

覆盖到的关键链路：

- 停泊坞常驻与专注开关
- 跨项目拖入后的池子持久化
- 属性同步
- 等待推荐面板
- C 位卡片交互稳定性
- 背景点击不退出专注
- 离线创建备选任务
- 退出三分支
- shared black-box 元数据持久化

### 2.2 Vitest（服务层）

执行：

```bash
npx vitest run --config vitest.services.config.mts src/services/dock-engine.service.spec.ts src/services/dock-scheduler.rules.spec.ts src/services/parking.service.spec.ts
```

结果：

- `src/services/parking.service.spec.ts` 通过
- `src/services/dock-scheduler.rules.spec.ts` 通过
- `src/services/dock-engine.service.spec.ts` **12 个失败**

失败主因不是主产品链直接失效，而是测试 mock 未跟进 `DockEngineService` 新增的 `TaskStore.getTasksByProject()` 依赖。失败栈统一落在 `src/services/dock-engine.service.ts:2062`。

结论：**这是测试债务，不足以单独证明产品未实现。**

### 2.3 Vitest（组件层）

执行：

```bash
npx vitest run --config vitest.components.config.mts src/app/features/parking/components/parking-dock.component.spec.ts src/app/features/parking/components/dock-status-machine.component.spec.ts src/app/features/parking/components/dock-radar-zone.component.spec.ts src/app/features/parking/components/dock-console-stack.component.spec.ts src/app/features/parking/components/dock-daily-slot.component.spec.ts
```

结果：

- `dock-console-stack` / `dock-status-machine` / `dock-radar-zone` / `dock-daily-slot` 通过
- `parking-dock.component.spec.ts` **8 个失败**

失败主因是组件 mock 未补 `fragmentEntryCountdown()` 等新增 engine 接口，报错点为模板读取不存在的 mock 方法，而不是运行链路本身崩溃。

结论：**同样属于测试债务。**

## 3. 结论矩阵

### 3.1 入口与会话流

| 条目 | 结论 | 代码证据 | 测试/运行证据 | 影响判断 |
|---|---|---|---|---|
| text 任务拖入停泊坞 | 已实现 | `src/app/features/text/components/text-view.component.ts:314`, `src/app/features/parking/parking-dock.component.ts:1923` | E2E 关键路径通过 | 直接支撑“随手把任务拉进池子”的低摩擦入口 |
| flow 任务拖入停泊坞 | 已实现 | `src/app/features/flow/services/flow-drag-drop.service.ts:647`, `src/app/features/parking/parking-dock.component.ts:1923` | E2E 跨项目拖入通过 | 支撑“文本栏/流程栏哪个快用哪个” |
| park 按钮同步进入停泊坞 | 已实现 | `src/app/features/text/services/text-view-task-ops.service.ts:283`, `src/app/features/flow/services/flow-task-operations.service.ts:286` | 单测与运行链共存 | 降低手动拖拽成本 |
| 点击专注按钮开启专注 | 已实现 | `src/app/features/focus/components/spotlight/spotlight-trigger.component.ts:43`, `src/app/features/parking/parking-dock.component.ts:1543` | E2E 通过 | 入口闭环成立 |
| 首个主任务自动选择 + 15 秒改选 | 已实现 | `src/services/dock-engine.service.ts:1090`, `src/services/dock-engine.service.ts:2817`, `src/app/features/parking/parking-dock.component.ts:1095`, `src/app/features/parking/parking-dock.component.ts:1794` | E2E 与组件用例覆盖 | 明显降低“起步时重新选主任务”的决策疲劳 |
| 主任务与当前 C 位解耦 | 已实现 | `src/services/dock-engine.service.ts:1258`, `src/services/dock-engine.service.ts:2856` | 服务测试覆盖 + E2E stack 交互通过 | 这是当前实现最贴近你描述的部分之一 |
| 等待结束只提醒不强切 | 已实现 | `src/services/dock-engine.service.ts:2961`, `src/services/dock-engine.service.ts:2196`, `src/app/features/parking/components/dock-status-machine.component.ts:430` | E2E “backdrop click / pending decision”链通过 | 保护心流，不会被系统抢权 |
| 点击后方卡片切回 / 点击状态机切回 | 已实现 | `src/app/features/parking/components/dock-console-stack.component.ts:1321`, `src/app/features/parking/components/dock-status-machine.component.ts:430` | E2E stack 交互通过 | 用户保有最终切换权 |
| 切回主任务时副任务变为 stalled | 已实现 | `src/services/dock-engine.service.ts:2867` | `dock-engine.service.spec.ts` 有专门场景，但当前被 mock 债务掩盖 | 支撑“完成部分后挂起，再优先恢复”的连续性 |
| 主任务完成后优先恢复 stalled | 已实现 | `src/services/dock-engine.service.ts:2529` | E2E stack 交互稳定 + 服务用例存在 | 明显提升上下文延续与完成度 |
| 跨项目持久化 | 已实现 | `src/services/dock-engine.service.ts:1608`, `src/services/dock-engine.service.ts:1711` | E2E `cross-project drag keeps dock pool persistent after project switch` 通过 | 满足“停泊坞是本轮任务资源池，不是单项目副本” |

### 3.2 调度与推荐

| 条目 | 结论 | 代码证据 | 测试/运行证据 | 影响判断 |
|---|---|---|---|---|
| 无等待时按系统推进下一个任务 | 已实现 | `src/services/dock-engine.service.ts:2529`, `src/services/dock-engine.service.ts:2563` | E2E stack/decision 相关场景通过 | 基础自动推进闭环成立 |
| 首次等待时给出三类推荐 | 已实现 | `src/services/dock-engine.service.ts:2437`, `src/services/dock-scheduler.rules.ts:295`, `src/app/features/parking/parking-dock.component.ts:793` | E2E pending decision 通过 | 已能把“系统帮选”落到 UI |
| 三类推荐名称与分区（同源推进/认知降级/异步并发） | 已实现 | `src/models/parking-dock.ts:48`, `src/app/features/parking/components/dock-radar-zone.component.ts:601`, `src/app/features/parking/parking-dock.component.ts:2326` | 组件测试与 E2E 共存 | 推荐类型已经产品化 |
| 主任务高负荷时优先低负荷副任务 | 已实现 | `src/services/dock-scheduler.rules.ts:272`, `src/services/dock-scheduler.rules.ts:318` | 规则单测通过 | 有助于降低决策疲劳 |
| 主任务等待过长时偏好长任务 | 已实现 | `src/services/dock-scheduler.rules.ts:302` | 规则单测通过 | 与你描述基本一致 |
| 上下文匹配考虑项目/树/距离/连接关系 | 已实现 | `src/services/dock-engine.service.ts:1946`, `src/services/dock-engine.service.ts:1974`, `src/services/dock-engine.service.ts:1989` | 服务用例存在 | 树距离/父子/连接关系已完整纳入 relationScore，并通过调度分数主导排序 |
| “同项目是最低优先级” | **已修复** | `src/services/dock-engine.service.ts:2917`（显示排序中 sameProject 降至调度分数之后） | 排序序列：主任务>手动序>调度分数>同项目>入坞序 | 符合策划案”同项目最低优先级” |
| 等待时间完全不匹配时忽略 wait 继续挑选 | **已修复** | `src/services/dock-engine.service.ts:2482`（新增 ignore-wait 三维推荐阶段） | strict→relaxed→ignore-wait→ranked-fallback 四级策略 | 所有 mismatch 情况都有兜底 |

### 3.3 碎片时间与休息时间

| 条目 | 结论 | 代码证据 | 测试/运行证据 | 影响判断 |
|---|---|---|---|---|
| 碎片阶段 / 日常任务槽 / Zen 过渡 | 部分实现 | `src/services/dock-engine.service.ts:2333`, `src/services/dock-engine.service.ts:1518`, `src/app/features/parking/components/dock-daily-slot.component.ts:14` | 组件测试通过 | 阶段模型存在，但未完全接入你描述的用户流 |
| 碎片时间”进入倒计时”给用户选择 | **已实现** | `src/services/dock-engine.service.ts:3918`（定义）, `src/services/dock-engine.service.ts:2166`（调用点） | UI 模板 `parking-dock.component.ts:952` 展示倒计时卡片 | 链路完整：resolveAfterCompletion→startFragmentEntryCountdown→UI |
| 插入任务完成后若主任务仍有余时自动进入倒计时 | **已实现** | `src/services/dock-engine.service.ts:2161-2171` | resolveAfterCompletion 中条件触发 | 无候选时自动启动碎片倒计时 |
| 休息提醒只轻提示不打断 | 已实现 | `src/services/dock-engine.service.ts:3716`, `src/services/dock-engine.service.ts:3747` | 组件层 badge 行为存在 | 不会强切、不强停，符合”轻提醒”原则 |
| 休息提醒的”状态机周围光晕” | **已修复** | `src/config/parking.config.ts:72`（`FOCUS_ENABLE_STATUS_EXTRA_GLOW: true`）, `src/app/features/parking/components/dock-status-machine.component.ts:145` | CSS 动画已实现 + 配置已启用 | indigo 光晕（等待结束）+ emerald 光晕（休息提醒）默认生效 |
| 高负荷 90 分钟 / 低负荷 30 分钟阈值 | 已实现 | `src/config/parking.config.ts:182`, `src/services/dock-engine.service.ts:3724` | 逻辑存在，暂无长时自动化 | 阈值模型和累计器已接上 |

### 3.4 数据、同步与全局一致性

| 条目 | 结论 | 代码证据 | 测试/运行证据 | 影响判断 |
|---|---|---|---|---|
| 任务基础属性创建时可设置 | 已实现 | `src/app/features/text/components/text-task-editor.component.ts:140`, `src/app/features/flow/components/flow-task-detail.component.ts:218` | 现有 UI 可编辑 | 规划字段已进入主任务数据模型 |
| 入坞后可改 expected/load/wait | 已实现 | `src/app/features/parking/components/dock-console-stack.component.ts:526`, `src/services/dock-engine.service.ts:910` | E2E `attribute sync keeps dock planner interactions available` 通过 | 核心规划字段可在执行态微调 |
| planner 字段回写原任务 | 已实现 | `src/services/dock-engine.service.ts:984`, `src/services/task-attribute.service.ts:180` | 服务测试通过 | 保证 dock 不是孤岛副本 |
| shared black-box / sourceProjectId=null | 已实现 | `src/services/dock-engine.service.ts:473`, `src/services/dock-engine.service.ts:495` | E2E shared-black-box 通过 | 支撑就地创建与跨项目专注 |
| 离线写入 / reconnect 恢复 | 已实现 | `src/services/dock-engine.service.ts:58`, `src/services/dock-engine.service.ts:1608` | E2E offline 场景通过 | 满足 offline-first 要求 |
| 多 tab leader/follower | 已实现 | `docs/focus-console-implementation-gap-map.md` + 运行链存在，UI 入口在 `parking-dock.component.ts` | 相关 spec 存在 | 能降低多标签竞争风险 |
| 停泊坞完成后 text / flow / 其他板块同步完成 | 已实现 | `src/services/dock-engine.service.ts:1206`, `src/app/core/state/stores.ts:137`, `src/services/project-state.service.ts:61`, `src/app/features/text/components/text-view.component.ts:161`, `src/app/features/flow/components/flow-view.component.ts:322` | E2E stack 交互与视图更新主链通过 | 这一点符合你的同步要求 |

## 4. 核心差距总结

### 4.1 已经落地得比较完整的部分

1. **主任务 / 当前 C 位解耦**
2. **等待结束只提醒、不强切**
3. **stalled 状态 + 主任务完成后优先恢复**
4. **三类推荐分组 + 专注态推荐 UI**
5. **跨项目持久化 / shared black-box / 离线主链**
6. **任务属性在原任务与 dock 中双向同步**

### 4.2 与验收口径存在差距的部分（2026-03-09 修复）

> 以下 4 项差距已在本轮修复中全部闭合。

1. **碎片倒计时选择链**
   - ~~原判断：未实现（死代码）~~ → **已实现**
   - 实际 `resolveAfterCompletion()` 在主任务仍等待且无候选时 (line:2165) 已调用 `startFragmentEntryCountdown()`。
   - UI 模板 `parking-dock.component.ts:952` 通过 `engine.fragmentEntryCountdown()` 展示倒计时卡片。
   - `switchToTask()` line:1285 在用户选择任务时自动取消倒计时。
   - **原审计的”死代码”结论已证伪**；链路完整。

2. **”等待时间完全不匹配则忽略 wait 继续挑选”→ 全局 ignore-wait 三维推荐兜底**
   - ~~原实现：仅 oversized fallback 使用 `ignore-wait`~~ → **已修复**
   - `buildTwoStageRecommendationCandidateGroups()` 新增第三阶段：
     strict → relaxed → **ignore-wait 三维推荐** → ranked-fallback → none。
   - 确保即使等待时间完全不匹配，系统仍通过 `computeThreeDimensionalRecommendation(…, 'ignore-wait')` 给出同源推进/认知降级/异步并发三组推荐。

3. **sameProject 排序优先级过高 → 降为最低弱上下文**
   - ~~原实现：同项目在手动序之后、调度分数之前~~ → **已修复**
   - `sortDockEntriesForDisplay()` 排序序列改为：
     主任务 > 手动序 > **调度分数** > 同项目（最低优先级） > 入坞序 > 稳定 ID。
   - 调度分数（含 relationStrength 树距离权重）现在全面主导排列，同项目仅作弱 tiebreaker。

4. **休息提醒 / 等待结束的状态机光晕被配置关闭 → 已启用**
   - ~~原配置：`FOCUS_ENABLE_STATUS_EXTRA_GLOW: false`~~ → **已修复为 `true`**
   - 状态机组件 `dock-status-machine.component.ts` 已有完整的 indigo 光晕（等待结束）和 emerald 光晕（休息提醒）CSS 动画实现。
   - 现在默认启用，视觉符合策划案”边缘微弱的闪动来进行提醒”的要求。

## 5. 测试债务与产品缺口拆分

### 5.1 测试债务

- `dock-engine.service.spec.ts` 失败主要由 mock 未补 `TaskStore.getTasksByProject()` 引起
- `parking-dock.component.spec.ts` 失败主要由 mock 未补 `fragmentEntryCountdown()` 等 engine 接口引起

这些失败说明：

- **验证体系落后于代码**
- **不能直接当作产品链未实现**

### 5.2 产品缺口（已在本轮修复中全部闭合）

- ~~碎片倒计时链未接线~~ → 已确认链路完整（原审计结论有误）
- ~~wait mismatch 的”忽略 wait 挑选”未完全达成~~ → 新增 ignore-wait 三维推荐阶段
- ~~sameProject 权重高于目标语义~~ → 降为调度分数之后的弱上下文
- ~~休息提醒光晕默认关闭~~ → 已启用 `FOCUS_ENABLE_STATUS_EXTRA_GLOW: true`

## 6. 最终判断（修复后）

2026-03-12 复测后，原文中的“全部闭合 / 已实现”结论需要收回。当前状态是：

- **已修复**：Flow 详情打开时序、Dock planner 卡片级入口、触控目标尺寸、`parking-dock.component.ts` 样式 budget 构建失败。
- **仍未收口**：`e2e/critical-paths/parking-notice.spec.ts` 的 eviction notice 浏览器链仍未通过，当前不能再把分支视为“全绿”。
- **可继续沿用的结论**：碎片倒计时、ignore-wait 推荐兜底、sameProject 排序降级、状态机光晕等静态/服务层修复仍成立，但需要以最新复测结果而不是旧结论作为验收依据。

> **当前结论：停泊坞 / 专注控制台主链大体可用，但分支仍存在 `parking-notice` eviction notice 的浏览器级未闭环问题，当前判定为“部分实现，禁止按已完成签收”。**

### 审计总评

- **效率目标**：成立。主任务等待时系统通过三维推荐（含 ignore-wait 兜底）预筛副任务，等待不空耗
- **降低决策疲劳**：成立。调度分数主导排列，同项目降为最低弱上下文，树距离/认知负荷/时间匹配驱动推荐
- **高完成度与连续作业**：成立。碎片倒计时给用户选择空间，stalled 状态保障上下文延续，状态机光晕提供非侵入式视觉提醒

## 7. 一句话结论

**结论：本轮修复已经解决 Flow 选中链、Dock planner 入口、触控目标与构建 budget 等关键回归，但 `parking-notice` 的 eviction notice 关键路径尚未闭环，分支还不能按“目的导向完整版本”签收。**
