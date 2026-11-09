# Context7 多 Key 顺序轮换 MCP 设计

> 日期：2026-07-30
> 状态：已批准，等待实施计划
> 范围：`D:\Code\dde` 的项目级 Codex Context7 MCP

## 背景

当前项目通过 `.codex/config.toml` 直接启动固定版本
`@upstash/context7-mcp@2.1.1`，并把单个 Windows 用户级
`CONTEXT7_API_KEY` 注入 stdio 进程。官方实现只在进程启动时从
`--api-key` 或 `CONTEXT7_API_KEY` 读取一个 Key；官方
`resolve-library-id`、`query-docs` 工具参数不接收 Key，因此不能通过 Codex
现有配置按调用热切换凭据。

用户合法控制四个仅供本程序使用的 Context7 Key。每个 Key 每自然月额度
1000 次并在同一时间重置。第一版只服务当前 DDE/Codex，不修改 VS Code MCP。

## 目标

1. Codex 继续使用原有两个 Context7 工具，无需选择账号或传递 Key。
2. 严格按 Key 1、2、3、4 顺序使用，每个周期最多发出 950 次 keyed 请求。
3. 父 MCP 在 Key 切换、child 崩溃和重启时保持 stdio 连接稳定。
4. 调用计数跨包装器崩溃、Codex 重启和多个 Codex 任务持久化。
5. `401/403/429/5xx/超时`具有确定、有界、可诊断的处理策略。
6. 四个 Key 均不可用时自动进入官方 Context7 匿名模式。
7. Key 不进入仓库、配置、状态、日志、测试快照或错误输出。

## 非目标

- 不规避 Context7 服务条款、权限或服务端限额。
- 不提高单 Key 的服务端额度。
- 不 Fork、修改或重新实现 Context7 API。
- 不为 VS Code、其他仓库、其他设备或远程用户提供服务。
- 不提供图形界面、远程管理端口或通过 MCP 修改计数的能力。

## 已批准决策

| 项目 | 决策 |
| --- | --- |
| Key 数量 | 4 个 |
| 凭据来源 | Windows 用户级 `CONTEXT7_API_KEY_1` 至 `_4` |
| 使用范围 | 四个 Key 仅供本包装器使用 |
| 轮换方式 | 顺序耗尽，健康故障可临时跳过 |
| 单 Key 软上限 | 每周期 950 次上游尝试 |
| 全池不可用 | 自动进入匿名 Context7 模式 |
| 默认周期 | UTC 自然月，可配置 IANA 时区 |
| Context7 | 固定 `@upstash/context7-mcp@2.1.1` |
| MCP SDK | 固定 `@modelcontextprotocol/sdk@1.25.1` |

## 总体架构

```text
Codex
  │ 长期 stdio MCP
  ▼
Context7 Key Pool MCP
  ├─ MCP 入口与官方工具透传
  ├─ FIFO 请求队列
  ├─ Key 选择与故障策略
  ├─ 跨进程状态存储
  └─ Context7 child 监管器
        │ 可替换 stdio MCP
        ▼
@upstash/context7-mcp@2.1.1
        │
        ▼
Context7 API
```

父包装器是 Codex 唯一连接的 MCP server。Key 切换只替换内部 child，不关闭
父进程 stdin/stdout。第一版把所有 Context7 上游调用放入 FIFO 队列，一次只
执行一个请求，避免 949→951、切换时仍有在途请求和并发恢复启动多个 child。
Context7 查询属于低并发读操作，第一版优先保证确定性和可恢复性。

## 组件边界

### `scripts/context7-key-pool-mcp.cjs`

- 进程入口、父 MCP transport 和 FIFO 队列。
- 透传官方工具并增加只读 `context7-pool-status`。
- 组合策略、状态存储、脱敏和 child 监管器。
- 捕获顶层异常，但不输出 Key、完整环境或未经清理的 child stderr。

### `scripts/context7-key-pool/policy.cjs`

纯策略模块。输入当前周期、池状态和标准化错误，输出选用槽位、冷却、耗尽、
认证失效、匿名回退或有界失败。它不读环境、不访问文件、不启动进程。

### `scripts/context7-key-pool/state-store.cjs`

- 校验状态 schema 和计算周期。
- 获取跨进程锁并原子预占调用次数。
- 原子写入主状态和备份。
- 回收已死亡进程留下的过期锁。
- 状态损坏时执行 fail-closed 恢复。

### `scripts/context7-key-pool/context7-child.cjs`

- 用参数数组和 `shell: false` 启动固定版本官方 Context7 MCP。
- 通过 MCP SDK initialize、tools/list 和 tools/call。
- keyed child 只看到当前 Key；匿名 child 看不到任何池 Key。
- 正常关闭、超时终止、回收 child，并标准化上游错误。

### `scripts/context7-key-pool/redaction.cjs`

- 递归删除所有 `CONTEXT7_API_KEY*` 字段值。
- 删除与任一运行时 Key 完整匹配的字符串片段。
- 日志最多输出槽位和 SHA-256 前 12 位。
- 统一清理 argv、env、stderr、异常和诊断对象。

### `scripts/configure-context7-key-pool.ps1`

- 通过隐藏输入写入四个 Windows 用户级环境变量。
- 拒绝空值和重复 Key，不把 Key 作为命令参数。
- 只显示槽位、长度和 SHA-256 前 12 位。
- 完成后提示重启 Codex/MCP host。

## MCP 生命周期

1. 父进程验证四个 Key 都存在且互不重复。
2. 读取状态，选择最低编号的可用槽位。
3. 启动对应 child，完成 initialize 和 tools/list。
4. 将官方工具 schema 原样暴露，并增加 `context7-pool-status`。
5. Context7 tools/call 进入 FIFO；本地状态工具不访问 Context7。
6. 请求先原子预占，再写入已初始化 child。
7. 需要换 Key 时，当前请求结束后关闭旧 child，再启动新 child。
8. 新 child 工具 schema 必须与固定版本预期一致，否则不设为 active。
9. child 非预期退出不传播为父进程退出。

父进程不修改官方工具输出，避免污染文档内容。轮换信息只通过状态工具和本地事件
日志提供。

## Key 身份与选择

父进程计算完整 SHA-256 作为 Key 的持久化身份，状态不保存原值，状态工具最多
显示前 12 位。计数随指纹而不是槽位继承：交换两个环境变量的位置不会清零已有
计数；只有此前未出现的新指纹从零开始。启动时拒绝重复指纹。

选择器按槽位 1 至 4 查找当前周期第一个满足以下条件的 Key：

1. `attemptedCalls < 950`；
2. 不是 `auth-invalid`；
3. 不是本周期 `quota-exhausted`；
4. 已超过 `cooldownUntil`。

达到 950 后标记 `soft-exhausted`。低编号槽位短期冷却时可临时使用下一健康
槽位；冷却结束后重新返回尚未达到 950 的最低编号槽位。所有 keyed 槽位不可用
时进入匿名模式。

## 计数语义

软上限按已经发往 Context7 的上游尝试计数，而不是只统计成功响应。一次请求在
child 已初始化、本地参数校验通过且即将写入 child transport 时，通过跨进程锁
原子预占并落盘。

预占后进程崩溃也不回滚，因为无法证明 Context7 没有收到请求。child 启动或
initialize 失败、本地 schema 校验失败不计数。每次真正重试都是新的上游请求，
必须再次预占。这一保守模型可以少用少量额度，但不能突破 950 次上限。

## 状态与并发

状态目录：

```text
%LOCALAPPDATA%\NanoFlow\context7-key-pool\
  state.json
  state.backup.json
  state.lock\
  events.jsonl
```

状态至少包含：schema 版本、周期、时区、指纹、槽位、`attemptedCalls`、
`successfulCalls`、健康状态、`cooldownUntil`、最近标准化故障、匿名模式原因和
更新时间。状态文件不含 Key。

每次更新执行：原子创建锁目录 → 校验 owner/PID/过期时间 → 读取并校验主状态或
备份 → 周期推进与预占 → 同目录临时文件写入并 flush → 有界重试替换主状态 →
更新备份 → 释放锁。

Windows 文件占用导致替换持续失败时拒绝 keyed 调用，不能在计数未持久化时继续。
主状态损坏但备份有效时从备份恢复；两者均损坏时归档故障文件，创建当前周期的
fail-closed 状态，将 keyed 槽位标记为本周期不可用并进入匿名模式。不得把损坏
状态当成首次运行而清零。

## 月份重置

默认使用 `UTC` 计算 `YYYY-MM`。可通过非敏感
`CONTEXT7_POOL_TIME_ZONE` 指定 IANA 时区。每次预占前重算周期：

- 新周期大于状态周期：调用计数归零并解除额度类禁用；
- 系统时间倒退：不重置；
- 同一指纹的 `auth-invalid` 跨周期保留；
- 已过期冷却自动解除。

## 故障策略

### 认证与权限

- 明确 `401/403`：当前指纹标记 `auth-invalid`，改用下一健康 Key 重试。
- 环境中的 Key 指纹改变：新指纹作为新凭据，不继承旧指纹认证失效状态。

### 限流

- `429` 且有可信 `Retry-After`：记录冷却时间并切换下一健康 Key。
- `429` 无恢复时间：标记当前周期 `quota-exhausted`。
- 四个槽位都冷却、耗尽或认证失效：进入匿名模式。

### 超时、连接错误与 5xx

官方工具是只读、幂等操作，采用最多三次上游尝试：

1. 当前 Key 初始请求；
2. 短暂抖动后用当前 Key 重试一次；
3. 仍失败则重启 child，并用下一健康 Key 最后重试一次。

三次仍失败时返回脱敏错误。每次写入 child 的尝试分别计数；不明确错误按超时
歧义处理，不回滚预占。

### 输入错误与匿名模式

MCP schema 校验失败、空查询等确定性输入错误直接返回，不跨 Key 重试。匿名
child 环境删除 `CONTEXT7_API_KEY`、`CONTEXT7_API_KEY_1` 至 `_4` 以及未来
匹配 `CONTEXT7_API_KEY_*` 的变量。匿名调用不写 keyed 计数；匿名模式持续失败
时明确报错，不无限重试。新周期自动重新选择 Key 1。

## 安全边界

`.codex/config.toml` 只列出环境变量名，不保存值：

```toml
env_vars = [
  "CONTEXT7_API_KEY_1",
  "CONTEXT7_API_KEY_2",
  "CONTEXT7_API_KEY_3",
  "CONTEXT7_API_KEY_4",
]
```

keyed child 只获得标准运行环境和单个 `CONTEXT7_API_KEY=<当前 Key>`，其余池
变量全部删除。不得记录完整 child env。事件日志只记录时间、事件、槽位、短指纹、
计数和标准错误类，不记录工具查询正文，并采用有界大小轮换。

以下情况拒绝 keyed 模式：Key 缺失、Key 重复、状态不能安全持久化、上游或 SDK
版本不匹配、工具 schema 漂移。状态损坏允许 fail-closed 匿名模式继续；凭据
配置错误则明确拒绝启动，不能静默以不足四个 Key 运行。

## Codex 接入

项目级 `.codex/config.toml` 保留 server 名称 `context7`，但改为启动：

```text
node D:/Code/dde/scripts/context7-key-pool-mcp.cjs
```

注入四个变量名并保留显式 startup/tool timeout。`.vscode/mcp.json` 不在第一版
写集。`package.json` 固定 `@modelcontextprotocol/sdk@1.25.1`，lockfile 固定完整
依赖树；child 固定 `@upstash/context7-mcp@2.1.1`，禁止 `latest`。

建议提供：

- `context7:pool:test`：focused tests；
- `context7:pool:status`：只读脱敏状态；
- `context7:pool:smoke`：fresh-process 冒烟验证。

配置或环境改变后必须完整重启 Codex/MCP host。磁盘配置正确不证明当前连接进程
已经加载新 Key 池。

## 状态工具

`context7-pool-status` 不调用 Context7，返回当前周期、时区、active 槽位或匿名
模式、每槽短指纹、尝试/成功计数、状态、冷却截止时间、最近标准化故障、下一次
重置时间和状态文件健康性。它不得返回 Key、完整指纹、查询正文、原始 child
stderr 或不必要的系统路径。

## 测试设计

实施采用测试先行，先观察失败再写最小实现。

### 策略测试

- Key 1 的第 1 至 950 次选择及随后依次切换。
- 任一槽位不产生第 951 次 keyed 预占。
- 冷却临时跳过和恢复低编号槽位。
- 认证失效、额度耗尽和全池匿名回退。
- 新周期重置额度状态但保留同指纹认证失效。
- 时间倒退不重置；换槽时计数随指纹移动；重复指纹被拒绝。

### 状态与并发测试

- 预占先落盘、后转发；主状态原子替换和备份恢复。
- 主备同时损坏时 fail closed。
- 写入失败时不允许 keyed 请求继续。
- 多进程并发预占后总数准确。
- 进程崩溃后的过期锁回收，活跃锁不能被抢占。
- Windows 文件替换短暂失败的有界重试。

### MCP 集成测试

使用不访问真实网络的 fake Context7 child 验证：官方工具和状态工具清单、schema
透传、child 切换时父 transport 保持、child 崩溃恢复、错误分类、严格重试上限、
匿名环境无 Key、日志和错误无测试 Key。

### 压力与安全测试

- 1000 次 fake 调用覆盖 950 边界、跨槽切换和父进程重启。
- 多个包装器共享状态，在预占后和响应前杀进程并恢复。
- 扩展现有 tooling-security 合同，确保配置只有变量名、包版本固定、配置脚本不
  从命令参数取 Key、`.vscode/mcp.json` 未被改写。
- secret audit 覆盖新增脚本、测试和文档。

### 真实验证边界

1. **配置边界**：Codex 能解析项目 MCP 配置，输出不含 Key。
2. **fresh-process 边界**：启动新包装器，只记录短指纹；调用
   `resolve-library-id` 和 `query-docs`，确认真实内容并确认计数增加两次。
3. **live-host 边界**：重启 Codex/MCP host 后，从当前连接调用两个官方工具和
   `context7-pool-status`，证明当前宿主不是旧单 Key 进程。

压力测试不得使用真实 Key。fake 或 fresh-process 成功不能替代 live-host 证据。

## 预计实施写集

- `.codex/config.toml`
- `package.json`、`package-lock.json`
- `scripts/context7-key-pool-mcp.cjs`
- `scripts/context7-key-pool/*.cjs`
- `scripts/configure-context7-key-pool.ps1`
- focused unit/integration/pressure tests
- `src/tests/contracts/tooling-security.contract.spec.ts`
- 一份中文运维说明和必要 package scripts

实施前必须重新检查工作树和文件租约。若目标文件被其他 Agent 占用，等待或缩小
写集，不能覆盖并发工作。

## 发布顺序

1. 加入失败的策略和状态测试。
2. 实现策略与状态存储，使 focused tests 变绿。
3. 加入 fake MCP child 测试和父包装器。
4. 完成故障、并发、崩溃和匿名模式测试。
5. 加入隐藏输入配置脚本、安全合同和 secret audit。
6. 在本机安全写入四个用户级变量，不输出 Key。
7. 修改项目 `.codex/config.toml`。
8. 运行 fresh-process 两工具验证。
9. 完整重启 Codex/MCP host。
10. 运行 live-host 两工具及状态验证。

## 验收标准

- Codex 继续使用原有两个 Context7 工具。
- 四个 Key 按批准顺序使用，单 Key keyed 尝试不超过 950。
- 多进程、崩溃和重启不能造成计数回退或第 951 次调用。
- child 切换与崩溃不关闭父 MCP transport。
- 认证、限流、上游失败、超时和输入错误均有确定、有界行为。
- 全部 keyed 槽位不可用后自动进入匿名模式，新周期恢复额度类状态。
- 状态损坏不把计数静默清零。
- Key 不出现在仓库、配置、状态、日志、测试或错误输出。
- focused、压力、安全合同和 secret audit 通过。
- fresh-process 与重启后的 live-host 验证分别完成并标注证据边界。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 上游未暴露精确 HTTP 状态 | 只分类可证明状态；其余按超时歧义并限制重试 |
| 超时请求已被服务端计费 | 预占不回滚，每次重试单独计数 |
| 多 Codex 进程竞争额度 | 跨进程锁和发送前原子预占 |
| 状态损坏导致额度重用 | 主备状态；双损坏时当期 fail closed 并匿名化 |
| child 退出关闭 Codex transport | 父 MCP 独立持有 stdio，child 退出不传播 |
| 上游升级改变 schema | 固定版本并在 child initialize 后校验 |
| Key 泄漏 | 最小 child 环境、统一脱敏、安全合同和 secret audit |
| live host 仍使用旧进程 | 区分磁盘、fresh process、live-host，并要求重启 |
