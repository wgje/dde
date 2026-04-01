# Recent Decisions

> 架构决策记录 (ADR) 简要版
> 上次更新：2026-02-27
> 来源：[everything-claude-code Memory Persistence](https://github.com/affaan-m/everything-claude-code)

## 2026-02

### ADR-015: 停泊坞（Parking Dock）模块化拆分

**背景**：原停泊坞单文件过大，功能耦合严重

**决策**：拆分为 `DockStatusMachineComponent`、`DockRadarZoneComponent`、`DockConsoleStackComponent`、`DockDailySlotComponent`

**原因**：单一职责 + 测试粒度更细 + 独立演进

### ADR-014: 测试矩阵系统（run-test-matrix.cjs）

**背景**：测试并发与执行顺序难以控制，CI 偶发超时

**决策**：引入 `scripts/run-test-matrix.cjs`，支持 Lane 分片、Quarantine 隔离、LPT 调度、加权分片

**原因**：
- Quarantine 机制隔离不稳定测试，不影响主干门禁
- LPT（最长处理时间优先）平衡并发分片的执行时间
- `test:baseline:update` / `test:quarantine:update` 自动维护

## 2026-01

### ADR-013: AUTH_CONFIG 启动超时优化（10s → 3s）

**背景**：Sentry Issue #91323207 - 启动阻塞导致 LCP 延迟

**决策**：`AUTH_CONFIG.SESSION_CHECK_TIMEOUT` 从 10s 降至 3s；`GUARD_CONFIG.SESSION_CHECK_TIMEOUT` 降至 2s

**原因**：离线优先架构下本地缓存加载 <100ms，超时设置过长无意义

### ADR-012: 轮询间隔增加（30s → 5 分钟）

**背景**：每 30s 轮询对流量和电量影响不必要

**决策**：`SYNC_CONFIG.POLLING_INTERVAL: 300_000ms`

**原因**：单人 PWA 主要靠乐观更新 + 操作触发同步，轮询仅作兜底

### ADR-011: RetryQueue 大小限制（500 → 100 + IndexedDB 扩展至 1000）

**背景**：localStorage 5-10MB 配额在大 Task content 下易溢出

**决策**：`MAX_RETRY_QUEUE_SIZE: 100`（localStorage），`MAX_RETRY_QUEUE_SIZE_INDEXEDDB: 1000`

### ADR-010: 性能门禁体系建立

**背景**：打包体积和启动时间需要持续监控

**决策**：`npm run perf:guard` = build:dev + nojit 检查 + startup guard + font 契约 + supabase-ready

## 2025-Q3~Q4

### ADR-009: 停泊坞（Parking Dock）功能立项

**背景**：用户需要暂存任务至停泊区并设置提醒，释放工作区注意力

**决策**：新增 `src/app/features/parking/`，不依赖 GoJS，独立于主视图

### ADR-008: Realtime 默认禁用，改用轮询

**背景**：WebSocket 流量成本高，个人 PWA 无实时协作需求

**决策**：`FEATURE_FLAGS.REALTIME_ENABLED = false`，`SYNC_CONFIG.REALTIME_ENABLED` 通过 getter 引用避免双源

### ADR-007: 专注模式独立 Store（focus-stores.ts）

**背景**：Gate/Strata/BlackBox 需要共享但独立于主 store 的状态

**决策**：创建独立 `focus-stores.ts`，不污染 `TaskStore`/`ProjectStore`/`ConnectionStore`

## 2025-01（初始架构）

| 编号 | 决策 | 日期 |
|------|------|------|
| ADR-001 | 语音转写使用 Groq Edge Function 代理（安全性：API Key 不暴露前端） | 2025-01-28 |
| ADR-002 | 黑匣子条目使用客户端 UUID | 2025-01-27 |
| ADR-003 | iOS Safari 录音回退到 mp4（动态检测 `MediaRecorder.isTypeSupported`） | 2025-01 |
| ADR-000 | 客户端 `crypto.randomUUID()` 生成所有实体 ID | 项目初始 |
| ADR-000 | Offline-first + LWW 冲突解决 | 项目初始 |
| ADR-000 | Angular Signals 状态管理，禁止 RxJS Store 化 | 项目初始 |

---

## 待决策

- [ ] Strata 虚拟滚动方案（`@angular/cdk` virtual-scroll vs 自实现）
- [ ] 停泊坞提醒推送（PWA Notifications API 可行性评估）
