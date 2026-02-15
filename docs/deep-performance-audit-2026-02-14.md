# NanoFlow / DDE 线上性能瓶颈深度审计报告

- 报告日期：2026-02-14
- 审计对象：`https://dde-eight.vercel.app/#/projects`
- 审计账号：`1@qq.com / 1`
- 执行环境：Playwright 1.58.0 + Chromium 145 headless（真实线上站点）
- 数据口径：
  - 传输体积以 `PerformanceEntry.transferSize` 为主
  - 资源原始体积以 `content-length` 辅助
  - 指标以本次采样结果为准，不复用历史文档推断

---

## 1. 执行摘要

### 1.1 结论总览（P0 / P1 / P2）

- **P0-1（高优先级）**：桌面端仍会在登录后自动触发 Flow/GoJS 大 chunk（`chunk-LFLKK2NT.js`）加载，单文件传输约 `364,875 B`（解压后 `1,359,030 B`），在弱网+4xCPU 下直接拉高 LCP 和主线程长任务。
- **P0-2（高优先级）**：登录后出现 `get_full_project_data` 的 `400 Access denied to project ...`，随后触发回退顺序加载，造成额外请求链路和时延。
- **P0-3（高优先级）**：`black_box_entries` 在登录阶段存在重复拉取（同一会话内观测到 2 次），属于可避免的同步冗余流量。
- **P1-1（中优先级）**：字体子集命中数量高，桌面单次会话实际命中 `14` 个 `.woff2`，累计传输约 `761,528 B`，在弱网下与 JS 争抢带宽。
- **P1-2（中优先级）**：Focus/BlackBox 的 idle 初始化链路与主业务加载并行，导致“首屏完成后持续网络与执行活跃”，影响弱网稳定性与可预测性。
- **P2（规划项）**：需要建立弱网专项门槛、RPC 错误率告警、重复拉取告警，形成持续回归保护。

### 1.2 业务影响

- 首屏体验：常规网络下表现可接受（桌面 LCP 中位约 `668ms`），但压力场景退化明显。
- 弱网可用性：弱网+4xCPU 下 `LCP ≈ 26,172ms`，登录入口可见时间 `≈ 36,168ms`，可感知卡顿明显。
- 同步稳定性：RPC 400 + 回退、重复 black-box 拉取增加了链路复杂度和请求噪声。

---

## 2. 调查方法与环境

### 2.1 采样场景

- 场景 A：桌面常规网络（`desktop-normal`）
- 场景 B：移动端常规网络（`mobile-normal`）
- 场景 C：桌面弱网 + 4x CPU（`desktop-throttled`）

### 2.2 关键采样文件

- `/tmp/dde-perf-audit-1771056312151.json`（三场景总览）
- `/tmp/dde-perf-desktop-full-1771056530000.json`（桌面全量资源明细）
- `/tmp/dde-perf-mobile-full-1771056570087.json`（移动端全量资源明细）

### 2.3 代码证据定位范围

- 路由与视图加载：`src/app/core/shell/project-shell.component.ts`
- Focus/BlackBox 初始化：`src/app.component.html`、`src/app/features/focus/focus-mode.component.ts`
- BlackBox 同步实现：`src/services/black-box-sync.service.ts`
- 会话后台同步：`src/services/user-session.service.ts`
- RPC 加载与回退：`src/app/core/services/sync/project-data.service.ts`
- 字体与 preload/prefetch：`index.html`

---

## 3. 指标总表

### 3.1 三场景核心指标

| 场景 | nav->登录弹窗 | 提交->URL稳定 | LCP | CLS | INP-like | Long Task（次数/总时长/最大） |
|---|---:|---:|---:|---:|---:|---|
| desktop-normal | 583ms | 266ms | 508ms | 0.0049 | 200ms | 5 / 367ms / 115ms |
| mobile-normal | 496ms | 270ms | 608ms | 0.0203 | 80ms | 1 / 93ms / 93ms |
| desktop-throttled | 36,168ms | 9,752ms | 26,172ms | 0.0011 | 160ms | 16 / 1,829ms / 421ms |

### 3.2 基线中位数（桌面常规，3 次）

| 指标 | 中位值 |
|---|---:|
| LCP | ~668ms |
| 登录提交到路由稳定（submitToUrl） | ~321ms |
| JS 传输量 | ~1,082,730 B |
| 字体传输量（命中子集汇总） | ~761,528 B |

### 3.3 资源体积分解（桌面全量）

| 类别 | 请求数 | transferSize |
|---|---:|---:|
| Script | 36 | 1,082,730 B |
| CSS | 13 | 623,252 B |
| Link（含字体 preload/prefetch + 主样式） | 5 | 164,350 B |
| Fetch（Supabase） | 12 | 0 B（接口响应多为 chunked，体积未体现在 transferSize） |

桌面静态资源（Script + CSS + Link）总传输约：`1,870,332 B`。

### 3.4 桌面 vs 移动差值（全量）

| 项目 | 桌面 | 移动 | 差值 |
|---|---:|---:|---:|
| JS transfer | 1,082,730 B | 717,855 B | +364,875 B |
| CSS+Link transfer | 787,602 B | 592,962 B | +194,640 B |

`+364,875 B` 与 `chunk-LFLKK2NT.js` 完全对齐，说明桌面相对移动的关键差异主要来自 Flow/GoJS 相关 chunk 自动加载。

---

## 4. 瓶颈分层分析

## 4.1 网络层瓶颈

### 现象

- 桌面会话中，字体子集命中 `14` 个 `.woff2`，累计约 `761,528 B`。
- 最大 JS 资源为 `chunk-LFLKK2NT.js`，传输约 `364,875 B`，解压后约 `1,359,030 B`。
- 在弱网场景，关键 JS 与字体下载耗时显著拉长，直接拖累 LCP。

### 证据

- 资源 Top（桌面全量）：
  - `chunk-LFLKK2NT.js` transfer=`364,875`
  - `main-QGA6C4DS.js` transfer=`166,361`
  - `chunk-UIAGOE2K.js` transfer=`143,776`
- 字体头信息（线上 HEAD）：单文件 `content-length` 多在 `47KB~66KB`。

### 影响

- 弱网下，字体与 JS 抢占同一下载窗口，导致关键交互路径延迟放大。

## 4.2 执行层瓶颈

### 现象

- 弱网+4xCPU：Long Task 增至 `16` 次，总 `1,829ms`，最大 `421ms`。
- LCP 从常规亚秒级退化到 `26s` 量级。

### 证据

- `desktop-throttled`：
  - `LCP = 26,172ms`
  - `LongTask max = 421ms`
  - `Flow auto load = 22,446ms`（桌面 Flow 自动出现耗时）

### 影响

- 主线程长阻塞造成明显卡顿和输入反馈延迟。

## 4.3 数据层瓶颈

### 现象 A：`black_box_entries` 重复拉取

- 登录阶段观测到两次 `black_box_entries?...updated_at=gt.1970...`。

### 现象 B：RPC 400 后回退加载

- 观测到：`/rpc/get_full_project_data` 返回 `400`。
- 响应体：`{"code":"P0001","message":"Access denied to project ..."}`。
- 后续回退顺序查询 `projects?...id=eq...` 等请求链路。

### 影响

- 同步链路噪声增大，增加失败面与响应时间波动。

## 4.4 架构层瓶颈

### 现象

- 多条 idle/初始化链路叠加：FocusMode、Flow defer、BlackBox 同步在登录后短窗口内并行触发。
- 结果是“页面已显示但后台仍密集请求 + 执行活跃”。

### 影响

- 常规网络下影响可被掩盖；弱网/低端设备下会放大为明显卡顿。

---

## 5. 代码级根因定位（现象 -> 触发路径 -> 影响）

### 5.1 桌面 Flow chunk 自动加载

- 现象：桌面比移动额外多 `364,875 B` JS。
- 触发路径：`@defer (on idle; prefetch on idle)`。
- 代码定位：`src/app/core/shell/project-shell.component.ts:247`
- 影响：即使用户未主动进入 Flow，桌面也会在 idle 触发 Flow chunk 下载与初始化。

### 5.2 FocusMode 触发 BlackBox 早期拉取

- 现象：登录后早期出现 black-box 拉取。
- 触发路径：
  - `src/app.component.html:98`（`@defer (on idle)` 加载 FocusMode）
  - `src/app/features/focus/focus-mode.component.ts:138`（`await this.blackBoxSyncService.pullChanges()`）
- 影响：与登录后主数据加载并行，增大首阶段请求竞争。

### 5.3 BlackBox 增量起点过于保守导致首拉偏重

- 现象：无 lastSync 时从 epoch 拉取。
- 触发路径：`const lastSync = this.lastSyncTime || '1970-01-01T00:00:00Z'`
- 代码定位：`src/services/black-box-sync.service.ts:509`
- 影响：首次/失效场景请求范围过大，且与其他链路重复概率提升。

### 5.4 后台当前项目加载触发 RPC 400

- 现象：`get_full_project_data` 返回 `Access denied to project ...`。
- 触发路径：
  - 后台同步按 `activeProjectId` 拉当前项目：`src/services/user-session.service.ts:380`
  - RPC 调用：`src/app/core/services/sync/project-data.service.ts:83`
  - 失败后回退顺序加载：`src/app/core/services/sync/project-data.service.ts:88`
- 影响：无效 RPC + fallback 增加额外 RTT 与请求负载。

### 5.5 字体策略与首阶段资源竞争

- 现象：字体子集命中数量高，累计传输接近 `0.76MB`。
- 触发路径：
  - `index.html:62`（preload 119）
  - `index.html:63`（prefetch 118）
  - `index.html:64`（prefetch 117）
  - `index.html:104`（异步加载 `lxgw-wenkai-screen.css`）
- 影响：弱网下字体下载可能与关键 JS 竞争下载窗口。

---

## 6. 优化清单（可执行，含收益/风险/回滚）

### 6.1 P0（立即实施）

| 编号 | 优化项 | 预期收益 | 风险 | 回滚点 |
|---|---|---|---|---|
| P0-1 | 阻断 `black_box_entries` 重复拉取（增加 freshness window + single-flight + user-trigger gate） | 登录后首 10s fetch 数下降，减少同步噪声 | 可能延迟黑匣子最新态 | 保留开关，回退到现有 `pullChanges()` 调用策略 |
| P0-2 | `get_full_project_data` 前置校验 activeProjectId 可访问性；命中 `Access denied` 时不再走同路径 fallback | 消除无效 400 + 回退请求链 | 需要调整会话恢复逻辑 | 保留原 fallback 分支开关 |
| P0-3 | 桌面 Flow 改为用户意图触发（tab/hover/显式点击）或延迟更晚时机 | 直接减少 `364,875 B` 首阶段 JS | 首次进 Flow 可能多一次等待 | 退回 `@defer(on idle; prefetch on idle)` |

### 6.2 P1（中期优化）

| 编号 | 优化项 | 预期收益 | 风险 | 回滚点 |
|---|---|---|---|---|
| P1-1 | 字体策略收敛：首屏只保留最小子集，延后其余子集拉取 | 降低首阶段带宽争抢，弱网 LCP 改善 | 极端字符集可能短暂 fallback | 还原当前 `index.html` 字体 preload/prefetch |
| P1-2 | FocusMode/BlackBox 初始化解耦：首屏阶段只做本地读取，远端拉取延后 | 降低登录后前 5~10s 并发请求峰值 | Focus 模块数据新鲜度略后移 | 还原当前 `ngOnInit -> pullChanges()` |

### 6.3 P2（治理与监控）

| 编号 | 优化项 | 预期收益 | 风险 | 回滚点 |
|---|---|---|---|---|
| P2-1 | 建立弱网专项预算（LCP、LongTask、请求数）并接入 CI 回归 | 防止回归 | CI 时间增加 | 关闭弱网回归 Job |
| P2-2 | 增加日志与告警：RPC 400 率、重复 black-box 拉取次数 | 问题可观测 | 告警噪音 | 下调阈值或关闭告警项 |

---

## 7. 验收与回归基线

### 7.1 建议验收阈值

| 维度 | 当前基线 | 验收目标 |
|---|---:|---:|
| 桌面常规 LCP（中位） | ~668ms | < 1,200ms（保持） |
| 弱网+4xCPU LCP | ~26,172ms | < 6,000ms |
| 弱网 nav->登录弹窗 | ~36,168ms | < 5,000ms |
| 登录后重复 `black_box_entries` 拉取 | 2 次 | ≤ 1 次 |
| `get_full_project_data` 400 | 发生 | 0 次 |

### 7.2 复测建议

- 场景回归必须覆盖：桌面常规、移动常规、弱网+4xCPU。
- 每次改动输出：
  - Core Web Vitals
  - Long Task 分布
  - Fetch 时序（含状态码）
  - 资源 Top（transferSize）

---

## 8. 附录（明文证据）

## 8.1 原始产物路径

- `/tmp/dde-perf-audit-1771056312151.json`
- `/tmp/dde-perf-desktop-full-1771056530000.json`
- `/tmp/dde-perf-mobile-full-1771056570087.json`

## 8.2 Supabase 关键请求时序片段（节选）

```text
817ms   REQ GET  .../rest/v1/black_box_entries?...updated_at=gt.1970...
904ms   REQ POST .../auth/v1/token?grant_type=password
1466ms  RES 200  .../rest/v1/black_box_entries?...
1524ms  RES 200  .../auth/v1/token?grant_type=password
1547ms  REQ POST .../rest/v1/rpc/get_full_project_data
1887ms  REQ GET  .../rest/v1/black_box_entries?...updated_at=gt.1970...
1990ms  RES 400  .../rest/v1/rpc/get_full_project_data
```

## 8.3 RPC 400 响应体（明文）

```json
{"code":"P0001","details":null,"hint":null,"message":"Access denied to project ed14f7cc-14b2-4a0b-b20c-9688b8dde1bb"}
```

## 8.4 关键资源头信息（节选）

- `https://dde-eight.vercel.app/chunk-LFLKK2NT.js`
  - `content-length: 1359030`
  - `cache-control: public, max-age=31536000, immutable`
- `https://dde-eight.vercel.app/main-QGA6C4DS.js`
  - `content-length: 600782`
- `https://dde-eight.vercel.app/chunk-UIAGOE2K.js`
  - `content-length: 422233`
- `https://dde-eight.vercel.app/fonts/lxgwwenkaiscreen-subset-105.woff2`
  - `content-length: 66360`

## 8.5 代码定位索引（本报告使用）

- `src/app/core/shell/project-shell.component.ts:247`
- `src/app.component.html:98`
- `src/app/features/focus/focus-mode.component.ts:138`
- `src/services/black-box-sync.service.ts:509`
- `src/services/user-session.service.ts:380`
- `src/app/core/services/sync/project-data.service.ts:83`
- `src/app/core/services/sync/project-data.service.ts:88`
- `index.html:62`
- `index.html:63`
- `index.html:64`
- `index.html:104`

---

## 9. 风险与回滚策略（交付视角）

- 本次交付仅新增报告文档，不改代码，线上行为无直接变更风险。
- 后续实施建议按 P0->P1->P2 逐项上线，每项独立提交，确保可快速回滚。
- 每项优化上线后必须复测三场景并对比本报告基线。

