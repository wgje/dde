-- ============================================================
-- NanoFlow Supabase 完整初始化脚本（统一导入）
-- ============================================================
-- 版本: 7.56.0
-- 最后验证: 2026-07-26（同步 RPC 稳定重放摘要收敛）
--
-- 更新日志：
--   7.56.0 (2026-07-26): 同步 RPC 稳定重放摘要收敛：
--                        - 业务 payload 摘要排除易变客户端与部署 envelope
--                        - 新 operation 严格拒绝业务 payload 漂移
--                        - legacy operation 保持可重放并支持安全惰性升级
--   7.55.0 (2026-07-18): 任务 created_at keyset 约束收敛：
--                        - 两条项目任务全量读取统一使用 created_at + id 稳定游标
--                        - 有界回填 legacy NULL 后设置 created_at NOT NULL
--                        - 复用 project_id + created_at + id 索引且不新增写放大
--   7.54.0 (2026-07-18): 任务墓碑 keyset 分页收敛：
--                        - 两条全量读取统一使用 deleted_at + task_id 稳定游标
--                        - 一个三列索引覆盖分页、项目过滤与水位查询
--                        - 原子校验后删除 project-only 与旧时间索引
--   7.53.0 (2026-07-18): 项目元数据 keyset 索引收敛：
--                        - 对齐 owner_id + updated_at + id 稳定游标分页
--                        - 保留软删除行水位覆盖与 active owner/id partial 索引
--                        - 原子校验三列 B-tree 后删除旧两列索引
--   7.52.0 (2026-07-16): 日常任务 keyset 索引收敛：
--                        - 对齐 user_id + updated_at + id 稳定游标分页
--                        - 原子校验三列 B-tree 后删除旧两列索引
--                        - 2 秒锁等待与 30 秒执行上限保证失败可重试
--   7.51.0 (2026-07-16): Widget 运行态保留收敛：
--                        - 通知幂等事件与陈旧限流桶统一保留 30 天
--                        - 每张表每次最多删除 5000 行并使用 SKIP LOCKED
--                        - owner-only pg_cron 每日执行且未安装扩展时安全跳过
--   7.50.0 (2026-07-16): Focus Session Required-Insert 收敛：
--                        - 删除 session_state 的 legacy 空对象默认值
--                        - 调用方遗漏完整快照时由数据库直接拒绝写入
--                        - 前向迁移使用 2 秒锁等待上限且不改写现有数据
--   7.49.0 (2026-07-16): 黑匣子状态列 NOT NULL 收敛：
--                        - 回填四个带默认值的 legacy NULL 状态字段
--                        - 超过 10000 行时中止并要求审阅式分批修复
--                        - 使用 NOT VALID/VALIDATE 降低最终 SET NOT NULL 扫描风险
--   7.48.0 (2026-07-16): 诊断视图权限降级收敛：
--                        - 清除 CREATE OR REPLACE VIEW 保留的历史 ACL
--                        - PUBLIC/anon/authenticated 全量撤权后仅恢复 authenticated SELECT
--                        - 前向迁移使用 2 秒锁等待上限，避免权限收敛长期阻塞
--   7.47.0 (2026-07-16): 安全诊断视图收敛：
--                        - fresh-init 补齐 project_structure_audit 与 stage_null_recovery_diagnostics
--                        - 两个只读视图统一使用 security_invoker 并服从底层 RLS
--                        - PUBLIC/anon 无权访问，authenticated 仅保留 SELECT
--   7.46.0 (2026-07-16): 重复索引最终收敛：
--                        - 迁移回放与 fresh-init 删除四条有等价替代的旧索引
--                        - 删除前验证 B-tree、键列、partial 谓词与 tombstone 主键
--                        - schema coverage 持续阻止完全相同的活动索引定义
--   7.45.0 (2026-07-16): scheduled maintenance owner-only 收敛：
--                        - 七个 pg_cron-only 函数撤销 service_role 直执行权
--                        - 所有命名任务继续以迁移角色 postgres 执行
--                        - 私有部署文档同步正式任务名与 UTC 时间表
--   7.44.0 (2026-07-16): 核心 retention pg_cron 升级收敛：
--                        - 活动迁移补齐任务、连接和日志三条清理任务
--                        - 升级库与 fresh-init 使用相同 UTC 时间表
--                        - 未安装 pg_cron 或目标函数缺失时安全跳过
--   7.43.0 (2026-07-16): DR maintenance pg_cron 收敛：
--                        - fresh-init 补齐 quarantine GC 与 task-change audit archive 任务
--                        - 命名任务先清理旧定义再以当前迁移角色重建
--                        - 未安装 pg_cron 或目标函数缺失时安全跳过
--   7.42.0 (2026-07-16): 内部 sync/trigger helper owner-only 收敛：
--                        - 旧项目删除、quarantine 与两个 trigger helper 撤销 service_role 直执行权
--                        - authenticated 继续通过 sync RPC，触发器绑定保持不变
--                        - 灾备 set_data_safety_flag 控制面与 cron 权限保持不变
--   7.41.0 (2026-07-16): 旧管理与 tombstone RPC owner-only 收敛：
--                        - 六个无运行时调用方的旧 RPC 撤销全部 Data API 角色执行权
--                        - 附件清理、任务删除与 tombstone 查询保留 durable 有界替代路径
--                        - 删除全部直接客户端 Supabase 类型入口
--   7.40.0 (2026-07-16): 旧 mutation helper owner-only 收敛：
--                        - 七个 legacy helper 撤销 service_role 直接执行权
--                        - 仅由 SECURITY DEFINER 同步/清理函数内部调用
--                        - 删除全部直接客户端 Supabase 类型入口
--   7.39.0 (2026-07-16): 退役 Dashboard 统计 RPC：
--                        - get_dashboard_stats 撤销全部 API 角色执行权
--                        - 本地项目状态继续提供 Dashboard 统计
--                        - 删除本地手写 Supabase 类型入口
--   7.38.0 (2026-07-16): 退役用户项目元数据聚合 RPC：
--                        - get_user_projects_meta 撤销全部 API 角色执行权
--                        - 删除本地手写 Supabase 类型入口
--                        - 全量与增量项目读取统一使用 keyset 路径
--   7.37.0 (2026-07-16): 项目头 keyset 有界分页：
--                        - 单页最多返回 100 个项目头
--                        - 使用固定上界与 (updated_at, project_id) 游标
--                        - 退役旧 list_project_heads_since 无界 API 权限
--   7.36.0 (2026-07-16): 退役 offset 项目列表 RPC：
--                        - get_projects_list 撤销全部 API 角色执行权
--                        - 项目全集与增量拉取均使用确定性 keyset 分页
--                        - 保留 owner-only 定义用于可逆诊断
--   7.35.0 (2026-07-16): 退役完整项目 JSON 聚合 RPC：
--                        - get_full_project_data 撤销全部 API 角色执行权
--                        - 客户端删除批量 RPC feature flag 与 504 熔断死路径
--                        - 完整项目统一使用任务分页、连接 keyset 与 tombstone 分页
--   7.34.0 (2026-07-16): 退役无界项目全集 RPC：
--                        - get_all_projects_data 撤销全部 API 角色执行权
--                        - 项目列表继续使用 keyset 分页表查询
--                        - 增量项目探针继续使用 list_project_heads_since
--   7.33.0 (2026-07-16): authenticated RPC 输入边界：
--                        - tombstone 项目与任务删除每次最多接收 100 个 ID
--                        - 超限或非法 JSON 数组以 SQLSTATE 22023 明确拒绝
--                        - 客户端按确定性 operation-id 分块，保留重试与 CAS 语义
--   7.32.0 (2026-07-16): 软删除实体 tombstone-first 有界清理：
--                        - 任务与连接每次最多物理清理 5000 行
--                        - 先刷新 task/connection tombstone，再执行物理删除
--                        - 使用稳定 deleted_at/id 顺序与 SKIP LOCKED
--   7.31.0 (2026-07-16): 日志与扫描记录有界清理：
--                        - cleanup_logs 每次最多删除 5000 条旧日志
--                        - 扫描、威胁和隔离记录各自最多处理 5000 行
--                        - 所有阶段使用稳定顺序与 FOR UPDATE SKIP LOCKED
--   7.30.0 (2026-07-16): 灾备维护任务有界批处理：
--                        - 隔离队列清理与任务审计归档每次最多处理 5000 行
--                        - 使用稳定游标索引与 FOR UPDATE SKIP LOCKED
--                        - 归档保留周期拒绝 NULL、零值和负值
--   7.29.0 (2026-07-16): pg_cron 日志有界清理：
--                        - 每次最多删除 5000 条过期 job_run_details
--                        - 使用 FOR UPDATE SKIP LOCKED 缩小并发锁范围
--                        - fresh-init 不再无条件清空全部 cron 执行历史
--   7.28.0 (2026-07-16): 同步支撑表 FORCE RLS：
--                        - sync_operation_log 保持 owner-scoped 审计读取策略
--                        - sync_protocol_state 保持 authenticated 探针读取策略
--                        - 表拥有者不再因缺少 FORCE RLS 绕过既有策略
--   7.27.0 (2026-07-16): Sequence 权限默认拒绝：
--                        - 未来 public sequence 不再自动授权 API 角色
--                        - 现有 identity sequence 撤销 anon/authenticated
--                        - 内部表所需访问仅恢复给 service_role
--   7.26.0 (2026-07-16): 外键索引覆盖收敛：
--                        - routine 完成表按 routine_id 覆盖级联删除
--                        - tombstone deleted_by 使用非空部分索引
--                        - schema coverage 持久检查所有外键索引前缀
--   7.25.0 (2026-07-16): Widget 通知有界扇出：
--                        - 数据库 RPC 联结筛选有效设备与当前实例绑定
--                        - 最近活跃设备最多返回 100 台
--                        - Edge Function 以 8 个 worker 限制 FCM 并发
--   7.24.0 (2026-07-16): 函数执行权限最终收敛：
--                        - 历史 helper 与 trigger 函数先撤销所有 API 角色执行权
--                        - 客户端 helper 仅恢复 authenticated / service_role
--                        - 内部 trigger/helper 仅恢复 service_role
--   7.23.0 (2026-07-16): 个人灾备一致性快照：
--                        - 五张用户表通过单次 SECURITY INVOKER RPC 同快照读取
--                        - 显式 auth.uid() 过滤、空 search_path 与 authenticated 最小授权
--                        - 旧远端由客户端回退到 immutable id keyset 分页
--   7.22.0 (2026-07-16): 项目列表 keyset 与活跃索引：
--                        - 全量项目列表按 immutable id keyset 拉取，消除 offset 页边界漂移
--                        - 增量项目列表改用 (updated_at, id) keyset
--                        - 使用 (owner_id, id) 部分索引覆盖活跃项目扫描
--   7.21.0 (2026-07-16): Legacy connection tombstone 查询收敛：
--                        - endpointless fallback 仅查询 deleted_at
--                        - 使用双 NULL 谓词部分索引隔离极少量 legacy 行
--                        - 避免连接推送预检扫描项目内全部现代 tombstone
--   7.20.0 (2026-07-16): 项目任务默认加载索引收敛：
--                        - 使用 (project_id, created_at, id) 匹配稳定加载顺序
--                        - 删除不匹配当前读取路径的宽覆盖部分索引
--                        - 远端先并发建索引，再验证结构并短锁删除旧索引
--   7.19.0 (2026-07-16): 个人数据保留清理收敛：
--                        - 三个缺失的全局时间索引覆盖过期行定位
--                        - 每张表最多删除 10000 行，避免单次 cron 无界事务
--                        - 使用 FOR UPDATE SKIP LOCKED + ctid Tid Scan 缩小并发锁范围
--   7.18.0 (2026-07-16): 附件重扫队列 claim 收敛：
--                        - 等价改写 status/stale 谓词，避免重复 BitmapOr 扫描
--                        - 使用 (next_rescan_at, id) 部分索引覆盖稳定 claim 顺序
--                        - 保留 FOR UPDATE SKIP LOCKED 并发领取语义
--   7.17.0 (2026-07-16): 附件重扫反查索引：
--                        - virus-scan 使用 attachments @> scanMetadata.fileId 定位 Storage 对象
--                        - jsonb_path_ops GIN 精确覆盖嵌套 JSONB containment 查询
--                        - 远端迁移并发建索引，避免阻塞 tasks 常规读写
--   7.16.0 (2026-07-15): 附件任务扫描收敛：
--                        - Edge Function 在分页前排除 SQL NULL 与空 JSON 数组
--                        - 使用非空附件任务 (id) 部分索引覆盖稳定 keyset
--                        - 不在 keyset B-tree 中 INCLUDE attachments JSONB，控制索引体积和写放大
--   7.15.0 (2026-07-15): cleanup_logs 查询与权限收敛：
--                        - 附件清理游标使用 created_at DESC 部分索引
--                        - 删除覆盖所有日志类型的旧 type 单列索引
--                        - service_role 仅保留 SELECT / INSERT / DELETE
--   7.14.0 (2026-07-15): 附件内部表最小权限收敛：
--                        - attachment_scans / quarantined_files / cleanup jobs 撤销历史 ALL
--                        - service_role 仅保留 SELECT / INSERT / UPDATE / DELETE
--                        - fresh-init 末尾重申 RLS 与最小权限最终态
--   7.13.0 (2026-07-15): External Source Links 完整收敛：
--                        - fresh-init 补齐表、约束、RLS、权限和 stale-write 触发器
--                        - 远端全量拉取改用不可变 id keyset，消除 offset 并发漏行
--                        - 使用 (user_id, id) 替代 mutable updated_at 排序索引
--   7.12.0 (2026-07-15): Black Box 增量同步索引收敛：
--                        - 使用 (user_id, updated_at, id) 覆盖稳定 keyset 顺序
--                        - 同时支持用户级 MAX(updated_at) watermark 查询
--                        - 删除全局 updated_at 与旧两列复合索引
--   7.11.0 (2026-07-15): Widget 活跃查找索引收敛：
--                        - 设备与实例查询只索引未撤销/未卸载行
--                        - 移除频繁更新的 updated_at 索引键，降低心跳写放大
--                        - 实例通知查询由 INCLUDE(device_id, binding_generation) 覆盖
--   7.10.0 (2026-07-15): 项目增量 keyset 覆盖索引：
--                        - tasks / connections 使用 (project_id, updated_at, id)
--                        - 精确覆盖增量查询的 equality + stable cursor 排序
--                        - 远端通过并发建索引和验证后并发删除旧两列索引
--   7.9.0 (2026-07-15): 新函数默认拒绝执行：
--                       - public schema 后续函数不再自动暴露给 Supabase API 角色
--                       - 每个新 RPC 必须显式 GRANT EXECUTE 给预期角色
--   7.8.0 (2026-07-15): 核心同步表最小权限收敛：
--                       - tasks / connections 从 ALL 收敛为 authenticated CRUD
--                       - tombstones 仅允许 authenticated SELECT / INSERT
--                       - active_tasks / active_connections 只保留 authenticated SELECT
--   7.7.0 (2026-07-15): owner-scoped RLS 最终态收敛：
--                       - 最终策略统一限定 authenticated，并显式校验 UPDATE 新行
--                       - 用户表权限从 ALL 收敛为普通 CRUD
--                       - purge_rate_limits 仅保留 service_role 直接访问
--                       - 在脚本末尾重申最终态，避免历史片段覆盖前向修复
--   7.6.0 (2026-07-15): 项目图 RLS 性能收敛：
--                       - tasks / connections / tombstones 统一使用 active project 集合
--                       - 仅 auth.uid() 使用 initPlan，避免逐行调用 project helper
--   7.5.0 (2026-07-15): project_members 兼容表收敛：
--                       - 按行关联 project_id，仅缓存不随行变化的 auth.uid()
--                       - 策略限定 authenticated，UPDATE 显式校验新行
--                       - 删除被唯一/复合索引覆盖的 project_id、user_id 单列索引
--   7.4.0 (2026-07-15): user_preferences 索引去重：
--                       - 保留 UNIQUE(user_id) 自动创建的唯一 B-tree 索引
--                       - 删除重复的 idx_user_preferences_user_id，减少写入放大
--   7.3.0 (2026-07-15): 用户偏好与附件 RLS 性能/权限收敛：
--                       - user_preferences 与 storage.objects 使用 auth.uid() initPlan
--                       - user_preferences 从宽泛默认权限收敛为 authenticated CRUD
--                       - 删除重复的 Project members can view attachments permissive policy
--   7.2.0 (2026-07-15): Black Box 数据库边界加固：
--                       - RLS 中的 current_user_id() 使用 SELECT initPlan，避免逐行重复计算
--                       - 恢复 black_box_entries.project_id 外键索引，约束物理删除/恢复时的级联扫描与锁范围
--   7.1.0 (2026-03-23): 免费层深度优化：
--                       - 删除 10 个确认未使用/冗余索引（节省 ~208 KB + 写入放大）
--                       - 删除索引清单：idx_task_tombstones_deleted_by, idx_connection_tombstones_deleted_by,
--                         idx_black_box_entries_project_id, idx_routine_completions_routine_id,
--                         idx_tasks_project_load, idx_connections_deleted_at, idx_projects_owner_id,
--                         idx_tasks_project_id, idx_tasks_project_active, idx_connections_project_active
--                       - 应用层配合优化：轮询间隔 5min→10min, 活跃轮询 60s→120s,
--                         Tombstone TTL 5min→30min, focus_sessions 脏检查
--   7.0.0 (2026-03-22): 移除云端备份基础设施：
--                       - 删除 backup_metadata / backup_restore_history / backup_encryption_keys 表
--                       - 删除备份相关 RLS 策略、索引、GRANT
--                       - 删除备份辅助函数（get_latest_completed_backup / mark_expired_backups / cleanup_expired_backups）
--                       - 删除 invoke_internal_edge_function / apply_backup_schedules / update_backup_schedule
--                       - 删除 backup.* app_config 配置项
--                       - 删除备份相关 cron 任务
--                       - 保留本地备份相关字段（local_backup_enabled / local_backup_interval_ms）
--   6.3.0 (2026-03-20): 个人版后端收口：
--                       - project_members / attachment_scans / quarantined_files 最终移除
--                       - user_preferences.dock_snapshot 最终移除
--                       - owner-only project access 函数与 projects 策略重写
--                       - cron 日志清理、个人数据保留清理
--   6.2.0 (2026-03-18): MCP Supabase Advisor 最终优化 + 架构修正：
--                       【根本发现】应用 100% 使用软删除（UPDATE deleted_at），而不是物理 DELETE
--                              → FK 索引对应的级联删除约束检查永未执行
--                              → 所有"FK enforcement"索引实际使用次数为 0
--                       - 【删除】不必要的 FK 索引（0 查询验证）：
--                         * idx_project_members_invited_by
--                         * idx_task_tombstones_deleted_by
--                         * idx_connection_tombstones_deleted_by
--                         * idx_quarantined_files_quarantined_by
--                         * idx_black_box_entries_project_id
--                         * idx_routine_completions_routine_id
--                         + 其他未使用索引
--                       - 【文档】添加架构说明：软删除策略与 FK 索引必要性关系
--                       - 预期性能提升：写入 +2-8%（减少 FK 检查开销）
--   6.0.0 (2026-03-15): 全量数据库优化：
--                       - 清理 13 个确认冗余的未使用索引
--                       - connections UNIQUE 约束改为部分唯一索引（仅活跃行）
--                       - 5 核心表 autovacuum 阈值调优
--                       - cleanup 函数部分索引补充（deleted_at）
--                       - authenticated 角色 statement_timeout = 30s
--                       - transcription_usage SELECT 策略统一命名
--   5.0.0 (2026-03-15): 全量安全加固 + Focus Console 汇总：
--                       - FORCE RLS 覆盖全部用户表
--                       - anon 角色零写入（仅 app_config SELECT）
--                       - 管理/维护 RPC 函数仅限 service_role
--                       - batch_upsert_tasks 升级支持 parking_meta/expected_minutes/cognitive_load/wait_minutes
--                       - 数据安全约束：TEXT 长度、数值范围、JSONB 大小限制
--                       - RLS 策略拆分为独立 CRUD（routine_tasks/routine_completions）
--                       - 补充缺失策略（transcription_usage INSERT/UPDATE/DELETE, circuit_breaker_logs INSERT）
--   4.0.0 (2026-03-15): 全量对齐迁移：
--                       - tasks 表新增 parking_meta, expected_minutes, cognitive_load, wait_minutes 列及约束
--                       - user_preferences 表新增 dock_snapshot 列
--                       - black_box_entries 表新增 focus_meta 列、来源约束、共享仓索引、FORCE RLS
--                       - 新增 focus_sessions / routine_tasks / routine_completions 表（UUID PK）
--                       - 所有新表配置 RLS（(SELECT auth.uid()) 缓存优化）、FORCE RLS、触发器、索引、GRANT
--   3.9.0 (2026-02-15): 集成 Resume 水位 RPC（get_project_sync_watermark / get_user_projects_watermark /
--                       list_project_heads_since / get_accessible_project_probe / get_black_box_sync_watermark /
--                       get_resume_recovery_probe）及配套索引
--   3.8.0 (2026-02-10): pg_cron 段与 cleanup-cron-setup.sql 对齐（函数存在性校验 + namespace 校验）
--   3.7.0 (2026-02-09): 一次性初始化增强：自动尝试配置 pg_cron 清理任务（幂等 + 容错）
--                       同步清理脚本说明，避免“已自动配置/仍提示手动配置”冲突
--   3.6.0 (2026-02-02): 性能优化：添加 get_all_projects_data 和 get_projects_list RPC 函数
--                       支持增量同步和分页查询，减少 N+1 查询问题
--   3.5.0 (2026-01-27): 性能优化：添加 get_full_project_data 和 get_user_projects_meta
--                       批量加载 RPC 函数，合并 4+ 请求为 1 个，首屏加载提升 70%
--   3.4.0 (2026-01-26): 深度数据库优化：删除未使用索引、添加 RLS 辅助函数、
--                       优化 RLS 策略使用 STABLE 函数缓存、添加部分复合索引
--   3.3.0 (2026-01-25): 添加专注模式支持：black_box_entries 表和 transcription_usage 表
--   3.2.0 (2026-01-09): 修复 batch_upsert_tasks 函数：移除不存在的 owner_id 列引用，
--                       使用 project.owner_id + project_members 进行权限校验；
--                       添加 SET search_path；修复 rank/x/y 类型为 numeric
--   3.1.0 (2026-01-07): 修复 get_dashboard_stats 使用 JOIN 查询；添加 active_connections 视图；
--                       添加 connections/user_preferences updated_at 索引；添加 Storage UPDATE 策略
--   3.0.0 (2026-01-04): 初始整合版本
--
-- 目标：新项目可在 Supabase SQL Editor 一次性执行本脚本完成全部数据库对象创建。
-- 说明：此文件由以下来源整合生成：
--   - scripts/init-database.sql（基础表 / RLS / Storage / Realtime）
--   - supabase/migrations/archive/*.sql（历史增量加固、tombstone、purge、病毒扫描、仪表盘 RPC 等）
--
-- 推荐用法：
--   1) 在 Storage 创建 attachments 私有桶
--   2) 在 SQL Editor 执行本脚本（脚本会自动尝试配置 pg_cron 清理任务）
--   3) 若实例暂不支持 pg_cron，可后续执行 scripts/cleanup-cron-setup.sql 重试
-- ============================================================

-- ============================================================
-- [BASE] scripts/init-database.sql
-- ============================================================
-- ============================================================
-- NanoFlow 数据库初始化脚本 (一次性导入)
-- ============================================================
--
-- 用法：在 Supabase SQL Editor 中执行此脚本完成所有数据库配置
--
-- 包含：
--   1. 核心表结构 (projects, tasks, connections, user_preferences)
--   2. RLS 安全策略
--   3. 自动更新时间戳触发器
--   4. 附件 RPC 函数
--   5. 定时清理函数
--   6. 实时订阅配置
--   7. Storage 策略
--
-- 版本: 2.1.0
-- 最后更新: 2025-01-01
-- ============================================================

-- ============================================
-- 13.1 软删除清理定时任务（pg_cron，可选）
-- ============================================
-- 自动更新 updated_at 时间戳
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.update_updated_at_column()
  SET search_path = pg_catalog, public;

-- ============================================
-- 0.1 RLS 优化辅助函数
-- 使用 STABLE 标记启用 PostgreSQL 函数缓存
-- ============================================

-- 获取当前用户 ID（带缓存优化）
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS UUID
LANGUAGE SQL
STABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT auth.uid()
$$;

-- 检查用户是否为项目所有者
CREATE OR REPLACE FUNCTION public.user_is_project_owner(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id
    AND p.owner_id = public.current_user_id()
  )
$$;

-- 检查用户是否为项目所有者（个人版 owner-only）
CREATE OR REPLACE FUNCTION public.user_has_project_access(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id
    AND p.owner_id = public.current_user_id()
  )
$$;

-- 获取用户可访问的所有项目 ID（个人版 owner-only）
CREATE OR REPLACE FUNCTION public.user_accessible_project_ids()
RETURNS SETOF UUID
LANGUAGE SQL
STABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT id FROM public.projects WHERE owner_id = public.current_user_id()
$$;

-- ============================================
-- 1. 项目表 (projects)
-- ============================================

CREATE TABLE IF NOT EXISTS public.projects (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  created_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  deleted_at TIMESTAMP WITH TIME ZONE,
  version INTEGER DEFAULT 1,
  data JSONB DEFAULT '{}'::jsonb,
  migrated_to_v2 BOOLEAN DEFAULT FALSE
);

-- 添加新列（兼容已有表）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'version') THEN
    ALTER TABLE public.projects ADD COLUMN version INTEGER DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'migrated_to_v2') THEN
    ALTER TABLE public.projects ADD COLUMN migrated_to_v2 BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'data') THEN
    ALTER TABLE public.projects ADD COLUMN data JSONB DEFAULT '{}'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'deleted_at') THEN
    ALTER TABLE public.projects ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE;
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_projects_updated_at ON public.projects;
CREATE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
-- 完整复合索引用于 owner 范围、软删除水位与 updated_at/id 增量同步。
CREATE INDEX IF NOT EXISTS idx_projects_owner_updated_id
  ON public.projects (owner_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_projects_owner_id_active
  ON public.projects (owner_id, id)
  WHERE deleted_at IS NULL;
-- 注：以下索引已删除（未使用或被复合索引替代）：
-- - idx_projects_owner_id: 被 idx_projects_owner_updated_id 完全覆盖
-- - idx_projects_updated_at: 被复合索引替代

-- ============================================
-- 2. 项目成员表 (project_members)
-- ============================================

CREATE TABLE IF NOT EXISTS public.project_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'admin')),
  invited_by UUID REFERENCES auth.users(id),
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  accepted_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(project_id, user_id)
);

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
-- UNIQUE(project_id, user_id) 覆盖 project_id；后续 user-first 复合索引覆盖 user_id。
-- 【添加】invited_by FK 约束索引（2026-03-18 v6.3.0: Advisor 全量解决）
CREATE INDEX IF NOT EXISTS idx_project_members_invited_by ON public.project_members(invited_by);
COMMENT ON INDEX idx_project_members_invited_by IS
  'FK enforcement: invited_by references auth.users(id). ON DELETE SET NULL.';


-- ============================================
-- 3. 任务表 (tasks)
-- ============================================

CREATE TABLE IF NOT EXISTS public.tasks (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES public.tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT DEFAULT '',
  stage INTEGER,
  "order" INTEGER DEFAULT 0,
  rank NUMERIC DEFAULT 10000,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  x NUMERIC DEFAULT 0,
  y NUMERIC DEFAULT 0,
  short_id VARCHAR(20),
  priority VARCHAR(20) CHECK (priority IS NULL OR priority IN ('low', 'medium', 'high', 'urgent')),
  due_date TIMESTAMP WITH TIME ZONE,
  tags JSONB DEFAULT '[]'::jsonb,
  attachments JSONB DEFAULT '[]'::jsonb,
  -- 【2026-02-22 新增】State Overlap 停泊元数据
  parking_meta JSONB DEFAULT NULL,
  -- 【2026-02-26 新增】Dock/Focus 规划属性
  expected_minutes INTEGER DEFAULT NULL,
  cognitive_load TEXT DEFAULT NULL,
  wait_minutes INTEGER DEFAULT NULL,
  deleted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- 约束
  CONSTRAINT tasks_cognitive_load_check CHECK (cognitive_load IS NULL OR cognitive_load IN ('high', 'low')),
  CONSTRAINT tasks_expected_minutes_check CHECK (expected_minutes IS NULL OR expected_minutes > 0),
  CONSTRAINT tasks_wait_minutes_check CHECK (wait_minutes IS NULL OR wait_minutes > 0),
  CONSTRAINT tasks_wait_within_expected_check CHECK (expected_minutes IS NULL OR wait_minutes IS NULL OR wait_minutes <= expected_minutes)
);

DROP TRIGGER IF EXISTS update_tasks_updated_at ON public.tasks;
CREATE TRIGGER update_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON public.tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_nonempty_attachments_id
  ON public.tasks (id)
  WHERE attachments IS NOT NULL
    AND attachments <> '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_tasks_attachments_containment_gin
  ON public.tasks USING GIN (attachments jsonb_path_ops);
-- 停泊任务跨项目查询索引
CREATE INDEX IF NOT EXISTS idx_tasks_parking_meta
  ON public.tasks ((parking_meta IS NOT NULL))
  WHERE parking_meta IS NOT NULL;
COMMENT ON COLUMN public.tasks.parking_meta IS
  'State Overlap 停泊元数据（JSONB）。结构：{ state, parkedAt, lastVisitedAt, contextSnapshot, reminder, pinned }。NULL 表示非停泊任务。';
-- 注：以下索引已删除（未使用或被复合索引替代）：
-- - idx_tasks_project_id: 被 idx_tasks_project_updated + project_order 替代
-- - idx_tasks_project_active: 被 idx_tasks_project_updated 替代（仅 3 次使用）
-- - idx_tasks_project_load: 80KB 覆盖索引，仅 1 次使用
-- - idx_tasks_stage: 早期删除
-- - idx_tasks_deleted_at: 软删除查询较少
-- - idx_tasks_updated_at: 被复合索引替代
-- - idx_tasks_short_id: 几乎无使用

-- ============================================
-- 4. 连接表 (connections)
-- ============================================

CREATE TABLE IF NOT EXISTS public.connections (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  deleted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 部分唯一索引：仅活跃连接约束（减少维护成本）
CREATE UNIQUE INDEX IF NOT EXISTS uq_connections_project_source_target_active
  ON public.connections (project_id, source_id, target_id)
  WHERE deleted_at IS NULL;

-- 兼容旧表
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'connections' AND column_name = 'title') THEN
    ALTER TABLE public.connections ADD COLUMN title TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'connections' AND column_name = 'deleted_at') THEN
    ALTER TABLE public.connections ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE;
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_connections_updated_at ON public.connections;
CREATE TRIGGER update_connections_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_connections_target_id ON public.connections(target_id);
-- 增量同步索引
CREATE INDEX IF NOT EXISTS idx_connections_project_updated_id
  ON public.connections(project_id, updated_at, id);
-- 注：以下索引已删除（未使用或被复合索引替代）：
-- - idx_connections_project_active: 被 idx_connections_project_updated 替代（仅 4 次使用）
-- - idx_connections_deleted_at: 被 idx_connections_project_updated 替代
-- - idx_connections_source_id: source_id 查询走 project_id 复合索引
-- - idx_connections_deleted_at_cleanup: 清理操作较少
-- - idx_connections_updated_at: 被 idx_connections_project_updated 替代

-- cleanup 函数所需的任务部分索引（连接替代索引在历史兼容段定义）
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_cleanup
  ON public.tasks (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ============================================
-- 5. 用户偏好设置表 (user_preferences)
-- ============================================

CREATE TABLE IF NOT EXISTS public.user_preferences (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  theme VARCHAR(20) DEFAULT 'default',
  layout_direction VARCHAR(10) DEFAULT 'ltr',
  floating_window_pref VARCHAR(20) DEFAULT 'auto',
  -- 【2026-02-17 新增】跨设备同步字段
  color_mode VARCHAR(10) DEFAULT 'system' CHECK (color_mode IS NULL OR color_mode IN ('light', 'dark', 'system')),
  auto_resolve_conflicts BOOLEAN DEFAULT true,
  local_backup_enabled BOOLEAN DEFAULT false,
  local_backup_interval_ms INTEGER DEFAULT 3600000,
  last_backup_proof_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  focus_preferences JSONB DEFAULT '{"gateEnabled":true,"strataEnabled":true,"blackBoxEnabled":true,"maxSnoozePerDay":3}'::jsonb,
  -- 【2026-02-25 新增】停泊坞快照（跨设备同步）
  dock_snapshot JSONB DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE OR REPLACE FUNCTION public.user_preferences_keep_latest_backup_proof()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.last_backup_proof_at IS NOT NULL
     AND (
       NEW.last_backup_proof_at IS NULL
       OR NEW.last_backup_proof_at < OLD.last_backup_proof_at
     ) THEN
    NEW.last_backup_proof_at := OLD.last_backup_proof_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_preferences_updated_at ON public.user_preferences;
CREATE TRIGGER update_user_preferences_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS keep_latest_backup_proof_on_user_preferences ON public.user_preferences;
CREATE TRIGGER keep_latest_backup_proof_on_user_preferences
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION public.user_preferences_keep_latest_backup_proof();

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
-- 注：idx_user_preferences_user_id 已删除（user_id 已有 UNIQUE 约束）
-- 注：idx_user_preferences_updated_at 已删除（未使用）

-- ============================================
-- 5.1 黑匣子条目表 (black_box_entries) - 专注模式
-- ============================================

CREATE TABLE IF NOT EXISTS public.black_box_entries (
  -- 主键：由客户端 crypto.randomUUID() 生成
  id UUID PRIMARY KEY,

  -- 外键关联
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 内容
  content TEXT NOT NULL,

  -- 【2026-03-04 新增】专注控制台就地创建元数据
  focus_meta JSONB DEFAULT NULL,

  -- 时间字段
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ DEFAULT NULL,

  -- 状态字段
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  is_completed BOOLEAN NOT NULL DEFAULT FALSE,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,

  -- 跳过/稍后提醒
  snooze_until DATE DEFAULT NULL,
  snooze_count INTEGER NOT NULL DEFAULT 0,

  -- 软删除
  deleted_at TIMESTAMPTZ DEFAULT NULL
);

-- 旧 schema 幂等升级：仅从项目所有者确定性回填，不为共享条目臆造 user_id。
UPDATE public.black_box_entries entries
SET user_id = projects.owner_id
FROM public.projects projects
WHERE entries.project_id = projects.id
  AND entries.user_id IS NULL;

DO $black_box_owner$
DECLARE
  unresolved_count BIGINT;
BEGIN
  SELECT count(*)
  INTO unresolved_count
  FROM public.black_box_entries
  WHERE user_id IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION
      'black_box_entries contains unresolved NULL user_id rows: %',
      unresolved_count;
  END IF;
END
$black_box_owner$;

DO $black_box_project_owner$
DECLARE
  mismatch_count BIGINT;
BEGIN
  SELECT count(*)
  INTO mismatch_count
  FROM public.black_box_entries entries
  JOIN public.projects projects ON projects.id = entries.project_id
  WHERE entries.project_id IS NOT NULL
    AND entries.user_id IS DISTINCT FROM projects.owner_id;

  IF mismatch_count > 0 THEN
    RAISE EXCEPTION
      'black_box_entries contains project/user owner mismatches: %',
      mismatch_count;
  END IF;
END
$black_box_project_owner$;

ALTER TABLE public.black_box_entries
  ALTER COLUMN user_id SET NOT NULL;

-- 添加表注释
COMMENT ON TABLE public.black_box_entries IS '黑匣子条目表 - 语音转写记录，用于紧急捕捉想法';
COMMENT ON COLUMN public.black_box_entries.id IS '由客户端 crypto.randomUUID() 生成';
COMMENT ON COLUMN public.black_box_entries.content IS '语音转写后的文本内容';
COMMENT ON COLUMN public.black_box_entries.date IS 'YYYY-MM-DD 格式，用于按日分组';
COMMENT ON COLUMN public.black_box_entries.completed_at IS '完成状态首次落地时间，用于地质层按完成日稳定分组';
COMMENT ON COLUMN public.black_box_entries.is_read IS '是否已读；已读但未完成条目仍会在大门中出现';
COMMENT ON COLUMN public.black_box_entries.is_completed IS '是否已完成，计入地质层';
COMMENT ON COLUMN public.black_box_entries.is_archived IS '是否已归档，不显示在主列表';
COMMENT ON COLUMN public.black_box_entries.snooze_until IS '跳过至该日期，在此之前不会在大门中出现';
COMMENT ON COLUMN public.black_box_entries.snooze_count IS '已跳过次数';
COMMENT ON COLUMN public.black_box_entries.project_id IS
  '所属项目 ID；NULL 表示共享黑匣子仓（跨项目可见）';

-- focus_meta 来源约束
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'black_box_entries_focus_meta_source_check'
      AND conrelid = 'public.black_box_entries'::regclass
  ) THEN
    ALTER TABLE public.black_box_entries
      ADD CONSTRAINT black_box_entries_focus_meta_source_check
      CHECK (
        focus_meta IS NULL
        OR NOT (focus_meta ? 'source')
        OR focus_meta->>'source' = 'focus-console-inline'
      );
  END IF;
END $$;

-- 索引（外键级联保护；增量同步索引在后续收敛区统一定义）
-- 注意：idx_black_box_user_date, idx_black_box_project, idx_black_box_pending 经验证未使用，已移除
CREATE INDEX IF NOT EXISTS idx_black_box_entries_project_id
  ON public.black_box_entries(project_id);

-- updated_at 自动更新触发器
DROP TRIGGER IF EXISTS update_black_box_entries_updated_at ON public.black_box_entries;
CREATE TRIGGER update_black_box_entries_updated_at
  BEFORE UPDATE ON public.black_box_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE FUNCTION public.set_black_box_completed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(NEW.is_completed, FALSE) = FALSE THEN
    NEW.completed_at := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND COALESCE(OLD.is_completed, FALSE) = TRUE THEN
    NEW.completed_at := COALESCE(OLD.completed_at, NEW.completed_at);
    RETURN NEW;
  END IF;

  NEW.completed_at := COALESCE(NEW.completed_at, NOW());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_black_box_completed_at ON public.black_box_entries;
CREATE TRIGGER set_black_box_completed_at
  BEFORE INSERT OR UPDATE OF is_completed, completed_at ON public.black_box_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_black_box_completed_at();

REVOKE ALL ON FUNCTION public.set_black_box_completed_at() FROM PUBLIC, anon, authenticated;

-- RLS 策略（使用优化的 helper 函数）
ALTER TABLE public.black_box_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.black_box_entries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "black_box_select_optimized" ON public.black_box_entries;
DROP POLICY IF EXISTS "black_box_select_policy" ON public.black_box_entries;
CREATE POLICY "black_box_select_policy" ON public.black_box_entries
  FOR SELECT TO authenticated
  USING (
    (SELECT public.current_user_id()) = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  );

DROP POLICY IF EXISTS "black_box_insert_policy" ON public.black_box_entries;
CREATE POLICY "black_box_insert_policy" ON public.black_box_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.current_user_id()) = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  );

DROP POLICY IF EXISTS "black_box_update_policy" ON public.black_box_entries;
CREATE POLICY "black_box_update_policy" ON public.black_box_entries
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.current_user_id()) = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  )
  WITH CHECK (
    (SELECT public.current_user_id()) = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  );

DROP POLICY IF EXISTS "black_box_delete_policy" ON public.black_box_entries;
CREATE POLICY "black_box_delete_policy" ON public.black_box_entries
  FOR DELETE TO authenticated
  USING (
    (SELECT public.current_user_id()) = user_id
    AND (
      project_id IS NULL
      OR project_id IN (SELECT public.user_accessible_project_ids())
    )
  );

REVOKE ALL ON TABLE public.black_box_entries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.black_box_entries TO authenticated;
GRANT ALL ON TABLE public.black_box_entries TO service_role;

-- ============================================
-- 5.2 转写使用量表 (transcription_usage) - 专注模式
-- ============================================

CREATE TABLE IF NOT EXISTS public.transcription_usage (
  -- 主键：由 Edge Function 使用 crypto.randomUUID() 生成
  id UUID PRIMARY KEY,

  -- 外键关联
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 使用量数据
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  audio_seconds INTEGER DEFAULT 0,

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- transcription_usage 没有可验证的所有者来源；发现旧 NULL 行时中止，交由运维显式修复。
DO $transcription_owner$
DECLARE
  unresolved_count BIGINT;
BEGIN
  SELECT count(*)
  INTO unresolved_count
  FROM public.transcription_usage
  WHERE user_id IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION
      'transcription_usage contains unresolved NULL user_id rows: %',
      unresolved_count;
  END IF;
END
$transcription_owner$;

ALTER TABLE public.transcription_usage
  ALTER COLUMN user_id SET NOT NULL;

-- 添加表注释
COMMENT ON TABLE public.transcription_usage IS '转写 API 使用量追踪表 - 用于配额控制';
COMMENT ON COLUMN public.transcription_usage.audio_seconds IS '估算的音频秒数';

-- 索引
CREATE INDEX IF NOT EXISTS idx_transcription_usage_user_date ON public.transcription_usage(user_id, date);
CREATE INDEX IF NOT EXISTS idx_transcription_usage_created_at
  ON public.transcription_usage (created_at);

-- RLS 策略
ALTER TABLE public.transcription_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "transcription_usage_select_policy" ON public.transcription_usage;
DROP POLICY IF EXISTS "transcription_usage_select" ON public.transcription_usage;
CREATE POLICY "transcription_usage_select" ON public.transcription_usage
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

-- INSERT/UPDATE/DELETE 由 Edge Function 使用 service_role 执行，无需用户策略

CREATE OR REPLACE FUNCTION public.consume_transcription_quota(
  p_user_id UUID,
  p_usage_date DATE,
  p_daily_limit INTEGER,
  p_audio_seconds INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_usage_count INTEGER;
  v_usage_id UUID;
BEGIN
  IF p_user_id IS NULL OR p_usage_date IS NULL OR p_daily_limit IS NULL OR p_daily_limit <= 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_quota_request', 'usage_count', 0);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('transcription_usage'), hashtext(p_user_id::TEXT || ':' || p_usage_date::TEXT));

  SELECT count(*) INTO v_usage_count
  FROM public.transcription_usage
  WHERE user_id = p_user_id
    AND date = p_usage_date;

  IF v_usage_count >= p_daily_limit THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'quota_exceeded', 'usage_count', v_usage_count);
  END IF;

  v_usage_id := extensions.gen_random_uuid();
  INSERT INTO public.transcription_usage (id, user_id, date, audio_seconds)
  VALUES (v_usage_id, p_user_id, p_usage_date, GREATEST(COALESCE(p_audio_seconds, 0), 0));

  RETURN jsonb_build_object('allowed', true, 'usage_count', v_usage_count + 1, 'usage_id', v_usage_id);
END;
$$;

REVOKE ALL ON FUNCTION public.consume_transcription_quota(UUID, DATE, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_transcription_quota(UUID, DATE, INTEGER, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.release_transcription_quota(
  p_usage_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_deleted_count INTEGER := 0;
BEGIN
  IF p_usage_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('released', false, 'reason', 'invalid_release_request', 'deleted_count', 0);
  END IF;

  DELETE FROM public.transcription_usage
  WHERE id = p_usage_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN jsonb_build_object('released', v_deleted_count > 0, 'deleted_count', v_deleted_count);
END;
$$;

REVOKE ALL ON FUNCTION public.release_transcription_quota(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_transcription_quota(UUID, UUID) TO service_role;

-- ============================================
-- 5.3 专注会话快照表 (focus_sessions) - Focus Console v3
-- ============================================

CREATE TABLE IF NOT EXISTS public.focus_sessions (
  id              UUID PRIMARY KEY,                -- 客户端 crypto.randomUUID()
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  session_state   JSONB NOT NULL,                  -- FocusSessionState 序列化
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 注：idx_focus_sessions_user_id 已移除（被 idx_focus_sessions_user_updated_at 复合索引替代）
CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_updated_at
  ON public.focus_sessions (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_focus_sessions_ended_retention
  ON public.focus_sessions (updated_at)
  WHERE ended_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_focus_sessions_updated_at ON public.focus_sessions;
CREATE TRIGGER trg_focus_sessions_updated_at
  BEFORE UPDATE ON public.focus_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.focus_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.focus_sessions FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_select"
    ON focus_sessions FOR SELECT
    USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_insert"
    ON focus_sessions FOR INSERT
    WITH CHECK ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_update"
    ON focus_sessions FOR UPDATE
    USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_delete"
    ON focus_sessions FOR DELETE
    USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- anon 不允许访问用户数据表
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.focus_sessions TO authenticated;
GRANT ALL ON TABLE public.focus_sessions TO service_role;

-- ============================================
-- 5.4 日常任务表 (routine_tasks) - Focus Console v3
-- ============================================

CREATE TABLE IF NOT EXISTS public.routine_tasks (
  id                UUID PRIMARY KEY,              -- 客户端 crypto.randomUUID()
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  max_times_per_day INT NOT NULL DEFAULT 1,
  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 注：单列与旧两列索引均由完整 keyset 索引替代。
CREATE INDEX IF NOT EXISTS idx_routine_tasks_user_updated_id
  ON public.routine_tasks (user_id, updated_at, id);

DROP TRIGGER IF EXISTS trg_routine_tasks_updated_at ON public.routine_tasks;
CREATE TRIGGER trg_routine_tasks_updated_at
  BEFORE UPDATE ON public.routine_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.routine_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_tasks FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_select"
    ON routine_tasks FOR SELECT
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_insert"
    ON routine_tasks FOR INSERT
    TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_update"
    ON routine_tasks FOR UPDATE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_delete"
    ON routine_tasks FOR DELETE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- anon 不允许访问用户数据表
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.routine_tasks TO authenticated;
GRANT ALL ON TABLE public.routine_tasks TO service_role;

-- ============================================
-- 5.5 日常任务完成记录表 (routine_completions) - Focus Console v3
-- ============================================

CREATE TABLE IF NOT EXISTS public.routine_completions (
  id              UUID PRIMARY KEY,                -- 客户端 crypto.randomUUID()
  routine_id      UUID NOT NULL REFERENCES public.routine_tasks(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date_key        DATE NOT NULL,                   -- 完成日期
  count           INT NOT NULL DEFAULT 1,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.routine_completion_events (
  id              UUID PRIMARY KEY,
  routine_id      UUID NOT NULL REFERENCES public.routine_tasks(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date_key        DATE NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_routine_completions_user_routine_date_key
  ON public.routine_completions (user_id, routine_id, date_key);
CREATE INDEX IF NOT EXISTS idx_routine_completion_events_user_routine_date
  ON public.routine_completion_events (user_id, routine_id, date_key);

-- 注：routine_id 外键索引由末尾 20260716001100 最终收敛块统一保证。

DROP TRIGGER IF EXISTS trg_routine_completions_updated_at ON public.routine_completions;
CREATE TRIGGER trg_routine_completions_updated_at
  BEFORE UPDATE ON public.routine_completions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.routine_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_completions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.routine_completion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_completion_events FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "routine_completions_select"
    ON routine_completions FOR SELECT
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DROP POLICY IF EXISTS "routine_completions_insert" ON public.routine_completions;
DROP POLICY IF EXISTS "routine_completions_update" ON public.routine_completions;
DROP POLICY IF EXISTS "routine_completions_delete" ON public.routine_completions;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.routine_completions FROM authenticated;
GRANT SELECT ON TABLE public.routine_completions TO authenticated;
GRANT ALL ON TABLE public.routine_completions TO service_role;
REVOKE ALL ON TABLE public.routine_completion_events FROM authenticated;
REVOKE ALL ON TABLE public.routine_completion_events FROM anon;
GRANT ALL ON TABLE public.routine_completion_events TO service_role;

-- ============================================
-- 6. 清理日志表 (cleanup_logs)
-- ============================================

CREATE TABLE IF NOT EXISTS public.cleanup_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.cleanup_logs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_created_at ON public.cleanup_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_attachment_cursor
  ON public.cleanup_logs (created_at DESC)
  WHERE type = 'attachment_cleanup';

-- ============================================
-- 6.1 任务 Tombstone 表 (task_tombstones)
-- 用于永久删除任务后防止复活
-- ============================================

CREATE TABLE IF NOT EXISTS public.task_tombstones (
  task_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  deleted_by UUID REFERENCES auth.users(id)
);

ALTER TABLE public.task_tombstones ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_deleted_task
  ON public.task_tombstones (project_id, deleted_at, task_id);
CREATE INDEX IF NOT EXISTS idx_task_tombstones_deleted_at
  ON public.task_tombstones (deleted_at);
-- 注：deleted_by 外键部分索引由末尾 20260716001100 最终收敛块统一保证。

-- RLS 策略（使用优化的 helper 函数）
DROP POLICY IF EXISTS "task_tombstones_select_owner" ON public.task_tombstones;
DROP POLICY IF EXISTS "task_tombstones_insert_owner" ON public.task_tombstones;

CREATE POLICY "task_tombstones_select_owner" ON public.task_tombstones FOR SELECT USING (
  project_id IN (SELECT public.user_accessible_project_ids())
);
CREATE POLICY "task_tombstones_insert_owner" ON public.task_tombstones FOR INSERT WITH CHECK (
  public.user_is_project_owner(project_id)
);

-- ============================================
-- 6.2 连接 Tombstone 表 (connection_tombstones)
-- 用于永久删除连接后防止复活
-- ============================================

CREATE TABLE IF NOT EXISTS public.connection_tombstones (
  connection_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.connection_tombstones ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_connection_tombstones_project_deleted_connection
  ON public.connection_tombstones(project_id, deleted_at, connection_id);
CREATE INDEX IF NOT EXISTS idx_connection_tombstones_deleted_at ON public.connection_tombstones(deleted_at);
-- 注：deleted_by 外键部分索引由末尾 20260716001100 最终收敛块统一保证。

-- RLS 策略（使用优化的 helper 函数）
DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;
DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;

CREATE POLICY "connection_tombstones_select" ON public.connection_tombstones FOR SELECT USING (
  project_id IN (SELECT public.user_accessible_project_ids())
);

CREATE POLICY "connection_tombstones_insert" ON public.connection_tombstones FOR INSERT WITH CHECK (
  public.user_is_project_owner(project_id)
);

-- 11. purge_rate_limits 表（速率限制）
-- ============================================

CREATE TABLE IF NOT EXISTS public.purge_rate_limits (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  call_count INTEGER DEFAULT 0,
  window_start TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.purge_rate_limits ENABLE ROW LEVEL SECURITY;

-- RLS 策略
DROP POLICY IF EXISTS "purge_rate_limits_own" ON public.purge_rate_limits;

CREATE POLICY "purge_rate_limits_own" ON public.purge_rate_limits
  FOR ALL
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- ============================================
-- 自定义类型
-- ============================================

-- purge_result 复合类型
DROP TYPE IF EXISTS purge_result CASCADE;
CREATE TYPE purge_result AS (
  purged_count INTEGER,
  attachment_paths TEXT[]
);

-- ============================================
-- 触发器和函数
-- ============================================

-- 防止 tombstone 连接复活的触发器
CREATE OR REPLACE FUNCTION prevent_tombstoned_connection_writes()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.connection_tombstones WHERE connection_id = NEW.id) THEN
    -- 静默忽略，防止旧客户端数据复活
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.prevent_tombstoned_connection_writes()
  SET search_path TO 'pg_catalog', 'public';

DROP TRIGGER IF EXISTS trg_prevent_connection_resurrection ON public.connections;
CREATE TRIGGER trg_prevent_connection_resurrection
  BEFORE INSERT OR UPDATE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION prevent_tombstoned_connection_writes();

-- 自动记录 Connection Tombstone 的触发器
CREATE OR REPLACE FUNCTION record_connection_tombstone()
RETURNS TRIGGER AS $$
BEGIN
  -- 中文注释：任何物理删除都要落 tombstone，覆盖任务 purge 的级联删除路径。
  INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
  VALUES (OLD.id, OLD.project_id, NOW(), auth.uid())
  ON CONFLICT (connection_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_record_connection_tombstone ON public.connections;
CREATE TRIGGER trg_record_connection_tombstone
  BEFORE DELETE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION record_connection_tombstone();

-- 检查连接是否已被 tombstone
CREATE OR REPLACE FUNCTION public.is_connection_tombstoned(p_connection_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.connection_tombstones AS tombstone
    JOIN public.projects AS project ON project.id = tombstone.project_id
    WHERE tombstone.connection_id = p_connection_id
      AND (
        project.owner_id = (SELECT auth.uid())
        OR current_user = 'service_role'
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_connection_tombstoned(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_connection_tombstoned(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_connection_tombstoned(UUID) TO service_role;
GRANT SELECT, INSERT ON public.connection_tombstones TO service_role;
GRANT SELECT, INSERT ON public.connection_tombstones TO authenticated;

-- 防止 tombstone 任务复活的触发器
-- prevent_tombstoned_task_writes 函数已在后面的 MIGRATION 20251212_prevent_task_resurrection.sql 中定义（第 1379 行）

-- ============================================
-- 7. RLS 策略 - Projects
-- ============================================

DROP POLICY IF EXISTS "owner select" ON public.projects;
DROP POLICY IF EXISTS "owner insert" ON public.projects;
DROP POLICY IF EXISTS "owner update" ON public.projects;
DROP POLICY IF EXISTS "owner delete" ON public.projects;

CREATE POLICY "owner select" ON public.projects FOR SELECT USING (
  (select auth.uid()) = owner_id
);
CREATE POLICY "owner insert" ON public.projects FOR INSERT WITH CHECK ((select auth.uid()) = owner_id);
CREATE POLICY "owner update" ON public.projects FOR UPDATE USING (
  (select auth.uid()) = owner_id
) WITH CHECK ((select auth.uid()) = owner_id);
CREATE POLICY "owner delete" ON public.projects FOR DELETE USING (
  (select auth.uid()) = owner_id
  AND deleted_at IS NULL
);

-- ============================================
-- 8. RLS 策略 - Project Members
-- ============================================

DROP POLICY IF EXISTS "project_members select" ON public.project_members;
DROP POLICY IF EXISTS "project_members insert" ON public.project_members;
DROP POLICY IF EXISTS "project_members update" ON public.project_members;
DROP POLICY IF EXISTS "project_members delete" ON public.project_members;

CREATE POLICY "project_members select" ON public.project_members FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid() AND p.deleted_at IS NULL)
);
CREATE POLICY "project_members insert" ON public.project_members FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid() AND p.deleted_at IS NULL)
);
CREATE POLICY "project_members update" ON public.project_members FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid() AND p.deleted_at IS NULL)
);
CREATE POLICY "project_members delete" ON public.project_members FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid() AND p.deleted_at IS NULL)
);

-- ============================================
-- 9. RLS 策略 - Tasks
-- ============================================

DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;

-- 使用缓存的 helper 函数优化性能
CREATE POLICY "tasks owner select" ON public.tasks FOR SELECT USING (
  project_id IN (SELECT public.user_accessible_project_ids())
);
CREATE POLICY "tasks owner insert" ON public.tasks FOR INSERT WITH CHECK (
  public.user_has_project_access(project_id)
);
CREATE POLICY "tasks owner update" ON public.tasks FOR UPDATE USING (
  public.user_has_project_access(project_id)
);
CREATE POLICY "tasks owner delete" ON public.tasks FOR DELETE USING (
  public.user_is_project_owner(project_id)
);

-- ============================================
-- 10. RLS 策略 - Connections
-- ============================================

DROP POLICY IF EXISTS "connections owner select" ON public.connections;
DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
DROP POLICY IF EXISTS "connections owner update" ON public.connections;
DROP POLICY IF EXISTS "connections owner delete" ON public.connections;

-- 使用缓存的 helper 函数优化性能
CREATE POLICY "connections owner select" ON public.connections FOR SELECT USING (
  project_id IN (SELECT public.user_accessible_project_ids())
);
CREATE POLICY "connections owner insert" ON public.connections FOR INSERT WITH CHECK (
  public.user_has_project_access(project_id)
);
CREATE POLICY "connections owner update" ON public.connections FOR UPDATE USING (
  public.user_has_project_access(project_id)
);
CREATE POLICY "connections owner delete" ON public.connections FOR DELETE USING (
  public.user_is_project_owner(project_id)
);

-- ============================================
-- 11. RLS 策略 - User Preferences
-- ============================================

DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can delete own preferences" ON public.user_preferences;

CREATE POLICY "Users can view own preferences" ON public.user_preferences
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can insert own preferences" ON public.user_preferences
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own preferences" ON public.user_preferences
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can delete own preferences" ON public.user_preferences
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

REVOKE ALL ON TABLE public.user_preferences FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_preferences TO authenticated;
GRANT ALL ON TABLE public.user_preferences TO service_role;

-- ============================================
-- 12. 附件 RPC 函数
-- ============================================

-- 添加附件（原子操作）
CREATE OR REPLACE FUNCTION append_task_attachment(p_task_id UUID, p_attachment JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  v_current_attachments JSONB;
  v_attachment_id TEXT;
  v_project_id UUID;
BEGIN
  v_attachment_id := p_attachment->>'id';
  IF v_attachment_id IS NULL THEN RAISE EXCEPTION 'Attachment must have an id'; END IF;

  SELECT project_id, attachments INTO v_project_id, v_current_attachments
  FROM public.tasks
  WHERE id = p_task_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found: %', p_task_id; END IF;
  IF NOT public.user_is_project_owner(v_project_id) THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF v_current_attachments IS NULL THEN v_current_attachments := '[]'::JSONB; END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_current_attachments) AS elem WHERE elem->>'id' = v_attachment_id) THEN
    RETURN TRUE;
  END IF;

  UPDATE public.tasks
  SET attachments = v_current_attachments || p_attachment, updated_at = NOW()
  WHERE id = p_task_id;
  RETURN TRUE;
END; $$;

-- 移除附件（原子操作）
CREATE OR REPLACE FUNCTION remove_task_attachment(p_task_id UUID, p_attachment_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  v_current_attachments JSONB;
  v_new_attachments JSONB;
  v_project_id UUID;
BEGIN
  SELECT project_id, attachments INTO v_project_id, v_current_attachments
  FROM public.tasks
  WHERE id = p_task_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found: %', p_task_id; END IF;
  IF NOT public.user_is_project_owner(v_project_id) THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF v_current_attachments IS NULL OR jsonb_array_length(v_current_attachments) = 0 THEN RETURN TRUE; END IF;

  SELECT COALESCE(jsonb_agg(elem), '[]'::JSONB) INTO v_new_attachments
  FROM jsonb_array_elements(v_current_attachments) AS elem WHERE elem->>'id' != p_attachment_id;

  UPDATE public.tasks
  SET attachments = v_new_attachments, updated_at = NOW()
  WHERE id = p_task_id;
  RETURN TRUE;
END; $$;

-- 授予 authenticated 用户执行权限
GRANT EXECUTE ON FUNCTION append_task_attachment(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION remove_task_attachment(UUID, TEXT) TO authenticated;

-- ============================================
-- 13. 清理函数
-- ============================================

-- 清理软删除任务（30天后）
CREATE OR REPLACE FUNCTION public.cleanup_old_deleted_tasks()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT INTEGER := 5000;
  v_deleted_count INTEGER := 0;
BEGIN
  WITH expired_tasks AS MATERIALIZED (
    SELECT tasks.id AS task_id, tasks.project_id
    FROM public.tasks AS tasks
    WHERE tasks.deleted_at IS NOT NULL
      AND tasks.deleted_at < NOW() - INTERVAL '30 days'
    ORDER BY tasks.deleted_at ASC, tasks.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF tasks SKIP LOCKED
  ),
  task_tombstone_rows AS (
    INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
    SELECT candidates.task_id, candidates.project_id, NOW(), NULL
    FROM expired_tasks AS candidates
    ON CONFLICT (task_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING task_id, project_id
  ),
  expired_connections AS MATERIALIZED (
    SELECT DISTINCT connections.id AS connection_id, connections.project_id
    FROM public.connections AS connections
    JOIN task_tombstone_rows AS tombstones
      ON tombstones.project_id = connections.project_id
    WHERE connections.source_id = tombstones.task_id
       OR connections.target_id = tombstones.task_id
  ),
  connection_tombstone_rows AS (
    INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
    SELECT connections.connection_id, connections.project_id, NOW(), NULL
    FROM expired_connections AS connections
    ON CONFLICT (connection_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING connection_id
  ),
  deleted_connections AS (
    DELETE FROM public.connections AS connections
    USING connection_tombstone_rows AS tombstones
    WHERE connections.id = tombstones.connection_id
    RETURNING connections.id
  ),
  deleted_tasks AS (
    DELETE FROM public.tasks AS tasks
    USING task_tombstone_rows AS tombstones
    WHERE tasks.id = tombstones.task_id
    RETURNING tasks.id
  )
  SELECT COUNT(*)::INTEGER INTO v_deleted_count FROM deleted_tasks;

  IF v_deleted_count > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES ('deleted_tasks_cleanup', jsonb_build_object(
      'deleted_count', v_deleted_count,
      'cleanup_time', NOW(),
      'mode', 'bounded_tombstone_then_delete'
    ));
  END IF;

  RETURN v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_old_deleted_tasks()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_tasks()
  TO service_role;

-- 清理旧日志（30天后）
CREATE OR REPLACE FUNCTION public.cleanup_old_logs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT INTEGER := 5000;
  v_deleted_count INTEGER := 0;
BEGIN
  WITH candidates AS MATERIALIZED (
    SELECT logs.id
    FROM public.cleanup_logs AS logs
    WHERE logs.created_at < NOW() - INTERVAL '30 days'
    ORDER BY logs.created_at ASC, logs.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF logs SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.cleanup_logs AS logs
    USING candidates
    WHERE logs.id = candidates.id
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER INTO v_deleted_count FROM deleted;

  RETURN v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_old_logs()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_logs()
  TO service_role;

-- 清理软删除连接（30天后）
CREATE OR REPLACE FUNCTION public.cleanup_old_deleted_connections()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT INTEGER := 5000;
  v_deleted_count INTEGER := 0;
BEGIN
  WITH expired_connections AS MATERIALIZED (
    SELECT connections.id AS connection_id, connections.project_id
    FROM public.connections AS connections
    WHERE connections.deleted_at IS NOT NULL
      AND connections.deleted_at < NOW() - INTERVAL '30 days'
    ORDER BY connections.deleted_at ASC, connections.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF connections SKIP LOCKED
  ),
  connection_tombstone_rows AS (
    INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
    SELECT connections.connection_id, connections.project_id, NOW(), NULL
    FROM expired_connections AS connections
    ON CONFLICT (connection_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING connection_id
  ),
  deleted_connections AS (
    DELETE FROM public.connections AS connections
    USING connection_tombstone_rows AS tombstones
    WHERE connections.id = tombstones.connection_id
    RETURNING connections.id
  )
  SELECT COUNT(*)::INTEGER INTO v_deleted_count FROM deleted_connections;

  IF v_deleted_count > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES ('deleted_connections_cleanup', jsonb_build_object(
      'deleted_count', v_deleted_count,
      'cleanup_time', NOW(),
      'mode', 'bounded_tombstone_then_delete'
    ));
  END IF;

  RETURN v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_old_deleted_connections()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_connections()
  TO service_role;

-- ============================================
-- 13.1 软删除清理定时任务（pg_cron，可选）
-- ============================================
-- 目标：在支持 pg_cron 的环境中，自动调度软删除清理任务
-- 说明：
-- - 幂等：重复执行会先移除旧任务再重建
-- - 容错：如果当前实例不支持 pg_cron，仅输出 NOTICE，不中断初始化
-- - 函数校验：调度前确认清理函数存在，避免静默失败
-- - 与 scripts/cleanup-cron-setup.sql 保持同步（后者为独立可执行版本，使用 EXCEPTION 而非 NOTICE）
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'pg_cron 不可用，跳过清理定时任务配置: %', SQLERRM;
      RAISE NOTICE '可后续执行 scripts/cleanup-cron-setup.sql 重试';
      RETURN;
  END;

  -- 验证 cron schema 生效
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron 扩展未生效（cron schema 不存在），跳过配置';
    RETURN;
  END IF;

  -- 校验清理函数存在性（避免静默注册无效任务）
  IF to_regprocedure('public.cleanup_old_deleted_tasks()') IS NULL THEN
    RAISE NOTICE '缺少函数 cleanup_old_deleted_tasks()，跳过 cron 配置';
    RETURN;
  END IF;
  IF to_regprocedure('public.cleanup_old_deleted_connections()') IS NULL THEN
    RAISE NOTICE '缺少函数 cleanup_old_deleted_connections()，跳过 cron 配置';
    RETURN;
  END IF;
  IF to_regprocedure('public.cleanup_old_logs()') IS NULL THEN
    RAISE NOTICE '缺少函数 cleanup_old_logs()，跳过 cron 配置';
    RETURN;
  END IF;

  -- 清理旧任务（如果存在），幂等处理
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname IN (
    'nanoflow-cleanup-deleted-tasks',
    'nanoflow-cleanup-deleted-connections',
    'nanoflow-cleanup-logs'
  );

  -- 每天 03:10 UTC 清理软删除任务
  PERFORM cron.schedule(
    'nanoflow-cleanup-deleted-tasks',
    '10 3 * * *',
    $job$SELECT public.cleanup_old_deleted_tasks();$job$
  );

  -- 每天 03:20 UTC 清理软删除连接
  PERFORM cron.schedule(
    'nanoflow-cleanup-deleted-connections',
    '20 3 * * *',
    $job$SELECT public.cleanup_old_deleted_connections();$job$
  );

  -- 每天 03:30 UTC 清理旧日志
  PERFORM cron.schedule(
    'nanoflow-cleanup-logs',
    '30 3 * * *',
    $job$SELECT public.cleanup_old_logs();$job$
  );

  RAISE NOTICE 'pg_cron 清理任务已配置: nanoflow-cleanup-deleted-tasks, nanoflow-cleanup-deleted-connections, nanoflow-cleanup-logs';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE '配置 pg_cron 清理任务失败（已忽略，不影响初始化）: %', SQLERRM;
    RAISE NOTICE '可后续执行 scripts/cleanup-cron-setup.sql 单独配置';
END $$;

-- 迁移函数：从 JSONB 到独立表
CREATE OR REPLACE FUNCTION migrate_project_data_to_v2(p_project_id UUID)
RETURNS TABLE (
  tasks_migrated INTEGER,
  connections_migrated INTEGER,
  errors TEXT[]
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  project_record RECORD;
  task_data JSONB;
  conn_data JSONB;
  task_record JSONB;
  conn_record JSONB;
  task_id UUID;
  task_count INTEGER := 0;
  conn_count INTEGER := 0;
  error_list TEXT[] := ARRAY[]::TEXT[];
  old_id_to_new_id JSONB := '{}'::jsonb;
BEGIN
  -- 获取项目数据
  SELECT * INTO project_record
  FROM public.projects
  WHERE id = p_project_id;

  IF NOT FOUND THEN
    error_list := array_append(error_list, 'Project not found: ' || p_project_id::text);
    RETURN QUERY SELECT 0, 0, error_list;
    RETURN;
  END IF;

  -- 检查是否已迁移
  IF project_record.migrated_to_v2 = TRUE THEN
    error_list := array_append(error_list, 'Project already migrated');
    RETURN QUERY SELECT 0, 0, error_list;
    RETURN;
  END IF;

  -- 获取 tasks 数组
  task_data := COALESCE(project_record.data->'tasks', '[]'::jsonb);

  -- 迁移每个任务
  FOR task_record IN SELECT * FROM jsonb_array_elements(task_data)
  LOOP
    BEGIN
      -- 生成新的 UUID（保留原 ID 作为映射）
      task_id := COALESCE(
        (task_record->>'id')::uuid,
        gen_random_uuid()
      );

      -- 存储 ID 映射
      old_id_to_new_id := old_id_to_new_id || jsonb_build_object(
        task_record->>'id',
        task_id::text
      );

      -- 插入任务（如果不存在）
      INSERT INTO public.tasks (
        id,
        project_id,
        parent_id,
        title,
        content,
        stage,
        "order",
        rank,
        status,
        x,
        y,
        short_id,
        priority,
        due_date,
        tags,
        attachments,
        deleted_at,
        created_at
      ) VALUES (
        task_id,
        p_project_id,
        NULL, -- parent_id 稍后更新
        COALESCE(task_record->>'title', ''),
        COALESCE(task_record->>'content', ''),
        (task_record->>'stage')::INTEGER,
        COALESCE((task_record->>'order')::INTEGER, 0),
        COALESCE((task_record->>'rank')::NUMERIC, 10000),
        COALESCE(task_record->>'status', 'active'),
        COALESCE((task_record->>'x')::NUMERIC, 0),
        COALESCE((task_record->>'y')::NUMERIC, 0),
        task_record->>'shortId',
        task_record->>'priority',
        CASE WHEN task_record->>'dueDate' IS NOT NULL
             THEN (task_record->>'dueDate')::TIMESTAMP WITH TIME ZONE
             ELSE NULL END,
        COALESCE(task_record->'tags', '[]'::jsonb),
        COALESCE(task_record->'attachments', '[]'::jsonb),
        CASE WHEN task_record->>'deletedAt' IS NOT NULL
             THEN (task_record->>'deletedAt')::TIMESTAMP WITH TIME ZONE
             ELSE NULL END,
        COALESCE(
          (task_record->>'createdDate')::TIMESTAMP WITH TIME ZONE,
          NOW()
        )
      )
      ON CONFLICT (id) DO NOTHING;

      task_count := task_count + 1;

    EXCEPTION WHEN OTHERS THEN
      error_list := array_append(error_list,
        'Error migrating task: ' || SQLERRM || ' - ' || task_record::text
      );
    END;
  END LOOP;

  -- 更新 parent_id 关系
  FOR task_record IN SELECT * FROM jsonb_array_elements(task_data)
  LOOP
    IF task_record->>'parentId' IS NOT NULL THEN
      BEGIN
        UPDATE public.tasks
        SET parent_id = (old_id_to_new_id->>(task_record->>'parentId'))::UUID
        WHERE id = (old_id_to_new_id->>(task_record->>'id'))::UUID
        AND project_id = p_project_id;
      EXCEPTION WHEN OTHERS THEN
        error_list := array_append(error_list,
          'Error updating parent_id: ' || SQLERRM
        );
      END;
    END IF;
  END LOOP;

  -- 获取 connections 数组
  conn_data := COALESCE(project_record.data->'connections', '[]'::jsonb);

  -- 迁移每个连接
  FOR conn_record IN SELECT * FROM jsonb_array_elements(conn_data)
  LOOP
    BEGIN
      -- 插入连接
      INSERT INTO public.connections (
        project_id,
        source_id,
        target_id,
        description
      ) VALUES (
        p_project_id,
        (old_id_to_new_id->>(conn_record->>'source'))::UUID,
        (old_id_to_new_id->>(conn_record->>'target'))::UUID,
        conn_record->>'description'
      )
      ON CONFLICT (project_id, source_id, target_id) DO NOTHING;

      conn_count := conn_count + 1;

    EXCEPTION WHEN OTHERS THEN
      error_list := array_append(error_list,
        'Error migrating connection: ' || SQLERRM || ' - ' || conn_record::text
      );
    END;
  END LOOP;

  -- 标记项目已迁移
  UPDATE public.projects
  SET migrated_to_v2 = TRUE
  WHERE id = p_project_id;

  RETURN QUERY SELECT task_count, conn_count, error_list;
END; $$;

GRANT EXECUTE ON FUNCTION migrate_project_data_to_v2(UUID) TO authenticated;

-- 批量迁移所有项目
CREATE OR REPLACE FUNCTION migrate_all_projects_to_v2()
RETURNS TABLE (
  project_id UUID,
  project_title TEXT,
  tasks_migrated INTEGER,
  connections_migrated INTEGER,
  errors TEXT[]
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  project_record RECORD;
  migration_result RECORD;
BEGIN
  FOR project_record IN
    SELECT id, title
    FROM public.projects
    WHERE migrated_to_v2 = FALSE OR migrated_to_v2 IS NULL
  LOOP
    SELECT * INTO migration_result
    FROM migrate_project_data_to_v2(project_record.id);

    RETURN QUERY SELECT
      project_record.id,
      project_record.title,
      migration_result.tasks_migrated,
      migration_result.connections_migrated,
      migration_result.errors;
  END LOOP;
END; $$;

GRANT EXECUTE ON FUNCTION migrate_all_projects_to_v2() TO authenticated;

-- 永久删除任务（写入 tombstone + 物理删除）
-- 核心 RPC：防止已删除任务复活
CREATE OR REPLACE FUNCTION purge_tasks_v2(p_project_id UUID, p_task_ids UUID[])
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 仅为当前 project 中真实存在的任务落 tombstone，禁止跨项目污染
  WITH to_purge AS (
    SELECT candidate.task_id
    FROM (
      SELECT t.id AS task_id
      FROM public.tasks t
      WHERE t.project_id = p_project_id
        AND t.id = ANY(p_task_ids)

      UNION

      SELECT tt.task_id
      FROM public.task_tombstones tt
      WHERE tt.project_id = p_project_id
        AND tt.task_id = ANY(p_task_ids)
    ) AS candidate
  )
  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT task_id, p_project_id, now(), auth.uid()
  FROM to_purge
  ON CONFLICT (task_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  -- 中文注释：任务 purge 会直接带走关联连接，必须先显式落 connection tombstone，避免另一端长期残留旧连接。
  INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
  SELECT c.id, c.project_id, now(), auth.uid()
  FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids))
  ON CONFLICT (connection_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  -- 删除相关连接
  DELETE FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids));

  -- 删除 tasks 行（如果存在）
  WITH del AS (
    DELETE FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
    RETURNING t.id
  )
  SELECT count(*) INTO purged_count FROM del;

  RETURN COALESCE(purged_count, 0);
END; $$;

GRANT EXECUTE ON FUNCTION purge_tasks_v2(UUID, UUID[]) TO authenticated;

-- 清理过期软删除附件
CREATE OR REPLACE FUNCTION cleanup_deleted_attachments(retention_days INTEGER DEFAULT 30)
RETURNS TABLE(deleted_count INTEGER, storage_paths TEXT[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  cutoff_date TIMESTAMPTZ;
  paths_to_delete TEXT[] := ARRAY[]::TEXT[];
  task_record RECORD;
  attachment JSONB;
  total_deleted INTEGER := 0;
BEGIN
  cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;

  FOR task_record IN
    SELECT t.id AS task_id, t.project_id, t.attachments, p.owner_id
    FROM tasks t JOIN projects p ON t.project_id = p.id
    WHERE t.attachments IS NOT NULL AND jsonb_array_length(t.attachments) > 0
  LOOP
    FOR attachment IN SELECT * FROM jsonb_array_elements(task_record.attachments) LOOP
      IF attachment->>'deletedAt' IS NOT NULL AND (attachment->>'deletedAt')::TIMESTAMPTZ < cutoff_date THEN
        paths_to_delete := array_append(paths_to_delete,
          task_record.owner_id || '/' || task_record.project_id || '/' || task_record.task_id || '/' || (attachment->>'id')
        );
        total_deleted := total_deleted + 1;
      END IF;
    END LOOP;

    UPDATE tasks SET attachments = (
      SELECT jsonb_agg(att) FROM jsonb_array_elements(task_record.attachments) AS att
      WHERE att->>'deletedAt' IS NULL OR (att->>'deletedAt')::TIMESTAMPTZ >= cutoff_date
    ) WHERE id = task_record.task_id AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(task_record.attachments) AS att
      WHERE att->>'deletedAt' IS NOT NULL AND (att->>'deletedAt')::TIMESTAMPTZ < cutoff_date
    );
  END LOOP;

  RETURN QUERY SELECT total_deleted, paths_to_delete;
END; $$;

GRANT EXECUTE ON FUNCTION cleanup_deleted_attachments TO service_role;

-- ============================================
-- 14. 配置 REPLICA IDENTITY（Realtime DELETE 事件所需）
-- ============================================

ALTER TABLE public.projects REPLICA IDENTITY FULL;
ALTER TABLE public.tasks REPLICA IDENTITY FULL;
ALTER TABLE public.connections REPLICA IDENTITY FULL;

-- ============================================
-- 15. 启用实时订阅
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'projects') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.projects;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'tasks') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'connections') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.connections;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'user_preferences') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_preferences;
  END IF;
END $$;

-- ============================================
-- 16. Storage 策略（attachments 桶）
-- ============================================

-- 用户可以上传自己的附件 (路径格式: {user_id}/{project_id}/{task_id}/{filename})
DROP POLICY IF EXISTS "Users can upload own attachments" ON storage.objects;
CREATE POLICY "Users can upload own attachments" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'attachments' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

-- 用户可以查看自己的附件
DROP POLICY IF EXISTS "Users can view own attachments" ON storage.objects;
CREATE POLICY "Users can view own attachments" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

-- 用户可以删除自己的附件
DROP POLICY IF EXISTS "Users can delete own attachments" ON storage.objects;
CREATE POLICY "Users can delete own attachments" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

-- 用户可以更新自己的附件元数据（2026-01-07 补齐）
DROP POLICY IF EXISTS "Users can update own attachments" ON storage.objects;
CREATE POLICY "Users can update own attachments" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text)
WITH CHECK (bucket_id = 'attachments' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

-- 旧策略与 owner-only SELECT 完全重复，保留会让每次读取执行两套 permissive policy。
DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;

-- ============================================
-- 完成！
-- ============================================
--
-- 数据库表：
--   ✓ projects          - 项目
--   ✓ project_members   - 项目成员（协作预留）
--   ✓ tasks             - 任务（含 deleted_at 软删除）
--   ✓ connections       - 任务连接（含 title, deleted_at）
--   ✓ user_preferences  - 用户偏好
--   ✓ cleanup_logs      - 清理日志
--   ✓ task_tombstones   - 任务永久删除记录（防止复活）
--
-- RPC 函数：
--   ✓ append_task_attachment(task_id, attachment)
--   ✓ remove_task_attachment(task_id, attachment_id)
--   ✓ cleanup_old_deleted_tasks()
--   ✓ cleanup_old_deleted_connections()
--   ✓ cleanup_old_logs()
--   ✓ cleanup_deleted_attachments(retention_days)
--   ✓ purge_tasks_v2(project_id, task_ids)  - 永久删除任务（写入 tombstone）
--
-- 定时任务：
--   - 本脚本第 13.1 节会自动尝试配置：
--       nanoflow-cleanup-deleted-tasks
--       nanoflow-cleanup-deleted-connections
--       nanoflow-cleanup-logs
--   - 若实例不支持 pg_cron，可后续执行 scripts/cleanup-cron-setup.sql 重试
--
-- Storage 桶配置（需要在 Dashboard 中创建）：
--   Name: attachments
--   Public: false
--   File size limit: 10MB
-- ============================================================
-- [MIGRATION] 20251203_sync_schema_with_code.sql
-- ============================================================
-- ============================================
-- 同步数据库 Schema 与项目代码
-- 日期: 2025-12-03
-- ============================================

-- 1. 为 user_preferences 表添加缺失的列
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS layout_direction varchar(10) DEFAULT 'ltr',
  ADD COLUMN IF NOT EXISTS floating_window_pref varchar(10) DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS last_backup_proof_at timestamptz DEFAULT NULL;

-- 添加约束检查
DO $$
BEGIN
  -- 删除旧约束（如果存在）然后添加新约束
  ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_preferences_layout_direction_check;
  ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_layout_direction_check
    CHECK (layout_direction IS NULL OR layout_direction IN ('ltr', 'rtl'));

  ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_preferences_floating_window_pref_check;
  ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_floating_window_pref_check
    CHECK (floating_window_pref IS NULL OR floating_window_pref IN ('auto', 'fixed'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. 清理日志表与清理函数已在文件早期定义（保持幂等重跑）

-- 6. 为 cleanup_logs 表添加索引
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_created_at ON public.cleanup_logs (created_at);

-- 7. 授予必要的权限
REVOKE ALL ON TABLE public.cleanup_logs FROM authenticated;
REVOKE ALL ON TABLE public.cleanup_logs FROM anon;
GRANT ALL ON TABLE public.cleanup_logs TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_deleted_tasks() TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_logs() TO service_role;
-- ============================================================
-- [MIGRATION] 20251208_fix_realtime_delete_events.sql
-- ============================================================
-- ============================================
-- 修复 Realtime DELETE 事件问题
-- 日期: 2025-12-08
-- ============================================
--
-- 问题描述:
-- 当在一个设备上删除任务时，其他设备无法接收到删除事件
-- 这是因为表缺少 REPLICA IDENTITY FULL 配置
--
-- 解决方案:
-- 设置 REPLICA IDENTITY FULL 确保 DELETE 事件包含完整的旧行数据
-- 这样客户端可以正确识别被删除的记录

-- 设置 REPLICA IDENTITY FULL
-- 注意：这会增加一些存储开销，但对于确保跨设备同步的正确性是必需的
ALTER TABLE public.projects REPLICA IDENTITY FULL;
ALTER TABLE public.tasks REPLICA IDENTITY FULL;
ALTER TABLE public.connections REPLICA IDENTITY FULL;

-- 验证配置（可选，用于调试）
-- SELECT
--   n.nspname as schemaname,
--   c.relname as tablename,
--   CASE c.relreplident
--     WHEN 'd' THEN 'DEFAULT (primary key)'
--     WHEN 'n' THEN 'NOTHING'
--     WHEN 'f' THEN 'FULL'
--     WHEN 'i' THEN 'INDEX'
--   END as replica_identity
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'public'
-- AND c.relname IN ('projects', 'tasks', 'connections');
-- ============================================================
-- [MIGRATION] 20251212_hardening_and_indexes.sql
-- ============================================================
-- ============================================
-- 安全加固 + 性能小优化（search_path + 外键索引 + RLS initplan）
-- 日期: 2025-12-12
-- ============================================

-- 1) 性能：为未覆盖的外键列补齐索引
-- 注：idx_project_members_invited_by 已移除（invited_by 极少作为查询条件）

CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_deleted_task
  ON public.task_tombstones (project_id, deleted_at, task_id);

-- 2) 安全：为函数显式设置 search_path（避免 search_path 可变引发的劫持风险）
-- 说明：优先 pg_catalog，确保内建函数解析更安全。

DROP POLICY IF EXISTS "owner delete" ON public.projects;
CREATE POLICY "owner delete" ON public.projects
  FOR DELETE
  TO public
  USING ((select auth.uid()) = owner_id);

-- project_members
DROP POLICY IF EXISTS "project_members select" ON public.project_members;
CREATE POLICY "project_members select" ON public.project_members
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "project_members insert" ON public.project_members;
CREATE POLICY "project_members insert" ON public.project_members
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "project_members update" ON public.project_members;
CREATE POLICY "project_members update" ON public.project_members
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
      AND p.deleted_at IS NULL
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "project_members delete" ON public.project_members;
CREATE POLICY "project_members delete" ON public.project_members
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

REVOKE ALL ON TABLE public.project_members FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.project_members TO authenticated;
GRANT ALL ON TABLE public.project_members TO service_role;

-- tasks
DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
CREATE POLICY "tasks owner select" ON public.tasks
  FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
CREATE POLICY "tasks owner insert" ON public.tasks
  FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
CREATE POLICY "tasks owner update" ON public.tasks
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;
CREATE POLICY "tasks owner delete" ON public.tasks
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

-- connections
DROP POLICY IF EXISTS "connections owner select" ON public.connections;
CREATE POLICY "connections owner select" ON public.connections
  FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
CREATE POLICY "connections owner insert" ON public.connections
  FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "connections owner update" ON public.connections;
CREATE POLICY "connections owner update" ON public.connections
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "connections owner delete" ON public.connections;
CREATE POLICY "connections owner delete" ON public.connections
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
        AND p.deleted_at IS NULL
    )
  );

-- user_preferences
DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
CREATE POLICY "Users can view own preferences" ON public.user_preferences
  FOR SELECT
  TO public
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
CREATE POLICY "Users can insert own preferences" ON public.user_preferences
  FOR INSERT
  TO public
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
CREATE POLICY "Users can update own preferences" ON public.user_preferences
  FOR UPDATE
  TO public
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own preferences" ON public.user_preferences;
CREATE POLICY "Users can delete own preferences" ON public.user_preferences
  FOR DELETE
  TO public
  USING ((select auth.uid()) = user_id);

-- task_tombstones
DROP POLICY IF EXISTS "task_tombstones_select_owner" ON public.task_tombstones;
CREATE POLICY "task_tombstones_select_owner" ON public.task_tombstones
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = task_tombstones.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "task_tombstones_insert_owner" ON public.task_tombstones;
CREATE POLICY "task_tombstones_insert_owner" ON public.task_tombstones
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = task_tombstones.project_id
        AND p.owner_id = (select auth.uid())
    )
  );
-- ============================================================
-- [MIGRATION] 20251212_prevent_task_resurrection.sql
-- ============================================================
-- ============================================
-- 阻止“永久删除任务”被旧端 upsert 复活
-- 日期: 2025-12-12
-- ============================================
--
-- 背景：
-- 1) 物理 DELETE 后，如果某个离线/旧版本客户端仍持有该 task 并执行 upsert，
--    Postgres 会将其当作 INSERT，从而把任务“插回”云端（复活）。
-- 2) 解决思路：为“永久删除”建立不可逆 tombstone。
--    - purge RPC：写入 tombstone + 删除 tasks 行（以及相关 connections）。
--    - trigger：拦截对 tombstoned task_id 的 INSERT/UPDATE，直接丢弃写入，避免复活。

-- 注意：task_tombstones 表及相关 RLS 策略已在文件早期（第 248 行附近）创建

-- 2) purge RPC：批量永久删除任务（写 tombstone + 删除 tasks + 删除相关 connections）
CREATE OR REPLACE FUNCTION public.purge_tasks(p_task_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  purged_count integer;
BEGIN
  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  WITH to_purge AS (
    SELECT t.id AS task_id, t.project_id
    FROM public.tasks t
    JOIN public.projects p ON p.id = t.project_id
    WHERE t.id = ANY(p_task_ids)
      AND p.owner_id = auth.uid()
  ),
  ins AS (
    INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
    SELECT task_id, project_id, now(), auth.uid()
    FROM to_purge
    ON CONFLICT (task_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING task_id
  ),
  del_connections AS (
    DELETE FROM public.connections c
    USING to_purge tp
    WHERE c.project_id = tp.project_id
      AND (c.source_id = tp.task_id OR c.target_id = tp.task_id)
  ),
  del_tasks AS (
    DELETE FROM public.tasks t
    USING to_purge tp
    WHERE t.id = tp.task_id
    RETURNING t.id
  )
  SELECT count(*) INTO purged_count FROM del_tasks;

  RETURN COALESCE(purged_count, 0);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_tasks(uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tasks(uuid[]) TO service_role;

-- safe_delete_tasks: 安全删除任务（软删除+限制）
CREATE OR REPLACE FUNCTION public.safe_delete_tasks(p_task_ids uuid[], p_project_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  deleted_count integer;
  total_tasks integer;
BEGIN
  -- 参数校验
  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 获取项目总任务数
  SELECT count(*) INTO total_tasks
  FROM public.tasks
  WHERE project_id = p_project_id AND deleted_at IS NULL;

  -- 限制：单次最多删除 50 条或 50% 的任务
  IF array_length(p_task_ids, 1) > 50 THEN
    RAISE EXCEPTION 'Cannot delete more than 50 tasks at once';
  END IF;

  IF array_length(p_task_ids, 1) > (total_tasks * 0.5) THEN
    RAISE EXCEPTION 'Cannot delete more than 50%% of tasks at once';
  END IF;

  -- 软删除任务
  WITH del AS (
    UPDATE public.tasks
    SET deleted_at = now()
    WHERE id = ANY(p_task_ids)
      AND project_id = p_project_id
      AND deleted_at IS NULL
    RETURNING id
  )
  SELECT count(*) INTO deleted_count FROM del;

  RETURN COALESCE(deleted_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated;

-- purge_tasks_v3: 永久删除任务并返回附件路径（带速率限制）
CREATE OR REPLACE FUNCTION public.purge_tasks_v3(p_project_id uuid, p_task_ids uuid[])
RETURNS purge_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  result purge_result;
  v_owner_id uuid;
  task_record RECORD;
  attachment jsonb;
  attachment_paths text[] := ARRAY[]::text[];
  file_ext text;
  current_user_id uuid;
  rate_limit_record RECORD;
  max_calls_per_minute CONSTANT integer := 10;
  max_tasks_per_call CONSTANT integer := 100;
BEGIN
  result.purged_count := 0;
  result.attachment_paths := ARRAY[]::text[];
  current_user_id := auth.uid();

  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN result;
  END IF;

  -- 速率限制检查
  IF array_length(p_task_ids, 1) > max_tasks_per_call THEN
    RAISE EXCEPTION 'Too many tasks in single request. Maximum: %', max_tasks_per_call;
  END IF;

  -- 检查并更新调用次数
  INSERT INTO public.purge_rate_limits (user_id, call_count, window_start)
  VALUES (current_user_id, 1, now())
  ON CONFLICT (user_id) DO UPDATE SET
    call_count = CASE
      WHEN purge_rate_limits.window_start < now() - interval '1 minute'
      THEN 1
      ELSE purge_rate_limits.call_count + 1
    END,
    window_start = CASE
      WHEN purge_rate_limits.window_start < now() - interval '1 minute'
      THEN now()
      ELSE purge_rate_limits.window_start
    END
  RETURNING call_count INTO rate_limit_record;

  IF rate_limit_record.call_count > max_calls_per_minute THEN
    RAISE EXCEPTION 'Rate limit exceeded. Maximum % calls per minute', max_calls_per_minute;
  END IF;

  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT p.owner_id INTO v_owner_id
  FROM public.projects p
  WHERE p.id = p_project_id;

  -- 收集附件路径
  FOR task_record IN
    SELECT t.id AS task_id, t.attachments
    FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
      AND t.attachments IS NOT NULL
      AND jsonb_array_length(t.attachments) > 0
  LOOP
    FOR attachment IN SELECT * FROM jsonb_array_elements(task_record.attachments)
    LOOP
      file_ext := COALESCE(
        NULLIF(SUBSTRING((attachment->>'name') FROM '\\.([^.]+)$'), ''),
        'bin'
      );

      attachment_paths := array_append(
        attachment_paths,
        v_owner_id::text || '/' ||
        p_project_id::text || '/' ||
        task_record.task_id::text || '/' ||
        (attachment->>'id') || '.' || file_ext
      );

      IF attachment->>'thumbnailUrl' IS NOT NULL THEN
        attachment_paths := array_append(
          attachment_paths,
          v_owner_id::text || '/' ||
          p_project_id::text || '/' ||
          task_record.task_id::text || '/' ||
          (attachment->>'id') || '_thumb.webp'
        );
      END IF;
    END LOOP;
  END LOOP;

  -- 仅为当前 project 中真实存在的任务落 tombstone，禁止跨项目污染
  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT purge_scope.task_id, p_project_id, now(), auth.uid()
  FROM (
    SELECT candidate.task_id
    FROM (
      SELECT t.id AS task_id
      FROM public.tasks t
      WHERE t.project_id = p_project_id
        AND t.id = ANY(p_task_ids)

      UNION

      SELECT tt.task_id
      FROM public.task_tombstones tt
      WHERE tt.project_id = p_project_id
        AND tt.task_id = ANY(p_task_ids)
    ) AS candidate
  ) AS purge_scope
  ON CONFLICT (task_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  -- 中文注释：任务 purge 会直接带走关联连接，必须先显式落 connection tombstone，避免另一端长期残留旧连接。
  INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
  SELECT c.id, c.project_id, now(), auth.uid()
  FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids))
  ON CONFLICT (connection_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  -- 删除相关连接
  DELETE FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids));

  -- 删除 tasks 行
  WITH del AS (
    DELETE FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
    RETURNING t.id
  )
  SELECT count(*) INTO result.purged_count FROM del;

  result.attachment_paths := attachment_paths;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO authenticated;

-- 3) 防复活触发器：拦截对已 tombstone task_id 的 INSERT/UPDATE
CREATE OR REPLACE FUNCTION public.prevent_tombstoned_task_writes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.task_tombstones tt
    WHERE tt.task_id = NEW.id
  ) THEN
    -- 静默丢弃写入，避免旧端 upsert 复活
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.prevent_tombstoned_task_writes()
  SET search_path TO 'pg_catalog', 'public';

DROP TRIGGER IF EXISTS trg_prevent_tombstoned_task_writes ON public.tasks;
CREATE TRIGGER trg_prevent_tombstoned_task_writes
BEFORE INSERT OR UPDATE ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.prevent_tombstoned_task_writes();
-- ============================================================
-- [MIGRATION] 20251212_purge_tasks_v2.sql
-- ============================================================
-- ============================================
-- purge_tasks_v2: 支持在 tasks 行不存在时也能落 tombstone
-- 日期: 2025-12-12
-- ============================================
-- 目的：
-- - 客户端“永久删除”时，优先写入不可逆 tombstone，阻断旧端/离线端 upsert 复活。
-- - 即使 tasks 行已不存在（例如历史物理删除），也能通过 project_id 强制落 tombstone。

-- 注意：purge_tasks_v2 函数已在前面定义（第 708 行）

-- 授予额外的权限
GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO service_role;
-- ============================================================
-- [MIGRATION] 20251213_tombstone_aware_task_loading.sql
-- ============================================================
-- ============================================
-- Tombstone-aware task loading optimization
-- 日期: 2025-12-13
-- ============================================
--
-- 背景：
-- - 修复了"电脑端删除的任务在手机端登录后恢复"的问题
-- - 原因：loadTasks 函数没有检查 task_tombstones 表，也没有过滤软删除的任务
-- - 解决方案：
--   1. 在 loadTasks 中同时检查 tombstone 和 deleted_at
--   2. 创建辅助视图和函数简化客户端查询
--   3. 添加性能索引
--
-- 优化：
-- - 创建视图简化客户端查询
-- - 添加性能索引
-- - 确保 RLS 策略正确应用
--
-- 修复的具体问题：
-- 1. 永久删除的任务（有 tombstone）在其他设备上复活
-- 2. 软删除的任务（deleted_at 不为 null）在其他设备上复活
-- 3. 待分配任务（stage = null）的删除也会在其他设备上恢复

-- 1) 创建视图：自动过滤已 tombstone 和软删除的任务
CREATE OR REPLACE VIEW public.active_tasks AS
SELECT t.*
FROM public.tasks t
WHERE NOT EXISTS (
  SELECT 1
  FROM public.task_tombstones tt
  WHERE tt.task_id = t.id
)
AND t.deleted_at IS NULL;

-- 为视图设置 RLS（继承基表的 RLS）
ALTER VIEW public.active_tasks SET (security_invoker = true);

COMMENT ON VIEW public.active_tasks IS '
自动过滤已被永久删除（tombstone）和软删除（deleted_at 不为 null）的任务的视图。
客户端应优先使用此视图而非直接查询 tasks 表，以避免已删除任务复活。
此视图解决了以下问题：
1. 永久删除的任务在其他设备上复活
2. 软删除的任务在其他设备上复活
3. 待分配任务（stage = null）的删除也会在其他设备上恢复
';

-- 1.1) 创建 active_connections 视图：对应 active_tasks（2026-01-07 补齐）
CREATE OR REPLACE VIEW public.active_connections AS
SELECT
    c.id,
    c.project_id,
    c.source_id,
    c.target_id,
    c.title,
    c.description,
    c.created_at,
    c.updated_at,
    c.deleted_at
FROM public.connections c
WHERE NOT EXISTS (
    SELECT 1
    FROM public.connection_tombstones ct
    WHERE ct.connection_id = c.id
)
AND c.deleted_at IS NULL;

ALTER VIEW public.active_connections SET (security_invoker = true);

COMMENT ON VIEW public.active_connections IS '
Tombstone-aware 连接加载视图 - 过滤掉已永久删除的连接和软删除的连接。
与 active_tasks 视图逻辑一致，客户端应优先使用此视图而非直接查询 connections 表。
创建于 2026-01-07。
';

REVOKE ALL ON TABLE public.active_connections FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.active_connections FROM authenticated;
GRANT SELECT ON TABLE public.active_connections TO authenticated;
GRANT ALL ON TABLE public.active_connections TO service_role;

-- 2) 创建辅助函数：批量检查任务是否在 tombstone 中
CREATE OR REPLACE FUNCTION public.is_task_tombstoned(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.task_tombstones AS tombstone
    JOIN public.projects AS project ON project.id = tombstone.project_id
    WHERE tombstone.task_id = p_task_id
      AND (
        project.owner_id = (SELECT auth.uid())
        OR current_user = 'service_role'
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_task_tombstoned(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) TO service_role;

COMMENT ON FUNCTION public.is_task_tombstoned IS '
检查指定任务是否已被永久删除（在 tombstone 表中）。
返回 true 表示该任务已被永久删除，不应被恢复或显示。
';

-- 4) 数据一致性检查：查找存在 tombstone 但仍有 tasks 行的数据
-- （这些数据理论上不应存在，因为 purge RPC 会同时删除）
DO $$
DECLARE
  inconsistent_count integer;
BEGIN
  SELECT COUNT(*) INTO inconsistent_count
  FROM public.task_tombstones tt
  INNER JOIN public.tasks t ON t.id = tt.task_id;

  IF inconsistent_count > 0 THEN
    RAISE WARNING 'Found % tasks that exist in both tasks and task_tombstones tables. Consider running cleanup.', inconsistent_count;
  END IF;
END $$;
-- ============================================================
-- [MIGRATION] 20251215_sync_mechanism_hardening.sql
-- ============================================================
-- ============================================================================
-- 同步机制强化迁移脚本
-- 创建日期: 2025-12-15
-- 目的:
--   1. 为 user_preferences 表启用 REPLICA IDENTITY FULL
--   2. 添加缺失的索引以优化实时同步性能
--   3. 强化数据完整性约束
-- ============================================================================

-- ============================================================================
-- 1. 为 user_preferences 启用 REPLICA IDENTITY FULL
-- 这确保 Supabase Realtime 的 DELETE 事件能够返回完整的行数据
-- 没有这个设置，DELETE 事件只会返回主键，导致前端无法正确处理删除
-- ============================================================================
ALTER TABLE public.user_preferences REPLICA IDENTITY FULL;

-- 验证设置（通过注释记录，实际验证需要在 psql 中执行）
-- SELECT relreplident FROM pg_class WHERE relname = 'user_preferences';
-- 期望返回 'f' (full)

-- ============================================================================
-- 2. 为实时同步添加优化索引
-- 这些索引优化 Realtime 订阅的过滤查询
-- ============================================================================

-- 优化 projects 表的 owner_id + updated_at/id 查询（如果不存在）
CREATE INDEX IF NOT EXISTS idx_projects_owner_updated_id
ON public.projects(owner_id, updated_at, id);

-- 优化 tasks 表的 project_id + updated_at 查询
CREATE INDEX IF NOT EXISTS idx_tasks_project_updated_id
ON public.tasks(project_id, updated_at, id);

-- user_preferences.user_id 已由 UNIQUE(user_id) 的唯一 B-tree 索引覆盖。

-- ============================================================================
-- 3. 添加用于冲突检测的 updated_at 触发器（如果不存在）
-- 确保每次更新都会自动更新 updated_at 字段
-- ============================================================================

-- 创建通用的 updated_at 触发器函数
CREATE OR REPLACE FUNCTION public.trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.trigger_set_updated_at()
  SET search_path TO 'pg_catalog', 'public';

-- 为 projects 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.projects;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- 为 tasks 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.tasks;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- 为 connections 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.connections;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- 为 user_preferences 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.user_preferences;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- ============================================================================
-- 4. 添加版本号自动递增约束
-- 防止版本号回退，用于乐观锁冲突检测
-- ============================================================================

-- 创建版本号验证函数
CREATE OR REPLACE FUNCTION public.check_version_increment()
RETURNS TRIGGER AS $$
BEGIN
  -- 只在版本号存在且被修改时检查
  IF OLD.version IS NOT NULL AND NEW.version IS NOT NULL THEN
    -- 允许版本号增加或保持不变（用于冲突解决后的强制覆盖）
    -- 但不允许回退
    IF NEW.version < OLD.version THEN
      RAISE WARNING 'Version regression detected: % -> %, allowing update but logging', OLD.version, NEW.version;
      -- 注意：这里只是警告，不阻止更新，因为冲突解决可能需要这样做
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.check_version_increment()
  SET search_path TO 'pg_catalog', 'public';

-- 为 projects 表添加版本检查触发器
DROP TRIGGER IF EXISTS check_version_increment ON public.projects;
CREATE TRIGGER check_version_increment
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.check_version_increment();

-- ============================================================================
-- 5. 添加死锁预防索引
-- 确保并发更新时有一致的锁定顺序
-- ============================================================================

-- 添加 tasks 表的 id 索引用于批量更新
CREATE INDEX IF NOT EXISTS idx_tasks_id_project_id
ON public.tasks(id, project_id);

-- 添加 connections 表的复合索引用于批量删除
CREATE INDEX IF NOT EXISTS idx_connections_source_target
ON public.connections(source_id, target_id);

-- ============================================================================
-- 6. RPC 批量加载优化索引（2026-01-27）
-- 覆盖 get_full_project_data RPC 的查询模式
-- ============================================================================

-- 任务表：默认项目加载使用不可变 created_at + id 稳定顺序
CREATE INDEX IF NOT EXISTS idx_tasks_project_created_id
ON public.tasks (project_id, created_at, id);

-- ============================================================================
-- 完成
-- ============================================================================
COMMENT ON TABLE public.projects IS '项目表 - REPLICA IDENTITY FULL for Realtime';
COMMENT ON TABLE public.tasks IS '任务表 - REPLICA IDENTITY FULL for Realtime';
COMMENT ON TABLE public.connections IS '连接表 - REPLICA IDENTITY FULL for Realtime';
COMMENT ON TABLE public.user_preferences IS '用户偏好表 - REPLICA IDENTITY FULL for Realtime';
-- ============================================================
-- [MIGRATION] 20251220_add_connection_soft_delete.sql
-- ============================================================
-- ============================================
-- 为 connections 表添加软删除支持
-- 日期: 2025-12-20
--
-- 目的：支持跨树连接的软删除同步
-- 解决问题：在一个设备上删除的连接，在其他设备上会因为同步逻辑问题而"复活"
--
-- 解决方案：使用 deleted_at 字段标记软删除状态，而不是物理删除
-- 这样删除操作可以正确同步到所有设备
-- ============================================

-- 1. 为 connections 表添加 deleted_at 列
ALTER TABLE public.connections
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- 2. 创建索引以加速查询未删除的连接
CREATE INDEX IF NOT EXISTS idx_connections_deleted_at
  ON public.connections (deleted_at)
  WHERE deleted_at IS NULL;

-- 3. 创建索引以加速查询需要清理的已删除连接
CREATE INDEX IF NOT EXISTS idx_connections_deleted_at_cleanup
  ON public.connections (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 4. 创建清理过期软删除连接的函数
CREATE OR REPLACE FUNCTION public.validate_task_data()
RETURNS TRIGGER AS $$
BEGIN
  -- 规则 1: 拒绝将 title 和 content 同时置空
  IF (NEW.title IS NULL OR NEW.title = '') AND (NEW.content IS NULL OR NEW.content = '') THEN
    -- 例外：软删除的任务允许
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Task must have either title or content (task_id: %)', NEW.id;
  END IF;

  -- 规则 2: stage 必须非负（如果有值）
  IF NEW.stage IS NOT NULL AND NEW.stage < 0 THEN
    RAISE EXCEPTION 'Invalid stage value: % (must be >= 0)', NEW.stage;
  END IF;

  -- 规则 3: rank 必须是正数（如果有值）
  IF NEW.rank IS NOT NULL AND NEW.rank < 0 THEN
    RAISE EXCEPTION 'Invalid rank value: % (must be >= 0)', NEW.rank;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.validate_task_data()
  SET search_path TO 'pg_catalog', 'public';

-- 删除旧触发器（如果存在）
DROP TRIGGER IF EXISTS trg_validate_task_data ON public.tasks;

-- 创建新触发器
CREATE TRIGGER trg_validate_task_data
BEFORE INSERT OR UPDATE ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.validate_task_data();

-- ============================================
-- 审计日志表
-- 记录所有熔断操作（阻止和通过的）
-- ============================================
CREATE TABLE IF NOT EXISTS public.circuit_breaker_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  operation text NOT NULL,
  blocked boolean NOT NULL DEFAULT false,
  reason text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 创建索引加速查询
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_logs_user_id ON public.circuit_breaker_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_logs_created_at ON public.circuit_breaker_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_logs_blocked ON public.circuit_breaker_logs(blocked) WHERE blocked = true;

-- RLS 策略：只能查看自己的日志
ALTER TABLE public.circuit_breaker_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS circuit_breaker_logs_select_own ON public.circuit_breaker_logs;
CREATE POLICY circuit_breaker_logs_select_own ON public.circuit_breaker_logs
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

-- 不允许用户直接删除日志（审计日志需保留）
-- INSERT 由 RPC 函数内部执行（SECURITY DEFINER 绕过 RLS）

-- ============================================
-- 授权
-- ============================================
GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated;

-- ============================================
-- 注释
-- ============================================
COMMENT ON FUNCTION public.safe_delete_tasks(uuid[], uuid) IS
  '安全的批量删除任务 RPC。限制：单次最多删除 50 条或 50% 的任务。';
COMMENT ON FUNCTION public.validate_task_data() IS
  '任务数据校验触发器。确保 title/content 不同时为空，stage/rank 为有效值。';
COMMENT ON TABLE public.circuit_breaker_logs IS
  '熔断操作审计日志。记录所有批量删除操作（包括被阻止和成功的）。';
-- ============================================================
-- [MIGRATION] 20260101000001_connection_tombstones.sql (已移至早期位置)
-- ============================================================
-- 注意：connection_tombstones 表及相关函数已在文件早期（第 271 行附近）创建
-- 此处保留迁移标记以维护版本历史完整性
-- ============================================================
-- [MIGRATION] 20260101000002_batch_upsert_tasks_attachments.sql
-- ============================================================
-- batch_upsert_tasks 函数：批量 upsert 任务主字段，附件变更仅允许走专用 RPC
-- 用于批量操作的事务保护（≥20 个任务）
--
-- v6.0.0 修正：新增 parking_meta, expected_minutes, cognitive_load, wait_minutes 支持
--              新增安全校验：TEXT 长度限制、数值范围约束
-- v5.2.3 修正：移除不存在的 owner_id 列引用，通过 project.owner_id 进行权限校验
-- 安全特性：
-- 1. SECURITY DEFINER + auth.uid() 权限校验
-- 2. 只能操作自己的项目和任务（通过 projects.owner_id 校验）
-- 3. 事务保证原子性
-- 4. TEXT 长度限制防 DoS / 数据溢出
-- 5. 数值范围约束防溢出

CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(
  p_tasks jsonb[],
  p_project_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_count integer := 0;
  v_task jsonb;
  v_user_id uuid;
  v_title text;
  v_content text;
  v_has_attachments boolean;
  v_has_tags boolean;
  v_priority text;
  v_due_date timestamptz;
  v_completed_at timestamptz;
  v_cognitive text;
  v_expected int;
  v_wait int;
BEGIN
  -- 权限校验
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
  END IF;

  -- 附件只能通过专用 RPC 变更，批量 upsert 仅允许 owner 写任务主字段
  IF NOT public.user_is_project_owner(p_project_id) THEN
    RAISE EXCEPTION 'Unauthorized: not project owner';
  END IF;

  FOREACH v_task IN ARRAY p_tasks
  LOOP
    -- 安全校验：TEXT 长度限制（防 DoS / 数据溢出）
    v_title := v_task->>'title';
    v_content := v_task->>'content';
    v_has_attachments := v_task ? 'attachments';
    v_has_tags := v_task ? 'tags';
    IF v_title IS NOT NULL AND length(v_title) > 10000 THEN
      RAISE EXCEPTION 'Title too long (max 10000 chars) for task %', v_task->>'id';
    END IF;
    IF v_content IS NOT NULL AND length(v_content) > 1000000 THEN
      RAISE EXCEPTION 'Content too long (max 1000000 chars) for task %', v_task->>'id';
    END IF;

    -- 安全校验：数值范围
    v_expected := (v_task->>'expectedMinutes')::integer;
    v_wait := (v_task->>'waitMinutes')::integer;
    v_cognitive := v_task->>'cognitiveLoad';
    v_priority := NULLIF(v_task->>'priority', '');
    v_due_date := NULLIF(COALESCE(v_task->>'dueDate', v_task->>'due_date'), '')::timestamptz;
    v_completed_at := NULLIF(COALESCE(v_task->>'completedAt', v_task->>'completed_at'), '')::timestamptz;

    IF v_expected IS NOT NULL AND (v_expected <= 0 OR v_expected > 14400) THEN
      RAISE EXCEPTION 'expected_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_wait IS NOT NULL AND (v_wait <= 0 OR v_wait > 14400) THEN
      RAISE EXCEPTION 'wait_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_cognitive IS NOT NULL AND v_cognitive NOT IN ('low', 'high') THEN
      RAISE EXCEPTION 'cognitive_load must be low or high for task %', v_task->>'id';
    END IF;

    INSERT INTO public.tasks AS existing (
      id, project_id, title, content, stage, parent_id,
      "order", rank, status, x, y, short_id, deleted_at,
      attachments, tags, priority, due_date, completed_at,
      expected_minutes, cognitive_load, wait_minutes, parking_meta
    )
    VALUES (
      (v_task->>'id')::uuid,
      p_project_id,
      v_title,
      v_content,
      (v_task->>'stage')::integer,
      (v_task->>'parentId')::uuid,
      COALESCE((v_task->>'order')::integer, 0),
      COALESCE((v_task->>'rank')::numeric, 10000),
      COALESCE(v_task->>'status', 'active'),
      COALESCE((v_task->>'x')::numeric, 0),
      COALESCE((v_task->>'y')::numeric, 0),
      v_task->>'shortId',
      (v_task->>'deletedAt')::timestamptz,
      CASE WHEN v_has_attachments THEN COALESCE(v_task->'attachments', '[]'::jsonb) ELSE '[]'::jsonb END,
      CASE WHEN v_has_tags THEN COALESCE(v_task->'tags', '[]'::jsonb) ELSE '[]'::jsonb END,
      v_priority,
      v_due_date,
      v_completed_at,
      v_expected,
      v_cognitive,
      v_wait,
      v_task->'parkingMeta'
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      stage = EXCLUDED.stage,
      parent_id = EXCLUDED.parent_id,
      "order" = EXCLUDED."order",
      rank = EXCLUDED.rank,
      status = EXCLUDED.status,
      x = EXCLUDED.x,
      y = EXCLUDED.y,
      short_id = EXCLUDED.short_id,
      deleted_at = EXCLUDED.deleted_at,
      attachments = CASE
        WHEN NOT v_has_attachments THEN existing.attachments
        ELSE EXCLUDED.attachments
      END,
      tags = CASE
        WHEN NOT v_has_tags THEN existing.tags
        ELSE EXCLUDED.tags
      END,
      priority = EXCLUDED.priority,
      due_date = EXCLUDED.due_date,
      completed_at = EXCLUDED.completed_at,
      expected_minutes = EXCLUDED.expected_minutes,
      cognitive_load = EXCLUDED.cognitive_load,
      wait_minutes = EXCLUDED.wait_minutes,
      parking_meta = EXCLUDED.parking_meta,
      updated_at = NOW()
    WHERE existing.project_id = p_project_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Task project mismatch';
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$;

-- 授权
GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;

COMMENT ON FUNCTION public.batch_upsert_tasks IS 'Owner-only batch upsert for task core fields. Attachments stay on dedicated append/remove RPCs (v6.0.1).';
-- ============================================================
-- [MIGRATION] 20260101000003_optimistic_lock_strict_mode.sql
-- ============================================================
-- 乐观锁强化：版本冲突从警告改为拒绝
--
-- 变更说明：
-- 1. 修改 check_version_increment() 函数，启用严格模式
-- 2. 版本回退时直接抛出异常，拒绝更新
-- 3. 记录到 circuit_breaker_logs 以便调试

COMMENT ON FUNCTION public.check_version_increment IS 'Strict optimistic lock: rejects version regression instead of just warning. Logs to circuit_breaker_logs.';
-- ============================================================
-- [MIGRATION] 20260101000004_attachment_count_limit.sql
-- ============================================================
-- ============================================
-- 附件数量服务端限制
-- 日期：2026-01-01
--
-- 问题背景：
-- - 客户端限制可被绕过（通过直接 API 调用）
-- - 需要在服务端强制执行附件数量限制
-- ============================================

-- 定义最大附件数量常量
-- 与客户端 ATTACHMENT_CONFIG.MAX_ATTACHMENTS_PER_TASK 保持一致
DO $$
BEGIN
  -- 创建配置表（如果不存在）
  CREATE TABLE IF NOT EXISTS public.app_config (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );

  -- 插入附件数量限制配置
  INSERT INTO public.app_config (key, value, description)
  VALUES ('max_attachments_per_task', '20', '每个任务最大附件数量')
  ON CONFLICT (key) DO NOTHING;
END $$;

-- 为配置表启用 RLS 并设置只读策略（认证用户可读）
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "app_config_select" ON public.app_config;
CREATE POLICY "app_config_select" ON public.app_config
  FOR SELECT TO authenticated
  USING (true);

-- 更新 append_task_attachment 函数，添加数量限制检查
COMMENT ON FUNCTION public.purge_tasks_v3 IS
'永久删除任务并返回附件存储路径。客户端需要调用 Storage API 删除返回的路径。';
-- ============================================================
-- [MIGRATION] 20260102000001_virus_scan_and_rls_fix.sql
-- ============================================================
-- ============================================
-- 病毒扫描表 + cleanup_logs RLS 修复
-- 版本: v5.12
-- ============================================

-- ============================================
-- 1. 创建病毒扫描记录表
-- ============================================

-- 存储文件扫描结果
CREATE TABLE IF NOT EXISTS public.attachment_scans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  file_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_hash VARCHAR(64), -- SHA-256 哈希
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  threat_name VARCHAR(255),
  threat_description TEXT,
  scanner VARCHAR(50) NOT NULL DEFAULT 'clamav',
  engine_version VARCHAR(50),
  signature_version VARCHAR(50),
  scanned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  rescan_token UUID,
  rescan_started_at TIMESTAMP WITH TIME ZONE,
  next_rescan_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- 约束
  CONSTRAINT valid_status CHECK (status IN ('pending', 'scanning', 'clean', 'threat_detected', 'failed', 'quarantined', 'skipped')),
  CONSTRAINT attachment_scans_user_file_key UNIQUE (user_id, file_id)
);

-- 旧 schema 幂等升级：CREATE TABLE IF NOT EXISTS 不会为已有表补列。
ALTER TABLE public.attachment_scans
  ADD COLUMN IF NOT EXISTS rescan_token UUID,
  ADD COLUMN IF NOT EXISTS rescan_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_rescan_at TIMESTAMPTZ;

WITH ownership_matches AS (
  SELECT DISTINCT
    s.id AS scan_id,
    p.owner_id AS user_id
  FROM public.attachment_scans s
  JOIN public.tasks t ON true
  JOIN public.projects p ON p.id = t.project_id
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.attachments, '[]'::jsonb)) AS attachment
  WHERE s.user_id IS NULL
    AND attachment->'scanMetadata'->>'fileId' = s.file_id::text
), ownership_candidates AS (
  SELECT
    scan_id,
    user_id,
    count(*) OVER (PARTITION BY scan_id) AS owner_count
  FROM ownership_matches
), unique_ownership AS (
  SELECT scan_id, user_id
  FROM ownership_candidates
  WHERE owner_count = 1
)
UPDATE public.attachment_scans s
SET user_id = ownership.user_id
FROM unique_ownership ownership
WHERE s.id = ownership.scan_id
  AND s.user_id IS NULL;

DELETE FROM public.attachment_scans
WHERE user_id IS NULL;

WITH ranked_scans AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY user_id, file_id
      ORDER BY updated_at DESC NULLS LAST, scanned_at DESC NULLS LAST, id DESC
    ) AS duplicate_rank
  FROM public.attachment_scans
)
DELETE FROM public.attachment_scans scans
USING ranked_scans ranked
WHERE scans.id = ranked.id
  AND ranked.duplicate_rank > 1;

ALTER TABLE public.attachment_scans
  ALTER COLUMN user_id SET NOT NULL;

DROP INDEX IF EXISTS public.idx_attachment_scans_user_file;

DO $attachment_scan_owner$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.attachment_scans'::regclass
      AND conname = 'attachment_scans_user_file_key'
  ) THEN
    ALTER TABLE public.attachment_scans
      ADD CONSTRAINT attachment_scans_user_file_key UNIQUE (user_id, file_id);
  END IF;
END
$attachment_scan_owner$;

UPDATE public.attachment_scans
SET next_rescan_at = COALESCE(scanned_at, updated_at, created_at, now()) + interval '7 days'
WHERE next_rescan_at IS NULL;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_attachment_scans_file_id ON public.attachment_scans(file_id);
CREATE INDEX IF NOT EXISTS idx_attachment_scans_due_claim
  ON public.attachment_scans (next_rescan_at, id)
  WHERE status IN ('clean', 'failed', 'scanning');
CREATE INDEX IF NOT EXISTS idx_attachment_scans_status ON public.attachment_scans(status);
CREATE INDEX IF NOT EXISTS idx_attachment_scans_scanned_at ON public.attachment_scans(scanned_at);
CREATE INDEX IF NOT EXISTS idx_attachment_scans_file_hash ON public.attachment_scans(file_hash);

-- 启用 RLS
ALTER TABLE public.attachment_scans ENABLE ROW LEVEL SECURITY;

-- RLS 策略：仅 service_role 可访问扫描记录
-- 前端通过 Edge Function 间接访问
DROP POLICY IF EXISTS "attachment_scans_service_only" ON public.attachment_scans;
CREATE POLICY "attachment_scans_service_only" ON public.attachment_scans
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.claim_attachment_scan_rescan(
  p_file_id UUID,
  p_user_id UUID,
  p_min_interval_seconds INTEGER DEFAULT 60,
  p_stale_after_seconds INTEGER DEFAULT 900
)
RETURNS TABLE (
  claimed BOOLEAN,
  token UUID,
  reason TEXT,
  current_status TEXT,
  retry_after_seconds INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_scan public.attachment_scans%ROWTYPE;
  v_token UUID := gen_random_uuid();
  v_retry_after INTEGER := 0;
BEGIN
  SELECT *
  INTO v_scan
  FROM public.attachment_scans scans
  WHERE scans.file_id = p_file_id
    AND scans.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::UUID, 'not_found'::TEXT, NULL::TEXT, 0;
    RETURN;
  END IF;

  IF v_scan.status = 'scanning'
    AND v_scan.rescan_started_at IS NOT NULL
    AND v_scan.rescan_started_at > now() - make_interval(secs => GREATEST(p_stale_after_seconds, 1)) THEN
    v_retry_after := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (
        v_scan.rescan_started_at
        + make_interval(secs => GREATEST(p_stale_after_seconds, 1))
        - now()
      )))::INTEGER
    );
    RETURN QUERY SELECT false, NULL::UUID, 'in_progress'::TEXT, v_scan.status, v_retry_after;
    RETURN;
  END IF;

  IF v_scan.rescan_started_at IS NOT NULL
    AND v_scan.rescan_started_at > now() - make_interval(secs => GREATEST(p_min_interval_seconds, 0)) THEN
    v_retry_after := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (
        v_scan.rescan_started_at
        + make_interval(secs => GREATEST(p_min_interval_seconds, 0))
        - now()
      )))::INTEGER
    );
    RETURN QUERY SELECT false, NULL::UUID, 'rate_limited'::TEXT, v_scan.status, v_retry_after;
    RETURN;
  END IF;

  UPDATE public.attachment_scans scans
  SET
    status = 'scanning',
    rescan_token = v_token,
    rescan_started_at = now(),
    error_message = NULL,
    updated_at = now()
  WHERE scans.id = v_scan.id
    AND scans.rescan_token IS NOT DISTINCT FROM v_scan.rescan_token
    AND scans.updated_at IS NOT DISTINCT FROM v_scan.updated_at;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::UUID, 'claim_lost'::TEXT, v_scan.status, 1;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, v_token, 'claimed'::TEXT, 'scanning'::TEXT, 0;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_attachment_scan_rescan(UUID, UUID, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_attachment_scan_rescan(UUID, UUID, INTEGER, INTEGER)
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_due_attachment_scan_rescans(
  p_limit INTEGER DEFAULT 6,
  p_stale_after_seconds INTEGER DEFAULT 900
)
RETURNS TABLE (
  file_id UUID,
  user_id UUID,
  token UUID
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
  WITH candidates AS MATERIALIZED (
    SELECT scans.id
    FROM public.attachment_scans scans
    WHERE scans.next_rescan_at <= now()
      AND scans.status IN ('clean', 'failed', 'scanning')
      AND (
        scans.status <> 'scanning'
        OR scans.rescan_started_at IS NULL
        OR scans.rescan_started_at <= now() - make_interval(secs => GREATEST(p_stale_after_seconds, 1))
      )
    ORDER BY scans.next_rescan_at ASC, scans.id ASC
    FOR UPDATE OF scans SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 20)
  ), claimed AS (
    UPDATE public.attachment_scans scans
    SET
      status = 'scanning',
      rescan_token = gen_random_uuid(),
      rescan_started_at = now(),
      error_message = NULL,
      updated_at = now()
    FROM candidates
    WHERE scans.id = candidates.id
    RETURNING scans.file_id, scans.user_id, scans.rescan_token
  )
  SELECT claimed.file_id, claimed.user_id, claimed.rescan_token
  FROM claimed;
$$;

REVOKE ALL ON FUNCTION public.claim_due_attachment_scan_rescans(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_attachment_scan_rescans(INTEGER, INTEGER)
  TO service_role;

-- 隔离区表（可选，用于存储被隔离的恶意文件信息）
CREATE TABLE IF NOT EXISTS public.quarantined_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  original_file_id UUID NOT NULL,
  storage_path TEXT NOT NULL,
  threat_name VARCHAR(255) NOT NULL,
  threat_description TEXT,
  quarantined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  quarantined_by UUID REFERENCES auth.users(id),
  expires_at TIMESTAMP WITH TIME ZONE,
  restored BOOLEAN DEFAULT FALSE,
  restored_at TIMESTAMP WITH TIME ZONE,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_quarantined_files_expires_at ON public.quarantined_files(expires_at);
-- 【添加】quarantined_by FK 约束索引（2026-03-18 v6.3.0: Advisor 全量解决）
CREATE INDEX IF NOT EXISTS idx_quarantined_files_quarantined_by ON public.quarantined_files(quarantined_by);
COMMENT ON INDEX idx_quarantined_files_quarantined_by IS
  'FK enforcement: quarantined_by references auth.users(id). ON DELETE SET NULL.';
ALTER TABLE public.quarantined_files ENABLE ROW LEVEL SECURITY;

-- RLS 策略：仅 service_role 可访问隔离区
DROP POLICY IF EXISTS "quarantined_files_service_only" ON public.quarantined_files;
CREATE POLICY "quarantined_files_service_only" ON public.quarantined_files
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================
-- 2. 修复 cleanup_logs RLS（仅 service_role 可访问）
-- 问题：当前策略 USING(true) 允许任意认证用户读写日志
-- ============================================

-- 删除旧的宽松策略
DROP POLICY IF EXISTS "cleanup_logs select" ON public.cleanup_logs;
DROP POLICY IF EXISTS "cleanup_logs insert" ON public.cleanup_logs;
DROP POLICY IF EXISTS "cleanup_logs_select_policy" ON public.cleanup_logs;

-- 创建新的限制性策略：仅 service_role 可访问
-- 这意味着普通用户无法直接访问日志，只能通过 Edge Function
CREATE POLICY "cleanup_logs_service_role_select" ON public.cleanup_logs
  FOR SELECT TO service_role
  USING (true);

CREATE POLICY "cleanup_logs_service_role_insert" ON public.cleanup_logs
  FOR INSERT TO service_role
  WITH CHECK (true);

CREATE POLICY "cleanup_logs_service_role_delete" ON public.cleanup_logs
  FOR DELETE TO service_role
  USING (true);

-- ============================================
-- 3. 定期清理过期扫描记录的函数
-- ============================================

CREATE OR REPLACE FUNCTION public.cleanup_expired_scan_records()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT INTEGER := 5000;
  v_deleted_count INTEGER := 0;
  v_tmp_count INTEGER := 0;
BEGIN
  WITH routine_candidates AS MATERIALIZED (
    SELECT scans.id
    FROM public.attachment_scans AS scans
    WHERE scans.scanned_at < NOW() - INTERVAL '30 days'
      AND scans.status NOT IN ('threat_detected', 'quarantined')
    ORDER BY scans.scanned_at ASC, scans.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF scans SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.attachment_scans AS scans
    USING routine_candidates
    WHERE scans.id = routine_candidates.id
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER INTO v_deleted_count FROM deleted;

  WITH threat_candidates AS MATERIALIZED (
    SELECT scans.id
    FROM public.attachment_scans AS scans
    WHERE scans.scanned_at < NOW() - INTERVAL '90 days'
    ORDER BY scans.scanned_at ASC, scans.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF scans SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.attachment_scans AS scans
    USING threat_candidates
    WHERE scans.id = threat_candidates.id
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER INTO v_tmp_count FROM deleted;
  v_deleted_count := v_deleted_count + v_tmp_count;

  WITH quarantine_candidates AS MATERIALIZED (
    SELECT files.id
    FROM public.quarantined_files AS files
    WHERE files.expires_at < NOW()
      AND files.restored = FALSE
    ORDER BY files.expires_at ASC, files.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF files SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.quarantined_files AS files
    USING quarantine_candidates
    WHERE files.id = quarantine_candidates.id
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER INTO v_tmp_count FROM deleted;
  v_deleted_count := v_deleted_count + v_tmp_count;

  INSERT INTO public.cleanup_logs (type, details)
  VALUES ('scan_records', jsonb_build_object(
    'deleted_count', v_deleted_count,
    'cleaned_at', NOW()
  ));

  RETURN v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_scan_records()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_scan_records()
  TO service_role;

-- ============================================
-- 4. 更新触发器
-- ============================================

-- 自动更新 updated_at 时间戳
CREATE OR REPLACE FUNCTION public.update_attachment_scans_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.update_attachment_scans_timestamp()
  SET search_path TO 'pg_catalog', 'public';

DROP TRIGGER IF EXISTS trg_update_attachment_scans_timestamp ON public.attachment_scans;
CREATE TRIGGER trg_update_attachment_scans_timestamp
  BEFORE UPDATE ON public.attachment_scans
  FOR EACH ROW
  EXECUTE FUNCTION public.update_attachment_scans_timestamp();

-- ============================================
-- 5. 授予权限
-- ============================================

-- service_role 完全访问
GRANT ALL ON public.attachment_scans TO service_role;
GRANT ALL ON public.quarantined_files TO service_role;

-- 普通用户无直接访问权限（通过 Edge Function）
REVOKE ALL ON public.attachment_scans FROM authenticated;
REVOKE ALL ON public.quarantined_files FROM authenticated;

-- 函数执行权限
GRANT EXECUTE ON FUNCTION public.cleanup_expired_scan_records() TO service_role;
-- ============================================================
-- [MIGRATION] 20260102000010_batch_upsert_search_path_fix.sql
-- ============================================================
-- ============================================
-- 安全加固：为 batch_upsert_tasks 添加 search_path
-- 日期: 2026-01-02
-- 问题: batch_upsert_tasks 函数缺少 SET search_path，存在 search_path 注入风险
-- 解决: 添加 SET search_path TO 'pg_catalog', 'public' 与项目标准一致
-- ============================================

-- 为 batch_upsert_tasks 设置安全的 search_path
ALTER FUNCTION public.batch_upsert_tasks(jsonb[], uuid)
  SET search_path TO 'pg_catalog', 'public';

-- 验证说明（在 psql 中执行）:
-- SELECT proconfig FROM pg_proc WHERE proname = 'batch_upsert_tasks';
-- 期望返回包含 search_path=pg_catalog, public
-- ============================================================
-- [MIGRATION] 20260103000001_add_dashboard_rpc.sql
-- ============================================================
-- ============================================
-- Dashboard RPC 聚合函数
-- 减少流量：从 MB 级原始数据降至 ~200 Bytes JSON
-- ============================================
-- @see docs/plan_save.md Phase 1.3

-- 创建 Dashboard 统计聚合函数
-- 注意：tasks 表没有 user_id 列，必须通过 project.owner_id 关联查询
CREATE OR REPLACE FUNCTION public.get_dashboard_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'  -- 🔒 防止 search_path 注入攻击
AS $$
DECLARE
  current_user_id uuid := (SELECT auth.uid());
BEGIN
  -- 使用 initplan 缓存 user_id，避免每行重复计算
  -- 通过 project.owner_id 关联查询（tasks 表没有 user_id 列）
  RETURN json_build_object(
    'pending', (
      SELECT COUNT(*)
      FROM public.tasks t
      JOIN public.projects p ON t.project_id = p.id
      WHERE p.owner_id = current_user_id
        AND p.deleted_at IS NULL
        AND t.status = 'active'
        AND t.deleted_at IS NULL
    ),
    'completed', (
      SELECT COUNT(*)
      FROM public.tasks t
      JOIN public.projects p ON t.project_id = p.id
      WHERE p.owner_id = current_user_id
        AND p.deleted_at IS NULL
        AND t.status = 'completed'
        AND t.deleted_at IS NULL
    ),
    'projects', (SELECT COUNT(*) FROM public.projects WHERE owner_id = current_user_id AND deleted_at IS NULL)
  );
END;
$$;

-- 添加函数注释
COMMENT ON FUNCTION public.get_dashboard_stats() IS
  'Dashboard 统计聚合函数 - 返回用户的待处理任务数、已完成任务数和项目数。
   通过 project.owner_id 关联查询（tasks 表没有 user_id 列）。
   使用 SECURITY INVOKER 保持 projects/tasks RLS 生效。';

-- 授权：仅认证用户可调用
GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_dashboard_stats() FROM anon, public;
-- ============================================================
-- [MIGRATION] 20260103000002_rls_initplan_audit_fix.sql
-- ============================================================
-- ============================================
-- RLS 策略 initplan 优化审计修复
-- 日期: 2026-01-03
--
-- 问题: connection_tombstones 表的 RLS 策略未使用 (select auth.uid())
-- 影响: 每行都会重复计算 auth.uid()，影响性能
-- 解决: 使用 initplan 缓存 auth.uid() 值
--
-- @see docs/plan_save.md Phase 1.4
-- ============================================

-- 修复 connection_tombstones 表 RLS 策略
-- 使用 (select auth.uid()) 替代 auth.uid() 实现 initplan 优化

DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;
CREATE POLICY "connection_tombstones_select" ON public.connection_tombstones
  FOR SELECT TO authenticated
  USING (public.user_is_project_owner(project_id));

DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;
CREATE POLICY "connection_tombstones_insert" ON public.connection_tombstones
  FOR INSERT TO authenticated
  WITH CHECK (public.user_is_project_owner(project_id));

-- 更新相关函数的 auth.uid() 调用也使用 initplan
-- 注意：在函数中设置 search_path 以防止注入攻击

ALTER FUNCTION public.record_connection_tombstone()
  SET search_path = pg_catalog, public;

-- 添加 RLS 策略审计注释
COMMENT ON POLICY "connection_tombstones_select" ON public.connection_tombstones IS
  'SELECT 策略 - 使用 initplan 优化的 (select auth.uid())';

COMMENT ON POLICY "connection_tombstones_insert" ON public.connection_tombstones IS
  'INSERT 策略 - 使用 initplan 优化的 (select auth.uid())';
-- ============================================================
-- [MIGRATION] 20260103000003_add_get_server_time_rpc.sql
-- ============================================================
-- ============================================================
-- 添加 get_server_time RPC 函数
-- ============================================================
--
-- 用途：为客户端提供服务端时间，用于时钟偏移检测
-- 被调用：clock-sync.service.ts
--
-- 版本: 1.0.0
-- 日期: 2026-01-03
-- ============================================================

-- 创建获取服务端时间的 RPC 函数
-- 返回当前服务端 UTC 时间戳（ISO 8601 格式）
CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT NOW();
$$;

-- 仅允许明确角色执行（避免 PUBLIC 默认权限漂移）
REVOKE EXECUTE ON FUNCTION public.get_server_time() FROM PUBLIC;

-- 授予所有认证用户执行权限
GRANT EXECUTE ON FUNCTION public.get_server_time() TO authenticated;

-- 允许匿名用户执行（用于未登录时的时钟检测）
GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon;

-- ============================================================
-- [MIGRATION] 20260126100000_batch_load_optimization.sql
-- ============================================================
-- ============================================================
-- 性能优化：批量加载 RPC 函数
-- ============================================================
--
-- 优化目标：
--   - 将 4+ 个 API 请求合并为 1 个 RPC 调用
--   - 减少 70% 的网络往返时间
--   - 首屏加载时间提升 3-4 秒
--
-- 版本: 1.0.0
-- 日期: 2026-01-26
-- ============================================================

-- 批量加载项目完整数据 RPC
-- 合并 projects + tasks + connections + tombstones 为单次请求
CREATE OR REPLACE FUNCTION public.get_full_project_data(p_project_id UUID)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  -- 获取当前用户 ID
  v_user_id := auth.uid();

  -- 权限检查：个人版仅允许 owner 访问
  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'Access denied to project %', p_project_id;
  END IF;

  -- 构建完整项目数据（单次查询）
  SELECT json_build_object(
    'project', (
      SELECT row_to_json(p.*)
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, deleted_at, version
        FROM public.projects WHERE id = p_project_id
      ) p
    ),
    'tasks', COALESCE((
      SELECT json_agg(row_to_json(t.*))
      FROM (
        SELECT id, title, content, stage, parent_id, "order", rank, status, x, y,
               updated_at, deleted_at, short_id
        FROM public.tasks
        WHERE project_id = p_project_id
        ORDER BY stage NULLS LAST, "order"
      ) t
    ), '[]'::json),
    'connections', COALESCE((
      SELECT json_agg(row_to_json(c.*))
      FROM (
        SELECT id, source_id, target_id, title, description, deleted_at, updated_at
        FROM public.connections
        WHERE project_id = p_project_id
      ) c
    ), '[]'::json),
    'task_tombstones', COALESCE((
      SELECT json_agg(task_id)
      FROM public.task_tombstones
      WHERE project_id = p_project_id
    ), '[]'::json),
    'connection_tombstones', COALESCE((
      SELECT json_agg(connection_id)
      FROM public.connection_tombstones
      WHERE project_id = p_project_id
    ), '[]'::json)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_full_project_data(UUID) IS
  '批量加载项目完整数据，合并 4+ 请求为 1 个，性能提升 70%';

-- 权限设置
REVOKE EXECUTE ON FUNCTION public.get_full_project_data(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_full_project_data(UUID) TO authenticated;

-- 增量加载用户项目列表 RPC
-- 支持 updated_at 增量同步
CREATE OR REPLACE FUNCTION public.get_user_projects_meta(p_since_timestamp TIMESTAMPTZ DEFAULT '1970-01-01'::timestamptz)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  SELECT json_build_object(
    'projects', COALESCE((
      SELECT json_agg(row_to_json(p.*))
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, deleted_at, version
        FROM public.projects
        WHERE owner_id = v_user_id AND deleted_at IS NULL AND updated_at > p_since_timestamp
        ORDER BY updated_at DESC
      ) p
    ), '[]'::json),
    'server_time', now()
  ) INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_user_projects_meta(TIMESTAMPTZ) IS
  '增量加载用户项目列表，支持增量同步';

-- 权限设置
REVOKE EXECUTE ON FUNCTION public.get_user_projects_meta(TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_projects_meta(TIMESTAMPTZ) TO authenticated;

-- ============================================
-- 性能优化：批量加载 RPC 函数 (2026-02-02)
-- 将 N+1 查询合并为单次 RPC 调用
-- 预期收益：API 请求从 12+ 降至 1-2 个
-- ============================================

-- SECURITY INVOKER 读取链路所需的最小底表权限；RLS/FORCE RLS 继续限制行范围。
GRANT SELECT ON TABLE
  public.projects,
  public.tasks,
  public.connections,
  public.task_tombstones,
  public.connection_tombstones,
  public.black_box_entries
TO authenticated;

-- 批量加载所有项目（用于后台同步）
CREATE OR REPLACE FUNCTION public.get_all_projects_data(
  p_since_timestamp TIMESTAMPTZ DEFAULT '1970-01-01'::TIMESTAMPTZ
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  SELECT json_build_object(
    'projects', COALESCE((
      SELECT json_agg(row_to_json(p.*) ORDER BY p.updated_at DESC)
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, deleted_at, version
        FROM public.projects
        WHERE owner_id = v_user_id AND deleted_at IS NULL AND updated_at > p_since_timestamp
      ) p
    ), '[]'::json),
    'server_time', now()
  ) INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ) IS
  '已退役的 owner-only 项目 JSON 聚合；客户端改用 keyset 项目查询与 list_project_heads_since';

REVOKE ALL ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;

-- 分页获取项目列表（含摘要信息）
CREATE OR REPLACE FUNCTION public.get_projects_list(
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  SELECT json_build_object(
    'projects', COALESCE((
      SELECT json_agg(json_build_object(
        'id', p.id,
        'owner_id', p.owner_id,
        'title', p.title,
        'description', p.description,
        'created_date', p.created_date,
        'updated_at', p.updated_at,
        'version', p.version,
        'task_count', (SELECT COUNT(*) FROM public.tasks WHERE project_id = p.id AND deleted_at IS NULL),
        'last_modified', (SELECT MAX(updated_at) FROM (
          SELECT updated_at FROM public.tasks WHERE project_id = p.id
          UNION ALL
          SELECT updated_at FROM public.connections WHERE project_id = p.id
        ) AS updates)
      ) ORDER BY p.updated_at DESC)
      FROM (
        SELECT *
        FROM public.projects
        WHERE owner_id = v_user_id
          AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT p_limit OFFSET p_offset
      ) p
    ), '[]'::json),
    'total', (SELECT COUNT(*) FROM public.projects WHERE owner_id = v_user_id AND deleted_at IS NULL),
    'server_time', now()
  ) INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_projects_list(INT, INT) IS
  '已退役的 owner-only offset 项目列表聚合；客户端使用确定性 keyset 项目查询';

-- Legacy offset project-list RPC retired after keyset pagination convergence.
REVOKE ALL ON FUNCTION public.get_projects_list(INT, INT)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_tasks_project_order
  ON public.tasks(project_id, stage, "order");

CREATE INDEX IF NOT EXISTS idx_connections_project
  ON public.connections(project_id);

-- ============================================================
-- [RESUME] Resume 水位 RPC 函数 + 配套索引
-- 来源：supabase/migrations/20260214~20260218 合并
-- ============================================================

-- ============================================
-- Resume 索引补强（幂等）
-- ============================================

CREATE INDEX IF NOT EXISTS idx_projects_id_owner_updated_desc
  ON public.projects (id, owner_id, updated_at DESC);

-- tasks / connections / tombstone 增量同步索引（保留单一定义）
CREATE INDEX IF NOT EXISTS idx_tasks_project_updated_id
  ON public.tasks (project_id, updated_at, id);

CREATE INDEX IF NOT EXISTS idx_connections_project_updated_id
  ON public.connections (project_id, updated_at, id);

CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_deleted_task
  ON public.task_tombstones (project_id, deleted_at, task_id);

-- 注：idx_connection_tombstones_project_deleted_desc 已由
-- idx_connection_tombstones_project_deleted_connection 覆盖。

CREATE INDEX IF NOT EXISTS idx_black_box_entries_user_updated_id
  ON public.black_box_entries (user_id, updated_at, id);

CREATE INDEX IF NOT EXISTS idx_project_members_user_project
  ON public.project_members (user_id, project_id);
-- 注：以下冗余索引已移除（极少作为查询条件或被复合索引替代）：
-- - idx_connection_tombstones_deleted_by
-- - idx_project_members_invited_by
-- - idx_quarantined_files_quarantined_by
-- - idx_task_tombstones_deleted_by

-- ============================================
-- get_project_sync_watermark：单项目聚合同步水位
-- ============================================

CREATE OR REPLACE FUNCTION public.get_project_sync_watermark(
  p_project_id UUID
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 单用户 owner-only 模型（project_members 已移除）
  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
      AND p.deleted_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  SELECT GREATEST(
    COALESCE((SELECT p.updated_at FROM public.projects p WHERE p.id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p_project_id), '-infinity'::timestamptz)
  )
  INTO v_watermark;

  IF v_watermark = '-infinity'::timestamptz THEN
    RETURN NULL;
  END IF;

  RETURN v_watermark;
END;
$$;

REVOKE ALL ON FUNCTION public.get_project_sync_watermark(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_project_sync_watermark(UUID) TO authenticated;

COMMENT ON FUNCTION public.get_project_sync_watermark IS
  '返回单项目聚合同步水位（owner-only，SECURITY INVOKER 保持底层 RLS）';

-- ============================================
-- get_user_projects_watermark：用户项目域全局水位（性能优化版）
-- ============================================

CREATE OR REPLACE FUNCTION public.get_user_projects_watermark()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 单用户 owner-only 模型（project_members 已移除）
  SELECT GREATEST(
    COALESCE((
      SELECT MAX(GREATEST(
        COALESCE(p.updated_at, '-infinity'::timestamptz),
        COALESCE(p.deleted_at, '-infinity'::timestamptz)
      ))
      FROM public.projects p
      WHERE p.owner_id = v_user_id
    ), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t JOIN public.projects p ON p.id = t.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c JOIN public.projects p ON p.id = c.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt JOIN public.projects p ON p.id = tt.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct JOIN public.projects p ON p.id = ct.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz)
  )
  INTO v_watermark;

  IF v_watermark = '-infinity'::timestamptz THEN
    RETURN NULL;
  END IF;

  RETURN v_watermark;
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_projects_watermark() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_projects_watermark() TO authenticated;

COMMENT ON FUNCTION public.get_user_projects_watermark IS
  '返回当前用户项目域聚合最大时间戳（owner-only，SECURITY INVOKER 保持底层 RLS）';

-- ============================================
-- list_project_heads_since：变更项目头信息（性能优化版）
-- ============================================

CREATE OR REPLACE FUNCTION public.list_project_heads_since(
  p_since TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  project_id UUID,
  updated_at TIMESTAMPTZ,
  version INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 单用户 owner-only 模型（project_members 已移除）
  RETURN QUERY
  WITH project_changes AS (
    SELECT
      p.id AS project_id,
      GREATEST(
        COALESCE(p.updated_at, '-infinity'::timestamptz),
        COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p.id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p.id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p.id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p.id), '-infinity'::timestamptz)
      ) AS updated_at,
      COALESCE(p.version, 1)::INTEGER AS version
    FROM public.projects p
    WHERE p.owner_id = v_user_id
      AND p.deleted_at IS NULL
  )
  SELECT
    pc.project_id,
    pc.updated_at,
    pc.version
  FROM project_changes pc
  WHERE pc.updated_at > COALESCE(p_since, '-infinity'::timestamptz)
  ORDER BY pc.updated_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) IS
  '返回当前用户在给定水位后变更的项目头信息（稳定快照，SECURITY INVOKER 保持底层 RLS）';

-- ============================================
-- get_accessible_project_probe：项目可访问探测 + 水位
-- ============================================

CREATE OR REPLACE FUNCTION public.get_accessible_project_probe(
  p_project_id UUID
)
RETURNS TABLE (
  project_id UUID,
  accessible BOOLEAN,
  watermark TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_accessible BOOLEAN := FALSE;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 单用户 owner-only 模型（project_members 已移除）
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
      AND p.deleted_at IS NULL
  )
  INTO v_accessible;

  IF NOT v_accessible THEN
    RETURN QUERY
    SELECT p_project_id, FALSE, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT GREATEST(
    COALESCE((SELECT p.updated_at FROM public.projects p WHERE p.id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p_project_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p_project_id), '-infinity'::timestamptz)
  )
  INTO v_watermark;

  IF v_watermark = '-infinity'::timestamptz THEN
    v_watermark := NULL;
  END IF;

  RETURN QUERY
  SELECT p_project_id, TRUE, v_watermark;
END;
$$;

REVOKE ALL ON FUNCTION public.get_accessible_project_probe(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_accessible_project_probe(UUID) TO authenticated;

COMMENT ON FUNCTION public.get_accessible_project_probe IS
  '返回当前项目可访问性与项目域聚合水位（稳定快照，SECURITY INVOKER 保持底层 RLS）';

-- ============================================
-- get_black_box_sync_watermark：黑匣子域同步水位
-- ============================================

CREATE OR REPLACE FUNCTION public.get_black_box_sync_watermark()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_watermark TIMESTAMPTZ;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT MAX(updated_at)
  INTO v_watermark
  FROM public.black_box_entries
  WHERE user_id = v_user_id;

  RETURN v_watermark;
END;
$$;

REVOKE ALL ON FUNCTION public.get_black_box_sync_watermark() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_black_box_sync_watermark() TO authenticated;

COMMENT ON FUNCTION public.get_black_box_sync_watermark IS
  '返回当前用户黑匣子域聚合同步水位（SECURITY INVOKER 保持底层 RLS）';

-- ============================================
-- get_resume_recovery_probe：恢复链路聚合探测
-- ============================================

CREATE OR REPLACE FUNCTION public.get_resume_recovery_probe(
  p_project_id UUID DEFAULT NULL
)
RETURNS TABLE (
  active_project_id UUID,
  active_accessible BOOLEAN,
  active_watermark TIMESTAMPTZ,
  projects_watermark TIMESTAMPTZ,
  blackbox_watermark TIMESTAMPTZ,
  server_now TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_active_accessible BOOLEAN := FALSE;
  v_active_watermark TIMESTAMPTZ := NULL;
  v_projects_watermark TIMESTAMPTZ := NULL;
  v_blackbox_watermark TIMESTAMPTZ := NULL;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 单用户 owner-only 模型（project_members 已移除）
  IF p_project_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = p_project_id
        AND p.owner_id = v_user_id
        AND p.deleted_at IS NULL
    )
    INTO v_active_accessible;

    IF v_active_accessible THEN
      SELECT GREATEST(
        COALESCE((SELECT p.updated_at FROM public.projects p WHERE p.id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t WHERE t.project_id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(c.updated_at) FROM public.connections c WHERE c.project_id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt WHERE tt.project_id = p_project_id), '-infinity'::timestamptz),
        COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct WHERE ct.project_id = p_project_id), '-infinity'::timestamptz)
      )
      INTO v_active_watermark;

      IF v_active_watermark = '-infinity'::timestamptz THEN
        v_active_watermark := NULL;
      END IF;
    END IF;
  END IF;

  SELECT GREATEST(
    COALESCE((
      SELECT MAX(GREATEST(
        COALESCE(p.updated_at, '-infinity'::timestamptz),
        COALESCE(p.deleted_at, '-infinity'::timestamptz)
      ))
      FROM public.projects p
      WHERE p.owner_id = v_user_id
    ), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM public.tasks t JOIN public.projects p ON p.id = t.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(c.updated_at) FROM public.connections c JOIN public.projects p ON p.id = c.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(tt.deleted_at) FROM public.task_tombstones tt JOIN public.projects p ON p.id = tt.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(ct.deleted_at) FROM public.connection_tombstones ct JOIN public.projects p ON p.id = ct.project_id WHERE p.owner_id = v_user_id AND p.deleted_at IS NULL), '-infinity'::timestamptz)
  )
  INTO v_projects_watermark;

  IF v_projects_watermark = '-infinity'::timestamptz THEN
    v_projects_watermark := NULL;
  END IF;

  SELECT MAX(updated_at)
  INTO v_blackbox_watermark
  FROM public.black_box_entries
  WHERE user_id = v_user_id;

  RETURN QUERY
  SELECT
    p_project_id,
    v_active_accessible,
    v_active_watermark,
    v_projects_watermark,
    v_blackbox_watermark,
    NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.get_resume_recovery_probe(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_resume_recovery_probe(UUID) TO authenticated;

COMMENT ON FUNCTION public.get_resume_recovery_probe IS
  '恢复链路聚合探测（稳定快照，SECURITY INVOKER 保持底层 RLS）';

-- ============================================================
-- 权限收口：SECURITY DEFINER RPC 禁止 PUBLIC / anon
-- 说明：NanoFlow 强依赖登录态；匿名角色不应具备写入/批量操作能力。
-- ============================================================

-- 附件 RPC
REVOKE EXECUTE ON FUNCTION public.append_task_attachment(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.append_task_attachment(uuid, jsonb) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.remove_task_attachment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_task_attachment(uuid, text) TO authenticated;

-- 批量任务
REVOKE EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;

-- Purge / 删除
REVOKE EXECUTE ON FUNCTION public.purge_tasks(uuid[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.purge_tasks(uuid[]) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated;

-- 辅助查询
REVOKE EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_connection_tombstoned(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_connection_tombstoned(uuid) TO authenticated;

-- 迁移工具（仅限 service_role，不应暴露给普通用户）
REVOKE EXECUTE ON FUNCTION public.migrate_project_data_to_v2(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.migrate_project_data_to_v2(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.migrate_project_data_to_v2(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.migrate_all_projects_to_v2() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.migrate_all_projects_to_v2() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.migrate_all_projects_to_v2() TO service_role;

-- 触发器辅助函数（不应作为 RPC 暴露）
REVOKE EXECUTE ON FUNCTION public.trigger_set_updated_at() FROM PUBLIC, anon;

-- 维护/清理函数（不应默认对外暴露）
REVOKE EXECUTE ON FUNCTION public.cleanup_old_deleted_tasks() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_deleted_connections() FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.cleanup_old_logs() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_deleted_attachments(integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_scan_records() FROM PUBLIC, anon;

-- 维护函数仅 service_role 可调用
GRANT EXECUTE ON FUNCTION public.cleanup_old_logs() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_deleted_attachments(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_scan_records() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_tasks() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_connections() TO service_role;

COMMENT ON FUNCTION public.get_server_time() IS '获取服务端当前时间，用于客户端时钟偏移检测';

-- ============================================================
-- 全量安全加固 (v6.0.0)
-- ============================================================

-- FORCE RLS 全量覆盖（确保 service_role 也受策略约束）
ALTER TABLE public.tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.projects FORCE ROW LEVEL SECURITY;
ALTER TABLE public.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE public.task_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE public.connection_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_members FORCE ROW LEVEL SECURITY;
ALTER TABLE public.app_config FORCE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_scans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.circuit_breaker_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.cleanup_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.purge_rate_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE public.quarantined_files FORCE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_usage FORCE ROW LEVEL SECURITY;

-- anon 角色全量收紧（用户数据零访问）
REVOKE ALL ON TABLE public.tasks FROM anon;
REVOKE ALL ON TABLE public.projects FROM anon;
REVOKE ALL ON TABLE public.connections FROM anon;
REVOKE ALL ON TABLE public.user_preferences FROM anon;
REVOKE ALL ON TABLE public.black_box_entries FROM anon;
REVOKE ALL ON TABLE public.focus_sessions FROM anon;
REVOKE ALL ON TABLE public.routine_tasks FROM anon;
REVOKE ALL ON TABLE public.routine_completions FROM anon;
REVOKE ALL ON TABLE public.transcription_usage FROM anon;
REVOKE ALL ON TABLE public.task_tombstones FROM anon;
REVOKE ALL ON TABLE public.connection_tombstones FROM anon;
REVOKE ALL ON TABLE public.project_members FROM anon;
REVOKE ALL ON TABLE public.circuit_breaker_logs FROM anon;
REVOKE ALL ON TABLE public.cleanup_logs FROM anon;
REVOKE ALL ON TABLE public.purge_rate_limits FROM anon;
REVOKE ALL ON TABLE public.quarantined_files FROM anon;
REVOKE ALL ON TABLE public.attachment_scans FROM anon;
-- app_config：仅保留 anon 只读
REVOKE ALL ON TABLE public.app_config FROM anon;
GRANT SELECT ON TABLE public.app_config TO anon;
-- 新表不自动授权 anon
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

-- 数据安全约束（防 DoS / 溢出 / 注入）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_title_length_check' AND conrelid='public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_title_length_check CHECK (title IS NULL OR length(title) <= 10000);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_content_length_check' AND conrelid='public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_content_length_check CHECK (content IS NULL OR length(content) <= 1000000);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_parking_meta_size_check' AND conrelid='public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_parking_meta_size_check CHECK (parking_meta IS NULL OR pg_column_size(parking_meta) <= 524288);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='routine_tasks_title_length_check' AND conrelid='public.routine_tasks'::regclass)
  THEN ALTER TABLE public.routine_tasks ADD CONSTRAINT routine_tasks_title_length_check CHECK (length(title) <= 1000);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='routine_tasks_max_times_check' AND conrelid='public.routine_tasks'::regclass)
  THEN ALTER TABLE public.routine_tasks ADD CONSTRAINT routine_tasks_max_times_check CHECK (max_times_per_day > 0 AND max_times_per_day <= 100);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='routine_completions_count_check' AND conrelid='public.routine_completions'::regclass)
  THEN ALTER TABLE public.routine_completions ADD CONSTRAINT routine_completions_count_check CHECK (count > 0 AND count <= 1000);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='focus_sessions_state_size_check' AND conrelid='public.focus_sessions'::regclass)
  THEN ALTER TABLE public.focus_sessions ADD CONSTRAINT focus_sessions_state_size_check CHECK (pg_column_size(session_state) <= 1048576);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_preferences_dock_snapshot_size_check' AND conrelid='public.user_preferences'::regclass)
  THEN ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_dock_snapshot_size_check CHECK (dock_snapshot IS NULL OR pg_column_size(dock_snapshot) <= 1048576);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_preferences_focus_pref_size_check' AND conrelid='public.user_preferences'::regclass)
  THEN ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_focus_pref_size_check CHECK (focus_preferences IS NULL OR pg_column_size(focus_preferences) <= 65536);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_preferences_color_mode_check' AND conrelid='public.user_preferences'::regclass)
  THEN ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_color_mode_check CHECK (color_mode IS NULL OR color_mode IN ('light', 'dark', 'system'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_preferences_backup_interval_check' AND conrelid='public.user_preferences'::regclass)
  THEN ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_backup_interval_check CHECK (local_backup_interval_ms IS NULL OR (local_backup_interval_ms >= 300000 AND local_backup_interval_ms <= 604800000));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='black_box_entries_focus_meta_size_check' AND conrelid='public.black_box_entries'::regclass)
  THEN ALTER TABLE public.black_box_entries ADD CONSTRAINT black_box_entries_focus_meta_size_check CHECK (focus_meta IS NULL OR pg_column_size(focus_meta) <= 262144);
  END IF;
END $$;

-- 补充缺失的 RLS 策略
DO $$ BEGIN
  CREATE POLICY "transcription_usage_insert_policy" ON public.transcription_usage FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "transcription_usage_update_policy" ON public.transcription_usage FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "transcription_usage_delete_policy" ON public.transcription_usage FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "circuit_breaker_logs_insert_own" ON public.circuit_breaker_logs FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  DROP POLICY IF EXISTS "cleanup_logs_authenticated_select" ON public.cleanup_logs;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.increment_routine_completion(
  p_completion_id uuid,
  p_routine_id uuid,
  p_date_key date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_user_id uuid;
  v_next_count integer;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.routine_tasks
  WHERE id = p_routine_id
    AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Routine not found'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.routine_completion_events (id, routine_id, user_id, date_key)
  VALUES (p_completion_id, p_routine_id, v_user_id, p_date_key)
  ON CONFLICT (id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT count
    INTO v_next_count
    FROM public.routine_completions
    WHERE user_id = v_user_id
      AND routine_id = p_routine_id
      AND date_key = p_date_key;

    RETURN COALESCE(v_next_count, 0);
  END IF;

  INSERT INTO public.routine_completions (id, routine_id, user_id, date_key, count)
  VALUES (p_completion_id, p_routine_id, v_user_id, p_date_key, 1)
  ON CONFLICT (user_id, routine_id, date_key) DO UPDATE
  SET count = public.routine_completions.count + 1
  RETURNING count INTO v_next_count;

  RETURN v_next_count;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_routine_completion(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_routine_completion(uuid, uuid, date) TO authenticated;

-- 自动 VACUUM 阈值调优（小表默认 50 太高）
ALTER TABLE public.tasks SET (autovacuum_vacuum_threshold = 10, autovacuum_analyze_threshold = 10);
ALTER TABLE public.connections SET (autovacuum_vacuum_threshold = 10, autovacuum_analyze_threshold = 10);
ALTER TABLE public.projects SET (autovacuum_vacuum_threshold = 10, autovacuum_analyze_threshold = 10);
ALTER TABLE public.black_box_entries SET (autovacuum_vacuum_threshold = 10, autovacuum_analyze_threshold = 10);
ALTER TABLE public.user_preferences SET (autovacuum_vacuum_threshold = 5, autovacuum_analyze_threshold = 5);

-- 连接保护：防止长查询占用连接池
ALTER ROLE authenticated SET statement_timeout = '30s';

COMMENT ON SCHEMA public IS
  '全量优化 v6.0.0: FORCE RLS 全覆盖, 冗余索引清理, 备份索引整合, autovacuum 调优, statement_timeout 30s';

-- ============================================================
-- Personal Backend Slim-Down Overlay (v6.3.0)
-- 使一次性初始化后的最终状态与 2026-03-19 主库迁移保持一致。
-- ============================================================


CREATE OR REPLACE FUNCTION public.user_accessible_project_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = 'pg_catalog', 'public'
AS $$
  SELECT id
  FROM public.projects
  WHERE owner_id = public.current_user_id()
    AND deleted_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.user_has_project_access(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = 'pg_catalog', 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = public.current_user_id()
  )
$$;

CREATE OR REPLACE FUNCTION public.soft_delete_project(p_project_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_user_id uuid;
  v_owner_id uuid;
  v_deleted_at timestamptz;
  v_operation_ts timestamptz;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  SELECT owner_id, deleted_at
  INTO v_owner_id, v_deleted_at
  FROM public.projects
  WHERE id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN true;
  END IF;

  IF v_owner_id IS DISTINCT FROM v_user_id THEN
    RETURN true;
  END IF;

  IF v_deleted_at IS NOT NULL THEN
    RETURN true;
  END IF;

  v_operation_ts := now();

  UPDATE public.tasks
  SET deleted_at = v_operation_ts,
      updated_at = CASE
        WHEN updated_at IS NULL OR updated_at < v_operation_ts THEN v_operation_ts
        ELSE updated_at
      END
  WHERE project_id = p_project_id
    AND deleted_at IS NULL;

  UPDATE public.connections
  SET deleted_at = v_operation_ts,
      updated_at = CASE
        WHEN updated_at IS NULL OR updated_at < v_operation_ts THEN v_operation_ts
        ELSE updated_at
      END
  WHERE project_id = p_project_id
    AND deleted_at IS NULL;

  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT
    t.id,
    t.project_id,
    COALESCE(t.deleted_at, v_operation_ts),
    v_user_id
  FROM public.tasks t
  WHERE t.project_id = p_project_id
  ON CONFLICT (task_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      deleted_at = GREATEST(public.task_tombstones.deleted_at, EXCLUDED.deleted_at),
      deleted_by = COALESCE(public.task_tombstones.deleted_by, EXCLUDED.deleted_by);

  INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_at, deleted_by)
  SELECT
    c.id,
    c.project_id,
    COALESCE(c.deleted_at, v_operation_ts),
    v_user_id
  FROM public.connections c
  WHERE c.project_id = p_project_id
  ON CONFLICT (connection_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      deleted_at = GREATEST(public.connection_tombstones.deleted_at, EXCLUDED.deleted_at),
      deleted_by = COALESCE(public.connection_tombstones.deleted_by, EXCLUDED.deleted_by);

  UPDATE public.projects
  SET deleted_at = v_operation_ts,
      updated_at = v_operation_ts
  WHERE id = p_project_id;

  RETURN true;
END;
$$;

-- Legacy project deletion is internal-only; authenticated clients must use
-- sync_delete_project so operation-id and base_updated_at guards always run.
REVOKE ALL ON FUNCTION public.soft_delete_project(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.soft_delete_project(uuid) TO service_role;

DROP POLICY IF EXISTS "owner select" ON public.projects;
CREATE POLICY "owner select" ON public.projects
FOR SELECT
USING (((SELECT auth.uid() AS uid) = owner_id));

DROP POLICY IF EXISTS "owner update" ON public.projects;
CREATE POLICY "owner update" ON public.projects
FOR UPDATE
USING (((SELECT auth.uid() AS uid) = owner_id))
WITH CHECK ((SELECT auth.uid() AS uid) = owner_id);

DROP POLICY IF EXISTS "owner delete" ON public.projects;
CREATE POLICY "owner delete" ON public.projects
FOR DELETE
USING (((SELECT auth.uid() AS uid) = owner_id) AND (deleted_at IS NULL));


CREATE OR REPLACE FUNCTION public.cleanup_cron_job_run_details(
  p_max_age interval DEFAULT interval '7 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT integer := 5000;
  v_deleted_count integer := 0;
BEGIN
  IF p_max_age IS NULL OR p_max_age <= interval '0' THEN
    RAISE EXCEPTION 'p_max_age must be a positive interval'
      USING ERRCODE = '22023';
  END IF;

  IF to_regclass('cron.job_run_details') IS NULL THEN
    RAISE NOTICE 'Skipping cron job_run_details cleanup; pg_cron job_run_details table is absent.';
    RETURN 0;
  END IF;

  EXECUTE $sql$
    WITH candidates AS (
      SELECT ctid
      FROM cron.job_run_details
      WHERE end_time < now() - $1
      ORDER BY end_time ASC, ctid
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    ),
    deleted AS (
      DELETE FROM cron.job_run_details AS details
      USING candidates
      WHERE details.ctid = candidates.ctid
      RETURNING 1
    )
    SELECT count(*)::integer FROM deleted
  $sql$
  INTO v_deleted_count
  USING p_max_age, v_batch_size;

  RETURN v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_cron_job_run_details(interval)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_cron_job_run_details(interval)
  TO service_role;

CREATE OR REPLACE FUNCTION public.cleanup_personal_retention_artifacts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  v_batch_size CONSTANT INTEGER := 10000;
  v_focus_sessions_deleted INTEGER := 0;
  v_transcription_usage_deleted INTEGER := 0;
  v_task_tombstones_deleted INTEGER := 0;
  v_connection_tombstones_deleted INTEGER := 0;
BEGIN
  WITH expired_focus_sessions AS MATERIALIZED (
    SELECT sessions.ctid
    FROM public.focus_sessions AS sessions
    WHERE sessions.ended_at IS NOT NULL
      AND sessions.updated_at < now() - interval '30 days'
    ORDER BY sessions.updated_at
    FOR UPDATE OF sessions SKIP LOCKED
    LIMIT v_batch_size
  ),
  deleted AS (
    DELETE FROM public.focus_sessions AS sessions
    WHERE sessions.ctid IN (SELECT ctid FROM expired_focus_sessions)
    RETURNING 1
  )
  SELECT count(*) INTO v_focus_sessions_deleted FROM deleted;

  WITH expired_transcription_usage AS MATERIALIZED (
    SELECT usage.ctid
    FROM public.transcription_usage AS usage
    WHERE usage.created_at < now() - interval '90 days'
    ORDER BY usage.created_at
    FOR UPDATE OF usage SKIP LOCKED
    LIMIT v_batch_size
  ),
  deleted AS (
    DELETE FROM public.transcription_usage AS usage
    WHERE usage.ctid IN (SELECT ctid FROM expired_transcription_usage)
    RETURNING 1
  )
  SELECT count(*) INTO v_transcription_usage_deleted FROM deleted;

  WITH expired_task_tombstones AS MATERIALIZED (
    SELECT tombstones.ctid
    FROM public.task_tombstones AS tombstones
    WHERE tombstones.deleted_at < now() - interval '30 days'
    ORDER BY tombstones.deleted_at
    FOR UPDATE OF tombstones SKIP LOCKED
    LIMIT v_batch_size
  ),
  deleted AS (
    DELETE FROM public.task_tombstones AS tombstones
    WHERE tombstones.ctid IN (SELECT ctid FROM expired_task_tombstones)
    RETURNING 1
  )
  SELECT count(*) INTO v_task_tombstones_deleted FROM deleted;

  WITH expired_connection_tombstones AS MATERIALIZED (
    SELECT tombstones.ctid
    FROM public.connection_tombstones AS tombstones
    WHERE tombstones.deleted_at < now() - interval '30 days'
    ORDER BY tombstones.deleted_at
    FOR UPDATE OF tombstones SKIP LOCKED
    LIMIT v_batch_size
  ),
  deleted AS (
    DELETE FROM public.connection_tombstones AS tombstones
    WHERE tombstones.ctid IN (SELECT ctid FROM expired_connection_tombstones)
    RETURNING 1
  )
  SELECT count(*) INTO v_connection_tombstones_deleted FROM deleted;

  IF (
    v_focus_sessions_deleted
    + v_transcription_usage_deleted
    + v_task_tombstones_deleted
    + v_connection_tombstones_deleted
  ) > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES (
      'personal_retention_cleanup',
      jsonb_build_object(
        'focus_sessions_deleted', v_focus_sessions_deleted,
        'transcription_usage_deleted', v_transcription_usage_deleted,
        'task_tombstones_deleted', v_task_tombstones_deleted,
        'connection_tombstones_deleted', v_connection_tombstones_deleted,
        'batch_limit', v_batch_size,
        'cleanup_time', now()
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'focus_sessions_deleted', v_focus_sessions_deleted,
    'transcription_usage_deleted', v_transcription_usage_deleted,
    'task_tombstones_deleted', v_task_tombstones_deleted,
    'connection_tombstones_deleted', v_connection_tombstones_deleted,
    'batch_limit', v_batch_size
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_personal_retention_artifacts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_personal_retention_artifacts() FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_personal_retention_artifacts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_personal_retention_artifacts() TO service_role;

DO $$
DECLARE
  v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN ('nanoflow-personal-retention', 'nanoflow-cron-log-retention')
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  PERFORM cron.schedule(
    'nanoflow-personal-retention',
    '40 20 * * *',
    $cmd$SELECT public.cleanup_personal_retention_artifacts();$cmd$
  );

  PERFORM cron.schedule(
    'nanoflow-cron-log-retention',
    '55 20 * * *',
    $cmd$SELECT public.cleanup_cron_job_run_details(interval '7 days');$cmd$
  );
END $$;

ALTER TABLE public.user_preferences
DROP CONSTRAINT IF EXISTS user_preferences_dock_snapshot_size_check;

-- 运行时代码与安全策略仍依赖这些表；保留 schema，避免 fresh bootstrap 后失配。

ALTER TABLE public.user_preferences
DROP COLUMN IF EXISTS dock_snapshot;

-- ============================================================
-- batch_get_tombstones：批量 tombstone 查询（免费 tier 优化）
-- ============================================================

CREATE OR REPLACE FUNCTION public.batch_get_tombstones(
  p_project_ids UUID[]
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
  v_result JSON;
  v_max_project_ids CONSTANT INTEGER := 100;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'P0001';
  END IF;

  IF cardinality(COALESCE(p_project_ids, ARRAY[]::UUID[])) > v_max_project_ids THEN
    RAISE EXCEPTION 'batch_get_tombstones accepts at most % project ids', v_max_project_ids
      USING ERRCODE = '22023';
  END IF;

  SELECT json_build_object(
    'task_tombstones',
    COALESCE(
      (SELECT json_agg(json_build_object(
        'project_id', tt.project_id,
        'task_id', tt.task_id,
        'deleted_at', tt.deleted_at
      ))
       FROM public.task_tombstones tt
       INNER JOIN public.projects p ON p.id = tt.project_id
       WHERE tt.project_id = ANY(p_project_ids)
         AND p.owner_id = v_user_id),
      '[]'::json
    ),
    'connection_tombstones',
    COALESCE(
      (SELECT json_agg(json_build_object('project_id', ct.project_id, 'connection_id', ct.connection_id))
       FROM public.connection_tombstones ct
       INNER JOIN public.projects p ON p.id = ct.project_id
       WHERE ct.project_id = ANY(p_project_ids)
         AND p.owner_id = v_user_id),
      '[]'::json
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.batch_get_tombstones(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_get_tombstones(UUID[]) TO authenticated;

COMMENT ON FUNCTION public.batch_get_tombstones IS
  '批量获取多项目 tombstone（稳定快照，SECURITY INVOKER 保持底层 RLS，每次最多 100 个项目）';

CREATE OR REPLACE FUNCTION public.widget_summary_wave1(
  p_user_id UUID,
  p_today DATE,
  p_preview_limit INT DEFAULT 6
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_session_json JSONB := NULL;
  v_accessible_project_ids UUID[] := ARRAY[]::UUID[];
  v_pending_count INT := 0;
  v_unread_count INT := 0;
  v_preview JSONB := '[]'::JSONB;
  v_black_box_watermark TIMESTAMPTZ;
  v_gate_read_cooldown_cutoff TIMESTAMPTZ := now() - interval '30 minutes';
  v_next_gate_review_at TIMESTAMPTZ;
  v_dock_count INT := 0;
  v_dock_watermark TIMESTAMPTZ;
BEGIN
  SELECT jsonb_build_object(
    'id', id,
    'updated_at', updated_at,
    'session_state', session_state
  )
    INTO v_session_json
    FROM public.focus_sessions
    WHERE user_id = p_user_id
    ORDER BY updated_at DESC
    LIMIT 1;

  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
    INTO v_accessible_project_ids
    FROM public.projects
    WHERE owner_id = p_user_id
      AND deleted_at IS NULL;

  SELECT count(*)::INT
    INTO v_pending_count
    FROM public.black_box_entries
    WHERE user_id = p_user_id
      AND deleted_at IS NULL
      AND is_completed = FALSE
      AND is_archived = FALSE
      AND date < p_today
      AND (snooze_until IS NULL OR snooze_until <= p_today)
      AND (is_read = FALSE OR updated_at <= v_gate_read_cooldown_cutoff);

  SELECT count(*)::INT
    INTO v_unread_count
    FROM public.black_box_entries
    WHERE user_id = p_user_id
      AND deleted_at IS NULL
      AND is_read = FALSE
      AND is_completed = FALSE
      AND is_archived = FALSE
      AND date < p_today
      AND (snooze_until IS NULL OR snooze_until <= p_today);

  SELECT max(updated_at)
    INTO v_black_box_watermark
    FROM public.black_box_entries
    WHERE user_id = p_user_id
      AND deleted_at IS NULL
      AND is_archived = FALSE
      AND date < p_today;

  SELECT min(updated_at + interval '30 minutes')
    INTO v_next_gate_review_at
    FROM public.black_box_entries
    WHERE user_id = p_user_id
      AND deleted_at IS NULL
      AND is_read = TRUE
      AND is_completed = FALSE
      AND is_archived = FALSE
      AND date < p_today
      AND (snooze_until IS NULL OR snooze_until <= p_today)
      AND updated_at > v_gate_read_cooldown_cutoff;

  SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', bb.id,
        'date', bb.date,
        'project_id', bb.project_id,
        'content', bb.content,
        'is_read', bb.is_read,
        'created_at', bb.created_at,
        'snooze_until', bb.snooze_until,
        'updated_at', bb.updated_at
      ) ORDER BY bb.created_at ASC
    ), '[]'::JSONB)
    INTO v_preview
    FROM (
      SELECT id, date, project_id, content, is_read, created_at, snooze_until, updated_at
        FROM public.black_box_entries
        WHERE user_id = p_user_id
          AND deleted_at IS NULL
          AND is_completed = FALSE
          AND is_archived = FALSE
          AND date < p_today
          AND (snooze_until IS NULL OR snooze_until <= p_today)
          AND (is_read = FALSE OR updated_at <= v_gate_read_cooldown_cutoff)
        ORDER BY created_at ASC
        LIMIT greatest(p_preview_limit, 0)
    ) bb;

  IF array_length(v_accessible_project_ids, 1) IS NOT NULL THEN
    SELECT count(*)::INT, max(updated_at)
      INTO v_dock_count, v_dock_watermark
      FROM public.tasks
      WHERE project_id = ANY(v_accessible_project_ids)
        AND deleted_at IS NULL
        AND parking_meta @> '{"state":"parked"}'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'focusSession', v_session_json,
    'accessibleProjectIds', to_jsonb(v_accessible_project_ids),
    'pendingBlackBoxCount', v_pending_count,
    'unreadBlackBoxCount', v_unread_count,
    'nextGateReviewAt', v_next_gate_review_at,
    'blackBoxPreview', v_preview,
    'blackBoxWatermark', v_black_box_watermark,
    'dockCount', v_dock_count,
    'dockWatermark', v_dock_watermark
  );
END;
$$;

REVOKE ALL ON FUNCTION public.widget_summary_wave1(UUID, DATE, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.widget_summary_wave1(UUID, DATE, INT) TO service_role;

COMMENT ON FUNCTION public.widget_summary_wave1(UUID, DATE, INT) IS
  'Widget summary 第一波聚合：focus_sessions + projects + black_box read cooldown pending/unread count/preview/watermark + dock count/watermark 合并到单次 RPC，把 4-5 个 PostgREST roundtrip 压缩到 1 个。';

-- ============================================================
-- [MIGRATION] 20260412143000_widget_backend_foundation.sql
-- Widget backend foundation: device auth, instance boundaries,
-- rate limiting, notify dedupe, and kill switch defaults.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.widget_devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('android-widget')),
  installation_id TEXT NOT NULL,
  push_token TEXT NULL,
  push_token_updated_at TIMESTAMPTZ NULL,
  secret_hash TEXT NOT NULL,
  token_hash TEXT NULL,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  binding_generation INTEGER NOT NULL DEFAULT 1 CHECK (binding_generation >= 1),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_bound_user_hash TEXT NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoke_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, installation_id)
);

ALTER TABLE public.widget_devices
  ADD COLUMN IF NOT EXISTS token_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_widget_devices_active_owner_platform
  ON public.widget_devices (user_id, platform)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_widget_devices_token_hash
  ON public.widget_devices (token_hash)
  WHERE token_hash IS NOT NULL;

DROP TRIGGER IF EXISTS trg_widget_devices_updated_at ON public.widget_devices;
CREATE TRIGGER trg_widget_devices_updated_at
  BEFORE UPDATE ON public.widget_devices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_devices FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.widget_instances (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES public.widget_devices(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('android-widget')),
  host_instance_id TEXT NOT NULL,
  size_bucket TEXT NOT NULL,
  config_scope TEXT NOT NULL DEFAULT 'global-summary' CHECK (config_scope IN ('global-summary')),
  privacy_mode TEXT NOT NULL DEFAULT 'minimal' CHECK (privacy_mode IN ('minimal')),
  binding_generation INTEGER NOT NULL DEFAULT 1 CHECK (binding_generation >= 1),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uninstalled_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (device_id, host_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_widget_instances_active_owner_platform
  ON public.widget_instances (user_id, platform)
  INCLUDE (device_id, binding_generation)
  WHERE uninstalled_at IS NULL;

DROP TRIGGER IF EXISTS trg_widget_instances_updated_at ON public.widget_instances;
CREATE TRIGGER trg_widget_instances_updated_at
  BEFORE UPDATE ON public.widget_instances
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_instances FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.widget_request_rate_limits (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('device', 'user', 'ip')),
  scope_key TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0 CHECK (call_count >= 0),
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ NULL,
  last_decision TEXT NOT NULL DEFAULT 'allow' CHECK (last_decision IN ('allow', 'deny')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_type, scope_key)
);

DROP TRIGGER IF EXISTS trg_widget_request_rate_limits_updated_at ON public.widget_request_rate_limits;
CREATE TRIGGER trg_widget_request_rate_limits_updated_at
  BEFORE UPDATE ON public.widget_request_rate_limits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_request_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_request_rate_limits FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.widget_notify_events (
  webhook_id TEXT PRIMARY KEY,
  user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  source_table TEXT NOT NULL CHECK (source_table IN ('focus_sessions', 'black_box_entries', 'tasks', 'projects')),
  event_type TEXT NOT NULL CHECK (event_type IN ('INSERT', 'UPDATE', 'DELETE')),
  summary_cursor TEXT NULL,
  last_status TEXT NOT NULL DEFAULT 'processing',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_widget_notify_events_user_processed
  ON public.widget_notify_events (user_id, processed_at DESC);

DROP TRIGGER IF EXISTS trg_widget_notify_events_updated_at ON public.widget_notify_events;
CREATE TRIGGER trg_widget_notify_events_updated_at
  BEFORE UPDATE ON public.widget_notify_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_notify_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_notify_events FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.widget_notify_throttle (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_summary_version TEXT NULL,
  last_event_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_widget_notify_throttle_updated_at ON public.widget_notify_throttle;
CREATE TRIGGER trg_widget_notify_throttle_updated_at
  BEFORE UPDATE ON public.widget_notify_throttle
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.widget_notify_throttle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_notify_throttle FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_widget_rate_limit(
  p_scope_type TEXT,
  p_scope_key TEXT,
  p_max_calls INTEGER,
  p_window_seconds INTEGER DEFAULT 60,
  p_block_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
  allowed BOOLEAN,
  retry_after_seconds INTEGER,
  remaining_calls INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_record public.widget_request_rate_limits%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
  v_next_count INTEGER;
  v_retry_after INTEGER := 0;
BEGIN
  IF p_scope_type NOT IN ('device', 'user', 'ip') THEN
    RAISE EXCEPTION 'Invalid widget rate limit scope';
  END IF;
  IF COALESCE(length(trim(p_scope_key)), 0) = 0 THEN
    RAISE EXCEPTION 'Invalid widget rate limit scope key';
  END IF;
  IF p_max_calls < 1 THEN
    RAISE EXCEPTION 'Invalid widget rate limit max calls';
  END IF;

  INSERT INTO public.widget_request_rate_limits (
    scope_type,
    scope_key,
    call_count,
    window_start,
    blocked_until,
    last_decision,
    created_at,
    updated_at
  )
  VALUES (
    p_scope_type,
    p_scope_key,
    0,
    v_now,
    NULL,
    'allow',
    v_now,
    v_now
  )
  ON CONFLICT (scope_type, scope_key) DO NOTHING;

  SELECT *
  INTO v_record
  FROM public.widget_request_rate_limits
  WHERE scope_type = p_scope_type
    AND scope_key = p_scope_key
  FOR UPDATE;

  IF v_record.blocked_until IS NOT NULL AND v_record.blocked_until > v_now THEN
    v_retry_after := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_record.blocked_until - v_now)))::INTEGER);
    UPDATE public.widget_request_rate_limits
    SET last_decision = 'deny', updated_at = v_now
    WHERE scope_type = p_scope_type AND scope_key = p_scope_key;
    RETURN QUERY SELECT FALSE, v_retry_after, 0;
    RETURN;
  END IF;

  IF v_record.window_start <= v_now - make_interval(secs => GREATEST(p_window_seconds, 1)) THEN
    v_next_count := 1;
    UPDATE public.widget_request_rate_limits
    SET call_count = v_next_count,
        window_start = v_now,
        blocked_until = NULL,
        last_decision = 'allow',
        updated_at = v_now
    WHERE scope_type = p_scope_type AND scope_key = p_scope_key;
    RETURN QUERY SELECT TRUE, 0, GREATEST(p_max_calls - v_next_count, 0);
    RETURN;
  END IF;

  v_next_count := v_record.call_count + 1;
  IF v_next_count > p_max_calls THEN
    UPDATE public.widget_request_rate_limits
    SET call_count = v_next_count,
        blocked_until = v_now + make_interval(secs => GREATEST(p_block_seconds, 1)),
        last_decision = 'deny',
        updated_at = v_now
    WHERE scope_type = p_scope_type AND scope_key = p_scope_key;
    RETURN QUERY SELECT FALSE, GREATEST(p_block_seconds, 1), 0;
    RETURN;
  END IF;

  UPDATE public.widget_request_rate_limits
  SET call_count = v_next_count,
      last_decision = 'allow',
      updated_at = v_now
  WHERE scope_type = p_scope_type AND scope_key = p_scope_key;

  RETURN QUERY SELECT TRUE, 0, GREATEST(p_max_calls - v_next_count, 0);
END;
$$;

REVOKE ALL ON TABLE public.widget_devices FROM anon, authenticated;
REVOKE ALL ON TABLE public.widget_instances FROM anon, authenticated;
REVOKE ALL ON TABLE public.widget_request_rate_limits FROM anon, authenticated;
REVOKE ALL ON TABLE public.widget_notify_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.widget_notify_throttle FROM anon, authenticated;
GRANT ALL ON TABLE public.widget_devices TO service_role;
GRANT ALL ON TABLE public.widget_instances TO service_role;
GRANT ALL ON TABLE public.widget_request_rate_limits TO service_role;
GRANT ALL ON TABLE public.widget_notify_events TO service_role;
GRANT ALL ON TABLE public.widget_notify_throttle TO service_role;

REVOKE ALL ON FUNCTION public.consume_widget_rate_limit(TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_widget_rate_limit(TEXT, TEXT, INTEGER, INTEGER, INTEGER)
  TO service_role;

INSERT INTO public.app_config (key, value, description)
VALUES (
  'widget_capabilities',
  jsonb_build_object(
    'widgetEnabled', true,
    'installAllowed', true,
    'refreshAllowed', true,
    'pushAllowed', false,
    'reason', NULL,
    'rules', jsonb_build_array()
  ),
  'Widget backend capability gates and kill switch defaults'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.app_config (key, value, description)
VALUES (
  'widget_limits',
  jsonb_build_object(
    'registerUserPerMinute', 10,
    'registerIpPerMinute', 20,
    'summaryDevicePerMinute', 30,
    'summaryUserPerMinute', 60,
    'summaryIpPerMinute', 120,
    'notifyUserPerMinute', 120,
    'notifyIpPerMinute', 600,
    'blockSeconds', 300,
    'tokenTtlDays', 30,
    'freshThresholdMinutes', 5,
    'agingThresholdMinutes', 60
  ),
  'Widget backend rate limits and freshness thresholds'
)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- [MIGRATION] 20260413102000_widget_notify_webhook_hmac.sql
-- Widget notify direct webhook wiring via pg_net + Vault-backed HMAC headers.
-- ============================================================

CREATE OR REPLACE FUNCTION public.invoke_widget_notify_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault, extensions
AS $$
DECLARE
  v_base_url TEXT;
  v_secret TEXT;
  v_timestamp TEXT;
  v_event_id TEXT;
  v_payload JSONB;
  v_signature TEXT;
BEGIN
  v_base_url := public.get_vault_secret('widget_notify_base_url');
  v_secret := public.get_vault_secret('widget_notify_webhook_secret');

  IF COALESCE(trim(v_base_url), '') = '' OR COALESCE(trim(v_secret), '') = '' THEN
    RAISE LOG 'widget-notify webhook secrets are missing; skip enqueue';
    RETURN NULL;
  END IF;

  v_timestamp := floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  v_event_id := gen_random_uuid()::text;
  v_payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END
  );

  v_signature := encode(
    hmac(
      convert_to(v_timestamp || '.' || v_payload::text, 'utf8'),
      convert_to(v_secret, 'utf8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM net.http_post(
    url := rtrim(v_base_url, '/') || '/functions/v1/widget-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-widget-webhook-event-id', v_event_id,
      'x-widget-webhook-timestamp', v_timestamp,
      'x-widget-webhook-signature', v_signature
    ),
    body := v_payload
  );

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'widget-notify webhook enqueue failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_widget_notify_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS widget_notify_focus_session_change ON public.focus_sessions;
CREATE TRIGGER widget_notify_focus_session_change
  AFTER INSERT OR UPDATE OR DELETE ON public.focus_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.invoke_widget_notify_webhook();

DROP TRIGGER IF EXISTS widget_notify_black_box_change ON public.black_box_entries;
CREATE TRIGGER widget_notify_black_box_change
  AFTER INSERT OR UPDATE OR DELETE ON public.black_box_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.invoke_widget_notify_webhook();

DROP TRIGGER IF EXISTS widget_notify_task_change ON public.tasks;
CREATE TRIGGER widget_notify_task_change
  AFTER INSERT OR UPDATE OR DELETE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.invoke_widget_notify_webhook();

DROP TRIGGER IF EXISTS widget_notify_project_change ON public.projects;
CREATE TRIGGER widget_notify_project_change
  AFTER INSERT OR UPDATE OR DELETE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.invoke_widget_notify_webhook();

-- ============================================================
-- [MIGRATION] 20260413113000_widget_notify_hmac_replay_fix.sql
-- Bind event_id into HMAC and tighten SECURITY DEFINER search_path.
-- ============================================================

CREATE OR REPLACE FUNCTION public.invoke_widget_notify_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, vault, extensions
AS $$
DECLARE
  v_base_url TEXT;
  v_secret TEXT;
  v_timestamp TEXT;
  v_event_id TEXT;
  v_payload JSONB;
  v_signature TEXT;
BEGIN
  v_base_url := public.get_vault_secret('widget_notify_base_url');
  v_secret := public.get_vault_secret('widget_notify_webhook_secret');

  IF COALESCE(trim(v_base_url), '') = '' OR COALESCE(trim(v_secret), '') = '' THEN
    RAISE LOG 'widget-notify webhook secrets are missing; skip enqueue';
    RETURN NULL;
  END IF;

  v_timestamp := floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  v_event_id := extensions.gen_random_uuid()::text;
  v_payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END
  );

  v_signature := encode(
    extensions.hmac(
      convert_to(v_event_id || '.' || v_timestamp || '.' || v_payload::text, 'utf8'),
      convert_to(v_secret, 'utf8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM net.http_post(
    url := rtrim(v_base_url, '/') || '/functions/v1/widget-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-widget-webhook-event-id', v_event_id,
      'x-widget-webhook-timestamp', v_timestamp,
      'x-widget-webhook-signature', v_signature
    ),
    body := v_payload
  );

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'widget-notify webhook enqueue failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_widget_notify_webhook() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- [MIGRATION] 20260413120000_widget_notify_secret_normalization.sql
-- Normalize webhook secret before signing to match Edge verification semantics.
-- ============================================================

CREATE OR REPLACE FUNCTION public.invoke_widget_notify_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, vault, extensions
AS $$
DECLARE
  v_base_url TEXT;
  v_secret TEXT;
  v_timestamp TEXT;
  v_event_id TEXT;
  v_payload JSONB;
  v_signature TEXT;
BEGIN
  v_base_url := public.get_vault_secret('widget_notify_base_url');
  v_secret := regexp_replace(trim(public.get_vault_secret('widget_notify_webhook_secret')), '^v1,whsec_', '');

  IF COALESCE(trim(v_base_url), '') = '' OR COALESCE(v_secret, '') = '' THEN
    RAISE LOG 'widget-notify webhook secrets are missing; skip enqueue';
    RETURN NULL;
  END IF;

  v_timestamp := floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  v_event_id := extensions.gen_random_uuid()::text;
  v_payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END
  );

  v_signature := encode(
    extensions.hmac(
      convert_to(v_event_id || '.' || v_timestamp || '.' || v_payload::text, 'utf8'),
      convert_to(v_secret, 'utf8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM net.http_post(
    url := rtrim(v_base_url, '/') || '/functions/v1/widget-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-widget-webhook-event-id', v_event_id,
      'x-widget-webhook-timestamp', v_timestamp,
      'x-widget-webhook-signature', v_signature
    ),
    body := v_payload
  );

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'widget-notify webhook enqueue failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_widget_notify_webhook() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- [MIGRATION] 20260413121000_widget_notify_limits_backfill.sql
-- Backfill notify-specific rate limits into app_config for existing projects.
-- ============================================================

INSERT INTO public.app_config (key, value, description)
VALUES (
  'widget_limits',
  jsonb_build_object(
    'registerUserPerMinute', 10,
    'registerIpPerMinute', 20,
    'summaryDevicePerMinute', 30,
    'summaryUserPerMinute', 60,
    'summaryIpPerMinute', 120,
    'notifyUserPerMinute', 120,
    'notifyIpPerMinute', 600,
    'blockSeconds', 300,
    'tokenTtlDays', 30,
    'freshThresholdMinutes', 5,
    'agingThresholdMinutes', 60
  ),
  'Widget backend rate limits and freshness thresholds'
)
ON CONFLICT (key) DO UPDATE
SET value = COALESCE(public.app_config.value, '{}'::jsonb) || jsonb_build_object(
      'notifyUserPerMinute', COALESCE((public.app_config.value ->> 'notifyUserPerMinute')::INTEGER, 120),
      'notifyIpPerMinute', COALESCE((public.app_config.value ->> 'notifyIpPerMinute')::INTEGER, 600)
    ),
    description = EXCLUDED.description,
    updated_at = NOW();

-- ============================================================
-- FINAL CONVERGENCE: 20260421054415 widget notify webhook timeout and payload parity
-- ============================================================

-- PL/pgSQL 在 CASE 表达式里对 NEW 的所有分支都做字段绑定，即使分支不匹配也会因
-- "record NEW has no field user_id" 而失败（tasks 表的 NEW 没有 user_id）。
-- 改为 IF/ELSIF 按表分发，只有命中分支才绑定字段，避免跨表字段引用失败。
CREATE OR REPLACE FUNCTION public.invoke_widget_notify_webhook()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'vault', 'extensions'
AS $function$
DECLARE
  v_base_url TEXT;
  v_secret TEXT;
  v_timestamp TEXT;
  v_event_id TEXT;
  v_payload JSONB;
  v_signature TEXT;
  v_new_record JSONB := NULL;
  v_old_record JSONB := NULL;
BEGIN
  v_base_url := public.get_vault_secret('widget_notify_base_url');
  v_secret := regexp_replace(trim(public.get_vault_secret('widget_notify_webhook_secret')), '^v1,whsec_', '');

  IF COALESCE(trim(v_base_url), '') = '' OR COALESCE(v_secret, '') = '' THEN
    RAISE LOG 'widget-notify webhook secrets are missing; skip enqueue';
    RETURN NULL;
  END IF;

  v_timestamp := floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  v_event_id := extensions.gen_random_uuid()::text;

  -- 按表分发构造最小化 record / old_record，避免 to_jsonb(NEW) 把 session_state 等
  -- 大字段夹带进去（曾导致 pg_net 5s 超时丢事件）。
  IF TG_TABLE_NAME = 'focus_sessions' THEN
    IF TG_OP <> 'DELETE' THEN
      v_new_record := jsonb_build_object(
        'id', NEW.id,
        'user_id', NEW.user_id,
        'started_at', NEW.started_at,
        'ended_at', NEW.ended_at,
        'updated_at', NEW.updated_at
      );
    END IF;
    IF TG_OP <> 'INSERT' THEN
      v_old_record := jsonb_build_object(
        'id', OLD.id,
        'user_id', OLD.user_id,
        'started_at', OLD.started_at,
        'ended_at', OLD.ended_at,
        'updated_at', OLD.updated_at
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'black_box_entries' THEN
    IF TG_OP <> 'DELETE' THEN
      v_new_record := jsonb_build_object(
        'id', NEW.id,
        'user_id', NEW.user_id,
        'updated_at', NEW.updated_at,
        'created_at', NEW.created_at
      );
    END IF;
    IF TG_OP <> 'INSERT' THEN
      v_old_record := jsonb_build_object(
        'id', OLD.id,
        'user_id', OLD.user_id,
        'updated_at', OLD.updated_at,
        'created_at', OLD.created_at
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'tasks' THEN
    IF TG_OP <> 'DELETE' THEN
      v_new_record := jsonb_build_object(
        'id', NEW.id,
        'project_id', NEW.project_id,
        'updated_at', NEW.updated_at,
        'deleted_at', NEW.deleted_at,
        'created_at', NEW.created_at
      );
    END IF;
    IF TG_OP <> 'INSERT' THEN
      v_old_record := jsonb_build_object(
        'id', OLD.id,
        'project_id', OLD.project_id,
        'updated_at', OLD.updated_at,
        'deleted_at', OLD.deleted_at,
        'created_at', OLD.created_at
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'projects' THEN
    IF TG_OP <> 'DELETE' THEN
      v_new_record := jsonb_build_object(
        'id', NEW.id,
        'owner_id', NEW.owner_id,
        'updated_at', NEW.updated_at,
        'deleted_at', NEW.deleted_at
      );
    END IF;
    IF TG_OP <> 'INSERT' THEN
      v_old_record := jsonb_build_object(
        'id', OLD.id,
        'owner_id', OLD.owner_id,
        'updated_at', OLD.updated_at,
        'deleted_at', OLD.deleted_at
      );
    END IF;
  ELSE
    -- 兜底：未识别的表使用全量 to_jsonb（不会走到这里，因为触发器只绑定上述四张表）。
    IF TG_OP <> 'DELETE' THEN v_new_record := to_jsonb(NEW); END IF;
    IF TG_OP <> 'INSERT' THEN v_old_record := to_jsonb(OLD); END IF;
  END IF;

  v_payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', v_new_record,
    'old_record', v_old_record
  );

  v_signature := encode(
    extensions.hmac(
      convert_to(v_event_id || '.' || v_timestamp || '.' || v_payload::text, 'utf8'),
      convert_to(v_secret, 'utf8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM net.http_post(
    url := rtrim(v_base_url, '/') || '/functions/v1/widget-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-widget-webhook-event-id', v_event_id,
      'x-widget-webhook-timestamp', v_timestamp,
      'x-widget-webhook-signature', v_signature
    ),
    body := v_payload,
    timeout_milliseconds := 30000
  );

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'widget-notify webhook enqueue failed: %', SQLERRM;
  RETURN NULL;
END;
$function$;;

-- ============================================================
-- Sync protocol / disaster-recovery final-state overlay (2026-06-06)
-- 使一次性初始化脚本包含迁移链最终同步 RPC 支撑对象。
-- ============================================================

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.sync_operation_log (
  operation_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  status TEXT NOT NULL,
  reject_reason TEXT,
  protocol_version INTEGER,
  deployment_epoch BIGINT,
  deployment_target TEXT,
  client_git_sha TEXT,
  client_origin TEXT,
  result_payload JSONB,
  payload_digest TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sync_operation_log_status_check
    CHECK (status IN (
      'applied',
      'idempotent-replay',
      'remote-newer',
      'deleted-remote-newer',
      'client-version-rejected',
      'tombstoned',
      'unauthorized',
      'quarantined'
    ))
);

ALTER TABLE public.sync_operation_log
  ADD COLUMN IF NOT EXISTS deployment_epoch BIGINT,
  ADD COLUMN IF NOT EXISTS deployment_target TEXT,
  ADD COLUMN IF NOT EXISTS payload_digest TEXT,
  ADD COLUMN IF NOT EXISTS result_payload JSONB;

ALTER TABLE public.sync_operation_log
  DROP CONSTRAINT IF EXISTS sync_operation_log_status_check;

ALTER TABLE public.sync_operation_log
  ADD CONSTRAINT sync_operation_log_status_check
    CHECK (status IN (
      'applied',
      'idempotent-replay',
      'remote-newer',
      'deleted-remote-newer',
      'client-version-rejected',
      'tombstoned',
      'unauthorized',
      'quarantined'
    ));

CREATE INDEX IF NOT EXISTS idx_sync_operation_log_user_created
  ON public.sync_operation_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_operation_log_entity
  ON public.sync_operation_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_sync_operation_log_status_created
  ON public.sync_operation_log (entity_type, status, created_at DESC);

CREATE OR REPLACE FUNCTION public.sync_operation_log_fill_payload_digest()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_payload_digest TEXT;
BEGIN
  v_payload_digest := NULLIF(current_setting('app.payload_digest', true), '');

  IF NEW.payload_digest IS NULL AND v_payload_digest IS NOT NULL THEN
    NEW.payload_digest := v_payload_digest;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_operation_log_fill_payload_digest ON public.sync_operation_log;
CREATE TRIGGER sync_operation_log_fill_payload_digest
  BEFORE INSERT ON public.sync_operation_log
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_operation_log_fill_payload_digest();

REVOKE ALL ON FUNCTION public.sync_operation_log_fill_payload_digest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_operation_log_fill_payload_digest() TO service_role;

ALTER TABLE public.sync_operation_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_operation_log_owner_select ON public.sync_operation_log;
CREATE POLICY sync_operation_log_owner_select
  ON public.sync_operation_log
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.sync_operation_log FROM PUBLIC, anon;
GRANT SELECT ON public.sync_operation_log TO authenticated;
GRANT ALL ON public.sync_operation_log TO service_role;

CREATE TABLE IF NOT EXISTS public.sync_protocol_state (
  scope TEXT PRIMARY KEY,
  min_protocol_version INTEGER NOT NULL DEFAULT 1,
  deployment_epoch BIGINT NOT NULL DEFAULT 0,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.sync_protocol_state (scope, min_protocol_version, deployment_epoch, reason)
VALUES ('global', 1, 0, 'initial')
ON CONFLICT (scope) DO NOTHING;

ALTER TABLE public.sync_protocol_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_protocol_state_authenticated_read ON public.sync_protocol_state;
CREATE POLICY sync_protocol_state_authenticated_read
  ON public.sync_protocol_state
  FOR SELECT
  TO authenticated
  USING (true);

REVOKE ALL ON public.sync_protocol_state FROM PUBLIC, anon;
GRANT SELECT ON public.sync_protocol_state TO authenticated;
GRANT ALL ON public.sync_protocol_state TO service_role;

CREATE TABLE IF NOT EXISTS public.data_safety_flags (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT data_safety_flags_sync_mode_chk CHECK (
    key <> 'sync_mode'
    OR value IN ('normal', 'audit_only', 'read_only', 'quarantine')
  )
);

CREATE TABLE IF NOT EXISTS public.data_safety_flag_audit (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flag_key   TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT NOT NULL,
  changed_by UUID,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.data_safety_flags(key, value)
VALUES ('sync_mode', 'normal')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.data_safety_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_safety_flags FORCE ROW LEVEL SECURITY;
ALTER TABLE public.data_safety_flag_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_safety_flag_audit FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.data_safety_flags FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.data_safety_flag_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.data_safety_flags TO service_role;
GRANT ALL ON public.data_safety_flag_audit TO service_role;

DROP POLICY IF EXISTS data_safety_flags_service_all ON public.data_safety_flags;
CREATE POLICY data_safety_flags_service_all
  ON public.data_safety_flags
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS data_safety_flag_audit_service_all ON public.data_safety_flag_audit;
CREATE POLICY data_safety_flag_audit_service_all
  ON public.data_safety_flag_audit
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.set_data_safety_flag(p_key TEXT, p_value TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_value TEXT;
BEGIN
  IF p_key <> 'sync_mode' THEN
    RAISE EXCEPTION 'unsupported data safety flag: %', p_key;
  END IF;

  IF p_value NOT IN ('normal', 'audit_only', 'read_only', 'quarantine') THEN
    RAISE EXCEPTION 'invalid sync_mode value: %', p_value;
  END IF;

  SELECT value INTO v_old_value
  FROM public.data_safety_flags
  WHERE key = p_key
  FOR UPDATE;

  INSERT INTO public.data_safety_flags(key, value, updated_by, updated_at)
  VALUES (p_key, p_value, auth.uid(), now())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_by = EXCLUDED.updated_by,
        updated_at = now();

  INSERT INTO public.data_safety_flag_audit(flag_key, old_value, new_value, changed_by, changed_at)
  VALUES (p_key, v_old_value, p_value, auth.uid(), now());
END;
$$;

REVOKE ALL ON FUNCTION public.set_data_safety_flag(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_data_safety_flag(TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_data_safety_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sync_mode TEXT;
  v_bypass BOOLEAN := COALESCE(NULLIF(current_setting('app.data_safety_bypass', true), '')::BOOLEAN, false);
BEGIN
  SELECT value INTO v_sync_mode
  FROM public.data_safety_flags
  WHERE key = 'sync_mode';

  IF COALESCE(v_sync_mode, 'normal') IN ('read_only', 'quarantine') AND NOT v_bypass THEN
    RAISE EXCEPTION 'data_safety_write_blocked: %', v_sync_mode;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_data_safety_freeze() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_data_safety_freeze_tasks ON public.tasks;
CREATE TRIGGER trg_data_safety_freeze_tasks
  BEFORE INSERT OR UPDATE OR DELETE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_data_safety_freeze();

DROP TRIGGER IF EXISTS trg_data_safety_freeze_connections ON public.connections;
CREATE TRIGGER trg_data_safety_freeze_connections
  BEFORE INSERT OR UPDATE OR DELETE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_data_safety_freeze();

DROP TRIGGER IF EXISTS trg_data_safety_freeze_projects ON public.projects;
CREATE TRIGGER trg_data_safety_freeze_projects
  BEFORE INSERT OR UPDATE OR DELETE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_data_safety_freeze();

DROP TRIGGER IF EXISTS trg_data_safety_freeze_black_box_entries ON public.black_box_entries;
CREATE TRIGGER trg_data_safety_freeze_black_box_entries
  BEFORE INSERT OR UPDATE OR DELETE ON public.black_box_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_data_safety_freeze();

CREATE TABLE IF NOT EXISTS public.sync_trusted_client_deployments (
  client_git_sha   TEXT PRIMARY KEY,
  deployment_epoch BIGINT NOT NULL,
  deployment_target TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at       TIMESTAMPTZ
);

ALTER TABLE public.sync_trusted_client_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_trusted_client_deployments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_trusted_client_deployments FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sync_trusted_client_deployments TO service_role;

DROP POLICY IF EXISTS sync_trusted_client_deployments_service_all ON public.sync_trusted_client_deployments;
CREATE POLICY sync_trusted_client_deployments_service_all
  ON public.sync_trusted_client_deployments
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.sync_write_quarantine (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id    UUID NOT NULL,
  user_id         UUID,
  entity_type     TEXT NOT NULL,
  entity_id       UUID,
  client_git_sha  TEXT,
  client_origin   TEXT,
  reason          TEXT NOT NULL,
  payload         JSONB NOT NULL,
  payload_digest  TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID,
  review_decision TEXT CHECK (review_decision IS NULL OR review_decision IN ('replay', 'discard', 'escalate')),
  CONSTRAINT sync_write_quarantine_operation_uniq UNIQUE (operation_id),
  CONSTRAINT sync_write_quarantine_digest_uniq UNIQUE (payload_digest)
);

CREATE INDEX IF NOT EXISTS idx_sync_write_quarantine_expired_cursor
  ON public.sync_write_quarantine (expires_at, id)
  WHERE reviewed_at IS NULL;

ALTER TABLE public.sync_write_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_write_quarantine FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_write_quarantine FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sync_write_quarantine TO service_role;

DROP POLICY IF EXISTS sync_write_quarantine_service_all ON public.sync_write_quarantine;
CREATE POLICY sync_write_quarantine_service_all
  ON public.sync_write_quarantine
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.sync_canonical_payload_digest(p_payload JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT encode(
    extensions.digest(
      (COALESCE(p_payload, '{}'::JSONB) - 'operation_id' - 'operationId')::TEXT,
      'sha256'
    ),
    'hex'
  );
$$;

REVOKE ALL ON FUNCTION public.sync_canonical_payload_digest(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_canonical_payload_digest(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.record_sync_write_quarantine(
  p_operation_id UUID,
  p_user_id UUID,
  p_entity_type TEXT,
  p_entity_id UUID,
  p_client_git_sha TEXT,
  p_client_origin TEXT,
  p_reason TEXT,
  p_payload JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_digest TEXT := public.sync_canonical_payload_digest(p_payload);
  v_id BIGINT;
BEGIN
  INSERT INTO public.sync_write_quarantine(
    operation_id, user_id, entity_type, entity_id,
    client_git_sha, client_origin, reason, payload, payload_digest
  )
  VALUES (
    p_operation_id, p_user_id, p_entity_type, p_entity_id,
    p_client_git_sha, p_client_origin, p_reason, p_payload, v_digest
  )
  ON CONFLICT (operation_id) DO UPDATE
    SET operation_id = EXCLUDED.operation_id
  RETURNING id INTO v_id;

  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  SELECT id INTO v_id
  FROM public.sync_write_quarantine
  WHERE operation_id = p_operation_id OR payload_digest = v_digest
  ORDER BY id ASC
  LIMIT 1;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_sync_write_quarantine(UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_sync_write_quarantine(UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.purge_expired_sync_write_quarantine()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT INTEGER := 5000;
  v_deleted INTEGER := 0;
BEGIN
  WITH candidates AS MATERIALIZED (
    SELECT quarantine.id
    FROM public.sync_write_quarantine AS quarantine
    WHERE quarantine.expires_at < now()
      AND quarantine.reviewed_at IS NULL
    ORDER BY quarantine.expires_at ASC, quarantine.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF quarantine SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.sync_write_quarantine AS quarantine
    USING candidates
    WHERE quarantine.id = candidates.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_deleted FROM deleted;

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_sync_write_quarantine()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_sync_write_quarantine() TO service_role;

CREATE TABLE IF NOT EXISTS public.task_change_audit (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id         UUID NOT NULL,
  project_id      UUID,
  owner_id        UUID,
  op              TEXT NOT NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  old_stage       INTEGER,
  old_parent_id   UUID,
  old_content     TEXT,
  old_title       TEXT,
  old_updated_at  TIMESTAMPTZ,
  old_deleted_at  TIMESTAMPTZ,
  old_record      JSONB NOT NULL
);

ALTER TABLE public.task_change_audit
  ADD COLUMN IF NOT EXISTS new_stage INTEGER,
  ADD COLUMN IF NOT EXISTS new_parent_id UUID,
  ADD COLUMN IF NOT EXISTS new_content TEXT,
  ADD COLUMN IF NOT EXISTS new_title TEXT,
  ADD COLUMN IF NOT EXISTS new_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS new_deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operation_id UUID,
  ADD COLUMN IF NOT EXISTS client_git_sha TEXT,
  ADD COLUMN IF NOT EXISTS client_origin TEXT,
  ADD COLUMN IF NOT EXISTS deployment_epoch BIGINT,
  ADD COLUMN IF NOT EXISTS payload_digest TEXT,
  ADD COLUMN IF NOT EXISTS origin_unverified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspicious BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspicious_reason TEXT;

CREATE INDEX IF NOT EXISTS task_change_audit_task_idx
  ON public.task_change_audit (task_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS task_change_audit_project_idx
  ON public.task_change_audit (project_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS task_change_audit_owner_idx
  ON public.task_change_audit (owner_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS task_change_audit_operation_idx
  ON public.task_change_audit (operation_id)
  WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_change_audit_suspicious_idx
  ON public.task_change_audit (owner_id, changed_at DESC)
  WHERE suspicious;
CREATE INDEX IF NOT EXISTS idx_task_change_audit_archive_cursor
  ON public.task_change_audit (changed_at, id);

ALTER TABLE public.task_change_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_change_audit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_change_audit_owner_select ON public.task_change_audit;
CREATE POLICY task_change_audit_owner_select
  ON public.task_change_audit
  FOR SELECT
  TO authenticated
  USING (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS task_change_audit_service_all ON public.task_change_audit;
CREATE POLICY task_change_audit_service_all
  ON public.task_change_audit
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.task_change_audit FROM PUBLIC, anon;
GRANT SELECT ON public.task_change_audit TO authenticated;
GRANT ALL ON public.task_change_audit TO service_role;

CREATE OR REPLACE FUNCTION public.capture_task_change_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner UUID;
  v_operation_id UUID;
  v_client_git_sha TEXT;
  v_client_origin TEXT;
  v_deployment_epoch BIGINT;
  v_payload_digest TEXT;
  v_origin_unverified BOOLEAN := true;
  v_suspicious BOOLEAN := false;
  v_suspicious_reason TEXT;
  v_epoch_text TEXT;
BEGIN
  SELECT p.owner_id INTO v_owner FROM public.projects p WHERE p.id = OLD.project_id;

  v_operation_id := NULLIF(current_setting('app.operation_id', true), '')::UUID;
  v_client_git_sha := NULLIF(current_setting('app.client_git_sha', true), '');
  v_client_origin := NULLIF(current_setting('app.client_origin', true), '');
  v_payload_digest := NULLIF(current_setting('app.payload_digest', true), '');
  v_origin_unverified := COALESCE(NULLIF(current_setting('app.origin_unverified', true), '')::BOOLEAN, true);
  v_epoch_text := NULLIF(current_setting('app.deployment_epoch', true), '');
  IF v_epoch_text ~ '^[0-9]+$' THEN
    v_deployment_epoch := v_epoch_text::BIGINT;
  END IF;

  IF v_operation_id IS NULL
    OR v_client_git_sha IS NULL
    OR v_client_origin IS NULL
    OR v_payload_digest IS NULL
  THEN
    v_origin_unverified := true;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.task_change_audit (
      task_id, project_id, owner_id, op, old_stage, old_parent_id,
      old_content, old_title, old_updated_at, old_deleted_at, old_record,
      operation_id, client_git_sha, client_origin, deployment_epoch,
      payload_digest, origin_unverified, suspicious, suspicious_reason
    )
    VALUES (
      OLD.id, OLD.project_id, v_owner, TG_OP, OLD.stage, OLD.parent_id,
      OLD.content, OLD.title, OLD.updated_at, OLD.deleted_at, to_jsonb(OLD),
      v_operation_id, v_client_git_sha, v_client_origin, v_deployment_epoch,
      v_payload_digest, v_origin_unverified, false, NULL
    );
    RETURN OLD;
  END IF;

  IF OLD.stage IS NOT NULL
    AND NEW.stage IS NULL
    AND COALESCE(NEW.content, '') = COALESCE(NEW.title, '')
  THEN
    v_suspicious := true;
    v_suspicious_reason := 'structure_degrade_content_equals_title';
  END IF;

  INSERT INTO public.task_change_audit (
    task_id, project_id, owner_id, op, old_stage, old_parent_id,
    old_content, old_title, old_updated_at, old_deleted_at, old_record,
    new_stage, new_parent_id, new_content, new_title, new_updated_at, new_deleted_at,
    operation_id, client_git_sha, client_origin, deployment_epoch,
    payload_digest, origin_unverified, suspicious, suspicious_reason
  )
  VALUES (
    OLD.id, OLD.project_id, v_owner, TG_OP, OLD.stage, OLD.parent_id,
    OLD.content, OLD.title, OLD.updated_at, OLD.deleted_at, to_jsonb(OLD),
    NEW.stage, NEW.parent_id, NEW.content, NEW.title, NEW.updated_at, NEW.deleted_at,
    v_operation_id, v_client_git_sha, v_client_origin, v_deployment_epoch,
    v_payload_digest, v_origin_unverified, v_suspicious, v_suspicious_reason
  );

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.capture_task_change_audit() OWNER TO postgres;

DO $audit_owner_check$
DECLARE
  v_owner_bypasses_rls BOOLEAN;
BEGIN
  SELECT r.rolbypassrls INTO v_owner_bypasses_rls
  FROM pg_proc p
  JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.oid = 'public.capture_task_change_audit()'::regprocedure;

  IF NOT COALESCE(v_owner_bypasses_rls, false) THEN
    RAISE EXCEPTION 'capture_task_change_audit owner must BYPASSRLS before task_change_audit FORCE RLS';
  END IF;
END
$audit_owner_check$;

REVOKE ALL ON FUNCTION public.capture_task_change_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_task_change_audit_update ON public.tasks;
CREATE TRIGGER trg_task_change_audit_update
  AFTER UPDATE ON public.tasks
  FOR EACH ROW
  WHEN (
    OLD.stage IS DISTINCT FROM NEW.stage
    OR OLD.parent_id IS DISTINCT FROM NEW.parent_id
    OR OLD.content IS DISTINCT FROM NEW.content
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
  )
  EXECUTE FUNCTION public.capture_task_change_audit();

DROP TRIGGER IF EXISTS trg_task_change_audit_delete ON public.tasks;
CREATE TRIGGER trg_task_change_audit_delete
  AFTER DELETE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.capture_task_change_audit();

CREATE TABLE IF NOT EXISTS public.task_change_audit_archive
  (LIKE public.task_change_audit INCLUDING ALL);

-- Final convergence: 20260728000900 task_change_audit_archive project unused index retirement
DO $task_change_audit_archive_project_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.task_change_audit_archive_project_id_changed_at_idx');

  IF target_index IS NOT NULL THEN
    SELECT
      lower(regexp_replace(pg_get_indexdef(index_row.indexrelid), '\s+', ' ', 'g')),
      lower(regexp_replace(pg_get_expr(index_row.indpred, index_row.indrelid), '\s+', ' ', 'g'))
    INTO
      normalized_index_definition,
      normalized_predicate
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_row.indexrelid = target_index
      AND index_row.indrelid = 'public.task_change_audit_archive'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index task_change_audit_archive_project_id_changed_at_idx on public.task_change_audit_archive using btree (project_id, changed_at desc)'
      OR normalized_predicate IS NOT NULL
    THEN
      RAISE EXCEPTION 'task_change_audit_archive project legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.task_change_audit_archive_project_id_changed_at_idx on public.task_change_audit_archive(project_id, changed_at DESC) without predicate, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$task_change_audit_archive_project_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.task_change_audit_archive_project_id_changed_at_idx;
SET LOCAL lock_timeout = DEFAULT;

-- Final convergence: 20260728001000 task_change_audit_archive task unused index retirement
DO $task_change_audit_archive_task_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.task_change_audit_archive_task_id_changed_at_idx');

  IF target_index IS NOT NULL THEN
    SELECT
      lower(regexp_replace(pg_get_indexdef(index_row.indexrelid), '\s+', ' ', 'g')),
      lower(regexp_replace(pg_get_expr(index_row.indpred, index_row.indrelid), '\s+', ' ', 'g'))
    INTO
      normalized_index_definition,
      normalized_predicate
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_row.indexrelid = target_index
      AND index_row.indrelid = 'public.task_change_audit_archive'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index task_change_audit_archive_task_id_changed_at_idx on public.task_change_audit_archive using btree (task_id, changed_at desc)'
      OR normalized_predicate IS NOT NULL
    THEN
      RAISE EXCEPTION 'task_change_audit_archive task legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.task_change_audit_archive_task_id_changed_at_idx on public.task_change_audit_archive(task_id, changed_at DESC) without predicate, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$task_change_audit_archive_task_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.task_change_audit_archive_task_id_changed_at_idx;
SET LOCAL lock_timeout = DEFAULT;

-- Final convergence: 20260728001100 task_change_audit_archive owner unused index retirement
DO $task_change_audit_archive_owner_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.task_change_audit_archive_owner_id_changed_at_idx');

  IF target_index IS NOT NULL THEN
    SELECT
      lower(regexp_replace(pg_get_indexdef(index_row.indexrelid), '\s+', ' ', 'g')),
      lower(regexp_replace(pg_get_expr(index_row.indpred, index_row.indrelid), '\s+', ' ', 'g'))
    INTO
      normalized_index_definition,
      normalized_predicate
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_row.indexrelid = target_index
      AND index_row.indrelid = 'public.task_change_audit_archive'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index task_change_audit_archive_owner_id_changed_at_idx on public.task_change_audit_archive using btree (owner_id, changed_at desc)'
      OR normalized_predicate IS NOT NULL
    THEN
      RAISE EXCEPTION 'task_change_audit_archive owner legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.task_change_audit_archive_owner_id_changed_at_idx on public.task_change_audit_archive(owner_id, changed_at DESC) without predicate, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$task_change_audit_archive_owner_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.task_change_audit_archive_owner_id_changed_at_idx;
SET LOCAL lock_timeout = DEFAULT;

ALTER TABLE public.task_change_audit_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_change_audit_archive FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.task_change_audit_archive FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.task_change_audit_archive TO service_role;

DROP POLICY IF EXISTS task_change_audit_archive_service_all ON public.task_change_audit_archive;
CREATE POLICY task_change_audit_archive_service_all
  ON public.task_change_audit_archive
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Final convergence: 20260531124000 task_change_audit_archive suspicious partial index cleanup
DO $task_change_audit_archive_suspicious_index_cleanup$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.task_change_audit_archive_owner_id_changed_at_idx1');

  IF target_index IS NOT NULL THEN
    SELECT
      lower(regexp_replace(pg_get_indexdef(index_row.indexrelid), '\s+', ' ', 'g')),
      lower(regexp_replace(pg_get_expr(index_row.indpred, index_row.indrelid), '\s+', ' ', 'g'))
    INTO
      normalized_index_definition,
      normalized_predicate
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_row.indexrelid = target_index
      AND index_row.indrelid = 'public.task_change_audit_archive'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NOT NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index task_change_audit_archive_owner_id_changed_at_idx1 on public.task_change_audit_archive using btree (owner_id, changed_at desc) where suspicious'
      OR normalized_predicate IS DISTINCT FROM 'suspicious'
    THEN
      RAISE EXCEPTION 'task_change_audit_archive suspicious legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.task_change_audit_archive_owner_id_changed_at_idx1 on public.task_change_audit_archive(owner_id, changed_at DESC) WHERE suspicious, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$task_change_audit_archive_suspicious_index_cleanup$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.task_change_audit_archive_owner_id_changed_at_idx1;
SET LOCAL lock_timeout = DEFAULT;

CREATE OR REPLACE FUNCTION public.archive_old_task_change_audit(
  p_retention INTERVAL DEFAULT INTERVAL '180 days'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size CONSTANT INTEGER := 5000;
  v_moved INTEGER := 0;
BEGIN
  IF p_retention IS NULL OR p_retention <= interval '0' THEN
    RAISE EXCEPTION 'p_retention must be a positive interval'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT audit.id
    FROM public.task_change_audit AS audit
    WHERE audit.changed_at < now() - p_retention
    ORDER BY audit.changed_at ASC, audit.id ASC
    LIMIT v_batch_size
    FOR UPDATE OF audit SKIP LOCKED
  ),
  moved AS (
    DELETE FROM public.task_change_audit AS audit
    USING candidates
    WHERE audit.id = candidates.id
    RETURNING audit.*
  )
  INSERT INTO public.task_change_audit_archive OVERRIDING SYSTEM VALUE
  SELECT * FROM moved
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS v_moved = ROW_COUNT;
  RETURN v_moved;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_old_task_change_audit(INTERVAL)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_old_task_change_audit(INTERVAL) TO service_role;

ALTER TABLE public.connection_tombstones ADD COLUMN IF NOT EXISTS source_id uuid, ADD COLUMN IF NOT EXISTS target_id uuid;

UPDATE public.connection_tombstones ct
SET
  source_id = c.source_id,
  target_id = c.target_id
FROM public.connections c
WHERE ct.connection_id = c.id
  AND (ct.source_id IS NULL OR ct.target_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_connection_tombstones_project_source_target_deleted
  ON public.connection_tombstones (project_id, source_id, target_id, deleted_at DESC)
  WHERE source_id IS NOT NULL AND target_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_connection_tombstones_legacy_project_deleted
  ON public.connection_tombstones (project_id, deleted_at DESC)
  WHERE source_id IS NULL AND target_id IS NULL;

CREATE OR REPLACE FUNCTION public.record_connection_tombstone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  INSERT INTO public.connection_tombstones (
    connection_id,
    project_id,
    source_id,
    target_id,
    deleted_at,
    deleted_by
  )
  VALUES (
    OLD.id,
    OLD.project_id,
    OLD.source_id,
    OLD.target_id,
    now(),
    auth.uid()
  )
  ON CONFLICT (connection_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    source_id = COALESCE(EXCLUDED.source_id, public.connection_tombstones.source_id),
    target_id = COALESCE(EXCLUDED.target_id, public.connection_tombstones.target_id),
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_connection_tombstone ON public.connections;
CREATE TRIGGER trg_record_connection_tombstone
  BEFORE DELETE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.record_connection_tombstone();

CREATE OR REPLACE FUNCTION public.prevent_soft_deleted_row_resurrection()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'soft-deleted % row cannot be resurrected via sync write', TG_TABLE_NAME
      USING ERRCODE = 'P0001',
            DETAIL = format('id=%s old_deleted_at=%s', COALESCE(NEW.id::text, '<unknown>'), OLD.deleted_at::text),
            HINT = 'Pull latest remote state instead of clearing deleted_at.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_project_resurrection ON public.projects;
CREATE TRIGGER trg_prevent_project_resurrection
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_soft_deleted_row_resurrection();

DROP TRIGGER IF EXISTS trg_prevent_black_box_resurrection ON public.black_box_entries;
CREATE TRIGGER trg_prevent_black_box_resurrection
  BEFORE UPDATE ON public.black_box_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_soft_deleted_row_resurrection();

DROP TRIGGER IF EXISTS trg_prevent_connection_resurrection ON public.connections;
CREATE TRIGGER trg_prevent_connection_resurrection
  BEFORE UPDATE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_soft_deleted_row_resurrection();

CREATE OR REPLACE FUNCTION public.prevent_black_box_content_loss()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.content IS NULL OR btrim(NEW.content) = '' THEN
    IF TG_OP = 'UPDATE'
      AND OLD.content IS NOT NULL
      AND btrim(OLD.content) <> ''
    THEN
      NEW.content := OLD.content;
      RETURN NEW;
    END IF;

    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'black_box_content_required',
      DETAIL = 'black_box_entries.content cannot be empty for new entries.',
      HINT = 'Hydrate the outgoing BlackBox payload from IndexedDB or pull the current server row before retrying.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_black_box_content_loss ON public.black_box_entries;
CREATE TRIGGER protect_black_box_content_loss
  BEFORE INSERT OR UPDATE ON public.black_box_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_black_box_content_loss();

REVOKE ALL ON FUNCTION public.prevent_black_box_content_loss() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_black_box_content_loss() TO service_role;

-- ============================================================
-- Task attention sidecar overlay (2026-06-05)
-- 使一次性初始化后的最终状态包含任务僚机字段、读取 RPC 与批量写入保护。
-- ============================================================

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS attention_meta jsonb;

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE public.tasks
  ALTER COLUMN cognitive_load DROP DEFAULT;

COMMENT ON COLUMN public.tasks.attention_meta IS
  '任务僚机注意事项元数据（JSONB）。仅解释任务自身，不参与流程图拓扑。';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_attention_meta_size_check' AND conrelid = 'public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_attention_meta_size_check CHECK (attention_meta IS NULL OR pg_column_size(attention_meta) <= 262144);
  END IF;
END $$;

CREATE OR REPLACE VIEW public.active_tasks WITH (security_invoker = true) AS
SELECT
  t.id,
  t.project_id,
  t.parent_id,
  t.title,
  t.content,
  t.stage,
  t."order",
  t.rank,
  t.status,
  t.x,
  t.y,
  t.short_id,
  t.priority,
  t.due_date,
  t.tags,
  t.attachments,
  t.deleted_at,
  t.created_at,
  t.updated_at,
  t.completed_at,
  t.expected_minutes,
  t.cognitive_load,
  t.wait_minutes,
  t.parking_meta,
  t.attention_meta
FROM public.tasks t
WHERE NOT EXISTS (
    SELECT 1
    FROM public.task_tombstones tt
    WHERE tt.task_id = t.id
  )
  AND t.deleted_at IS NULL;

COMMENT ON VIEW public.active_tasks IS
  'Tombstone-aware 任务加载视图，包含任务僚机 attention_meta 与规划字段。';

REVOKE ALL ON TABLE public.active_tasks FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.active_tasks FROM authenticated;
GRANT SELECT ON TABLE public.active_tasks TO authenticated;
GRANT ALL ON TABLE public.active_tasks TO service_role;

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.task_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE public.connection_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_tombstones FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tasks FROM anon;
REVOKE ALL ON TABLE public.connections FROM anon;
REVOKE ALL ON TABLE public.task_tombstones FROM anon;
REVOKE ALL ON TABLE public.connection_tombstones FROM anon;

GRANT SELECT ON TABLE
  public.projects,
  public.tasks,
  public.connections,
  public.task_tombstones,
  public.connection_tombstones
TO authenticated;

-- Canonical owner-only project graph policies for SECURITY INVOKER reads.
-- Cache the current user's active project set once per statement.
DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;
DROP POLICY IF EXISTS tasks_select_optimized ON public.tasks;
DROP POLICY IF EXISTS tasks_insert_optimized ON public.tasks;
DROP POLICY IF EXISTS tasks_update_optimized ON public.tasks;
DROP POLICY IF EXISTS tasks_delete_optimized ON public.tasks;
DROP POLICY IF EXISTS tasks_owner_select ON public.tasks;
DROP POLICY IF EXISTS tasks_owner_insert ON public.tasks;
DROP POLICY IF EXISTS tasks_owner_update ON public.tasks;
DROP POLICY IF EXISTS tasks_owner_delete ON public.tasks;

CREATE POLICY tasks_owner_select ON public.tasks
  FOR SELECT
  TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY tasks_owner_insert ON public.tasks
  FOR INSERT
  TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY tasks_owner_update ON public.tasks
  FOR UPDATE
  TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  )
  WITH CHECK (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY tasks_owner_delete ON public.tasks
  FOR DELETE
  TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "connections owner select" ON public.connections;
DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
DROP POLICY IF EXISTS "connections owner update" ON public.connections;
DROP POLICY IF EXISTS "connections owner delete" ON public.connections;
DROP POLICY IF EXISTS connections_select_optimized ON public.connections;
DROP POLICY IF EXISTS connections_insert_optimized ON public.connections;
DROP POLICY IF EXISTS connections_update_optimized ON public.connections;
DROP POLICY IF EXISTS connections_delete_optimized ON public.connections;
DROP POLICY IF EXISTS connections_owner_select ON public.connections;
DROP POLICY IF EXISTS connections_owner_insert ON public.connections;
DROP POLICY IF EXISTS connections_owner_update ON public.connections;
DROP POLICY IF EXISTS connections_owner_delete ON public.connections;

CREATE POLICY connections_owner_select ON public.connections
  FOR SELECT
  TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY connections_owner_insert ON public.connections
  FOR INSERT
  TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY connections_owner_update ON public.connections
  FOR UPDATE
  TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  )
  WITH CHECK (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY connections_owner_delete ON public.connections
  FOR DELETE
  TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "task_tombstones_select_owner" ON public.task_tombstones;
DROP POLICY IF EXISTS "task_tombstones_insert_owner" ON public.task_tombstones;
DROP POLICY IF EXISTS "tombstones owner select" ON public.task_tombstones;
DROP POLICY IF EXISTS "tombstones owner insert" ON public.task_tombstones;
DROP POLICY IF EXISTS "tombstones owner delete" ON public.task_tombstones;
DROP POLICY IF EXISTS task_tombstones_select_optimized ON public.task_tombstones;
DROP POLICY IF EXISTS task_tombstones_insert_optimized ON public.task_tombstones;
DROP POLICY IF EXISTS task_tombstones_owner_select ON public.task_tombstones;
DROP POLICY IF EXISTS task_tombstones_owner_insert ON public.task_tombstones;

CREATE POLICY task_tombstones_owner_select ON public.task_tombstones
  FOR SELECT
  TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY task_tombstones_owner_insert ON public.task_tombstones
  FOR INSERT
  TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;
DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;
DROP POLICY IF EXISTS connection_tombstones_select_optimized ON public.connection_tombstones;
DROP POLICY IF EXISTS connection_tombstones_insert_optimized ON public.connection_tombstones;
DROP POLICY IF EXISTS connection_tombstones_owner_select ON public.connection_tombstones;
DROP POLICY IF EXISTS connection_tombstones_owner_insert ON public.connection_tombstones;

CREATE POLICY connection_tombstones_owner_select ON public.connection_tombstones
  FOR SELECT
  TO authenticated
  USING (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );
CREATE POLICY connection_tombstones_owner_insert ON public.connection_tombstones
  FOR INSERT
  TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT project_row.id
      FROM public.projects AS project_row
      WHERE project_row.owner_id = (SELECT auth.uid())
        AND project_row.deleted_at IS NULL
    )
  );

CREATE OR REPLACE FUNCTION public.get_full_project_data(p_project_id uuid)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_result json;
BEGIN
  IF NOT public.user_has_project_access(p_project_id) THEN
    RAISE EXCEPTION 'Access denied to project %', p_project_id;
  END IF;

  SELECT json_build_object(
    'project', (
      SELECT row_to_json(p.*)
      FROM (
        SELECT id, owner_id, title, description, created_date, updated_at, deleted_at, version
        FROM public.projects
        WHERE id = p_project_id
      ) p
    ),
    'tasks', COALESCE((
      SELECT json_agg(row_to_json(t.*) ORDER BY t."order")
      FROM (
        SELECT
          id,
          project_id,
          title,
          content,
          stage,
          parent_id,
          "order",
          rank,
          status,
          x,
          y,
          updated_at,
          deleted_at,
          short_id,
          attachments,
          tags,
          priority,
          due_date,
          expected_minutes,
          cognitive_load,
          wait_minutes,
          created_at,
          completed_at,
          parking_meta,
          attention_meta
        FROM public.tasks
        WHERE project_id = p_project_id
      ) t
    ), '[]'::json),
    'connections', COALESCE((
      SELECT json_agg(row_to_json(c.*))
      FROM (
        SELECT id, source_id, target_id, title, description, deleted_at, updated_at
        FROM public.connections
        WHERE project_id = p_project_id
      ) c
    ), '[]'::json),
    'task_tombstones', COALESCE((
      SELECT json_agg(task_id)
      FROM public.task_tombstones
      WHERE project_id = p_project_id
    ), '[]'::json),
    'connection_tombstones', COALESCE((
      SELECT json_agg(connection_id)
      FROM public.connection_tombstones
      WHERE project_id = p_project_id
    ), '[]'::json)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.get_full_project_data(uuid) IS
  'Retired owner-only full-project JSON aggregate; clients use paginated project graph reads.';

-- Legacy full-project aggregate RPC retired after paginated loader convergence.
REVOKE ALL ON FUNCTION public.get_full_project_data(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(
  p_tasks jsonb[],
  p_project_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  v_count integer := 0;
  v_task jsonb;
  v_task_id uuid;
  v_user_id uuid;
  v_title text;
  v_content text;
  v_has_content boolean;
  v_has_attachments boolean;
  v_has_tags boolean;
  v_has_attention_meta boolean;
  v_priority text;
  v_due_date timestamptz;
  v_completed_at timestamptz;
  v_cognitive text;
  v_expected int;
  v_wait int;
  v_payload_updated timestamptz;
  v_existing_updated timestamptz;
  v_existing_stage int;
  v_existing_parent uuid;
  v_existing_deleted timestamptz;
  v_existing_exists boolean;
  v_is_stale boolean;
  v_skew_grace constant interval := interval '1 second';
  v_sync_mode text;
  v_write_intent text;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
  END IF;

  SELECT value INTO v_sync_mode
  FROM public.data_safety_flags
  WHERE key = 'sync_mode';
  v_sync_mode := COALESCE(v_sync_mode, 'normal');

  IF v_sync_mode IN ('read_only', 'quarantine') THEN
    RAISE EXCEPTION 'sync_write_blocked: %', v_sync_mode;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: not project owner';
  END IF;

  IF COALESCE(array_length(p_tasks, 1), 0) > 100 THEN
    RAISE EXCEPTION 'task batch too large (max 100)';
  END IF;

  FOREACH v_task IN ARRAY p_tasks
  LOOP
    v_title := v_task->>'title';
    v_content := v_task->>'content';
    v_has_content := v_task ? 'content';
    v_has_attachments := v_task ? 'attachments';
    v_has_tags := v_task ? 'tags';
    v_has_attention_meta := (v_task ? 'attentionMeta') OR (v_task ? 'attention_meta');
    v_task_id := (v_task->>'id')::uuid;
    v_write_intent := COALESCE(NULLIF(v_task->>'write_intent', ''), NULLIF(v_task->>'writeIntent', ''), 'task_full_upsert');

    IF v_write_intent NOT IN ('task_full_upsert', 'task_text_update', 'task_structure_update', 'task_soft_delete', 'task_attachment_update') THEN
      RAISE EXCEPTION 'Unsupported task write intent % for task %', v_write_intent, v_task->>'id';
    END IF;

    IF v_title IS NOT NULL AND length(v_title) > 10000 THEN
      RAISE EXCEPTION 'Title too long (max 10000 chars) for task %', v_task->>'id';
    END IF;
    IF v_content IS NOT NULL AND length(v_content) > 1000000 THEN
      RAISE EXCEPTION 'Content too long (max 1000000 chars) for task %', v_task->>'id';
    END IF;

    v_expected := NULLIF(COALESCE(v_task->>'expectedMinutes', v_task->>'expected_minutes'), '')::integer;
    v_wait := NULLIF(COALESCE(v_task->>'waitMinutes', v_task->>'wait_minutes'), '')::integer;
    v_cognitive := NULLIF(COALESCE(v_task->>'cognitiveLoad', v_task->>'cognitive_load'), '');
    v_priority := NULLIF(v_task->>'priority', '');
    v_due_date := NULLIF(COALESCE(v_task->>'dueDate', v_task->>'due_date'), '')::timestamptz;
    v_completed_at := NULLIF(COALESCE(v_task->>'completedAt', v_task->>'completed_at'), '')::timestamptz;

    IF v_expected IS NOT NULL AND (v_expected <= 0 OR v_expected > 14400) THEN
      RAISE EXCEPTION 'expected_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_wait IS NOT NULL AND (v_wait <= 0 OR v_wait > 14400) THEN
      RAISE EXCEPTION 'wait_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_cognitive IS NOT NULL AND v_cognitive NOT IN ('low', 'high') THEN
      RAISE EXCEPTION 'cognitive_load must be low or high for task %', v_task->>'id';
    END IF;

    v_payload_updated := NULLIF(v_task->>'updated_at', '')::timestamptz;
    IF v_payload_updated IS NULL THEN
      v_payload_updated := NULLIF(v_task->>'updatedAt', '')::timestamptz;
    END IF;

    v_existing_exists := FALSE;
    SELECT TRUE, t.updated_at, t.stage, t.parent_id, t.deleted_at
      INTO v_existing_exists, v_existing_updated, v_existing_stage, v_existing_parent, v_existing_deleted
      FROM public.tasks t
      WHERE t.id = v_task_id
        AND t.project_id = p_project_id
      FOR UPDATE;

    v_is_stale := COALESCE(
      v_existing_exists
        AND v_payload_updated IS NOT NULL
        AND v_existing_updated IS NOT NULL
        AND v_existing_updated > v_payload_updated + v_skew_grace,
      FALSE
    );

    IF v_existing_exists AND v_payload_updated IS NULL THEN
      CONTINUE;
    END IF;

    IF v_is_stale THEN
      CONTINUE;
    END IF;

    INSERT INTO public.tasks AS existing (
      id, project_id, title, content, stage, parent_id,
      "order", rank, status, x, y, short_id, deleted_at,
      attachments, tags, priority, due_date, completed_at,
      expected_minutes, cognitive_load, wait_minutes, parking_meta, attention_meta
    )
    VALUES (
      v_task_id,
      p_project_id,
      v_title,
      CASE WHEN v_has_content THEN v_content ELSE '' END,
      NULLIF(v_task->>'stage', '')::integer,
      NULLIF(COALESCE(v_task->>'parentId', v_task->>'parent_id'), '')::uuid,
      COALESCE((v_task->>'order')::integer, 0),
      COALESCE((v_task->>'rank')::numeric, 10000),
      COALESCE(v_task->>'status', 'active'),
      COALESCE((v_task->>'x')::numeric, 0),
      COALESCE((v_task->>'y')::numeric, 0),
      COALESCE(v_task->>'shortId', v_task->>'short_id'),
      NULLIF(COALESCE(v_task->>'deletedAt', v_task->>'deleted_at'), '')::timestamptz,
      CASE WHEN v_has_attachments THEN COALESCE(v_task->'attachments', '[]'::jsonb) ELSE '[]'::jsonb END,
      CASE WHEN v_has_tags THEN COALESCE(v_task->'tags', '[]'::jsonb) ELSE '[]'::jsonb END,
      v_priority,
      v_due_date,
      v_completed_at,
      v_expected,
      v_cognitive,
      v_wait,
      COALESCE(v_task->'parkingMeta', v_task->'parking_meta'),
      COALESCE(v_task->'attentionMeta', v_task->'attention_meta')
    )
    ON CONFLICT (id) DO UPDATE SET
      title = CASE WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete', 'task_attachment_update') THEN existing.title ELSE EXCLUDED.title END,
      content = CASE
        WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete', 'task_attachment_update') THEN existing.content
        WHEN v_has_content THEN EXCLUDED.content
        ELSE existing.content
      END,
      stage = CASE WHEN v_write_intent IN ('task_text_update', 'task_soft_delete', 'task_attachment_update') THEN existing.stage ELSE EXCLUDED.stage END,
      parent_id = CASE WHEN v_write_intent IN ('task_text_update', 'task_soft_delete', 'task_attachment_update') THEN existing.parent_id ELSE EXCLUDED.parent_id END,
      deleted_at = CASE
        WHEN v_write_intent = 'task_soft_delete' THEN EXCLUDED.deleted_at
        WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_attachment_update') THEN existing.deleted_at
        ELSE EXCLUDED.deleted_at
      END,
      "order" = CASE WHEN v_write_intent IN ('task_text_update', 'task_attachment_update') THEN existing."order" ELSE EXCLUDED."order" END,
      rank = CASE WHEN v_write_intent IN ('task_text_update', 'task_attachment_update') THEN existing.rank ELSE EXCLUDED.rank END,
      status = CASE WHEN v_write_intent IN ('task_structure_update', 'task_attachment_update') THEN existing.status ELSE EXCLUDED.status END,
      x = CASE WHEN v_write_intent IN ('task_text_update', 'task_attachment_update') THEN existing.x ELSE EXCLUDED.x END,
      y = CASE WHEN v_write_intent IN ('task_text_update', 'task_attachment_update') THEN existing.y ELSE EXCLUDED.y END,
      short_id = CASE WHEN v_write_intent = 'task_attachment_update' THEN existing.short_id ELSE EXCLUDED.short_id END,
      attachments = CASE
        WHEN NOT v_has_attachments THEN existing.attachments
        WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_soft_delete') THEN existing.attachments
        ELSE EXCLUDED.attachments
      END,
      tags = CASE
        WHEN NOT v_has_tags THEN existing.tags
        WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_soft_delete', 'task_attachment_update') THEN existing.tags
        ELSE EXCLUDED.tags
      END,
      priority = CASE WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_attachment_update') THEN existing.priority ELSE EXCLUDED.priority END,
      due_date = CASE WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_attachment_update') THEN existing.due_date ELSE EXCLUDED.due_date END,
      completed_at = CASE WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_attachment_update') THEN existing.completed_at ELSE EXCLUDED.completed_at END,
      expected_minutes = CASE WHEN v_write_intent IN ('task_structure_update', 'task_attachment_update') THEN existing.expected_minutes ELSE EXCLUDED.expected_minutes END,
      cognitive_load = CASE WHEN v_write_intent IN ('task_structure_update', 'task_attachment_update') THEN existing.cognitive_load ELSE EXCLUDED.cognitive_load END,
      wait_minutes = CASE WHEN v_write_intent IN ('task_structure_update', 'task_attachment_update') THEN existing.wait_minutes ELSE EXCLUDED.wait_minutes END,
      parking_meta = CASE WHEN v_write_intent IN ('task_structure_update', 'task_attachment_update') THEN existing.parking_meta ELSE EXCLUDED.parking_meta END,
      attention_meta = CASE
        WHEN NOT v_has_attention_meta THEN existing.attention_meta
        WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete', 'task_attachment_update') THEN existing.attention_meta
        ELSE EXCLUDED.attention_meta
      END,
      updated_at = now()
    WHERE existing.project_id = p_project_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Task project mismatch';
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS
  'Owner-only batch upsert with stale-payload skip, sync freeze checks, missing-content guard, attachment payload sync, transitional write intents, and task attention_meta support. Returns rows actually applied.';

REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.sync_check_protocol()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_min INTEGER;
  v_epoch BIGINT;
BEGIN
  SELECT min_protocol_version, deployment_epoch
    INTO v_min, v_epoch
    FROM public.sync_protocol_state
    WHERE scope = 'global';
  RETURN jsonb_build_object(
    'minProtocolVersion', COALESCE(v_min, 1),
    'deploymentEpoch', COALESCE(v_epoch, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_check_protocol() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_check_protocol() TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_extract_local_updated(payload JSONB, entity_key TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT NULLIF(
    COALESCE(
      payload->entity_key->>'updated_at',
      payload->entity_key->>'updatedAt',
      payload->>'base_updated_at'
    ),
    ''
  )::TIMESTAMPTZ;
$$;

REVOKE ALL ON FUNCTION public.sync_extract_local_updated(JSONB, TEXT) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.sync_task_changed_fields(
  p_task_id UUID,
  p_task JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_remote public.tasks%ROWTYPE;
  v_changed_fields JSONB := '[]'::jsonb;
BEGIN
  SELECT task.*
    INTO v_remote
    FROM public.tasks AS task
    JOIN public.projects AS project ON project.id = task.project_id
   WHERE task.id = p_task_id
     AND project.owner_id = auth.uid();

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF (p_task ? 'project_id')
    AND v_remote.project_id IS DISTINCT FROM NULLIF(p_task->>'project_id', '')::UUID
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('project_id');
  END IF;
  IF ((p_task ? 'parent_id') OR (p_task ? 'parentId'))
    AND v_remote.parent_id IS DISTINCT FROM NULLIF(COALESCE(p_task->>'parent_id', p_task->>'parentId'), '')::UUID
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('parent_id');
  END IF;
  IF (p_task ? 'title') AND v_remote.title IS DISTINCT FROM p_task->>'title' THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('title');
  END IF;
  IF (p_task ? 'content') AND v_remote.content IS DISTINCT FROM p_task->>'content' THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('content');
  END IF;
  IF (p_task ? 'stage') AND v_remote.stage IS DISTINCT FROM NULLIF(p_task->>'stage', '')::INTEGER THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('stage');
  END IF;
  IF (p_task ? 'order') AND v_remote."order" IS DISTINCT FROM NULLIF(p_task->>'order', '')::INTEGER THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('order');
  END IF;
  IF (p_task ? 'rank') AND v_remote.rank IS DISTINCT FROM NULLIF(p_task->>'rank', '')::NUMERIC THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('rank');
  END IF;
  IF (p_task ? 'status') AND v_remote.status IS DISTINCT FROM p_task->>'status' THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('status');
  END IF;
  IF (p_task ? 'x') AND v_remote.x IS DISTINCT FROM NULLIF(p_task->>'x', '')::NUMERIC THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('x');
  END IF;
  IF (p_task ? 'y') AND v_remote.y IS DISTINCT FROM NULLIF(p_task->>'y', '')::NUMERIC THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('y');
  END IF;
  IF ((p_task ? 'short_id') OR (p_task ? 'shortId'))
    AND v_remote.short_id IS DISTINCT FROM COALESCE(p_task->>'short_id', p_task->>'shortId')
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('short_id');
  END IF;
  IF (p_task ? 'priority') AND v_remote.priority IS DISTINCT FROM p_task->>'priority' THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('priority');
  END IF;
  IF ((p_task ? 'due_date') OR (p_task ? 'dueDate'))
    AND v_remote.due_date IS DISTINCT FROM NULLIF(COALESCE(p_task->>'due_date', p_task->>'dueDate'), '')::TIMESTAMPTZ
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('due_date');
  END IF;
  IF ((p_task ? 'expected_minutes') OR (p_task ? 'expectedMinutes'))
    AND v_remote.expected_minutes IS DISTINCT FROM NULLIF(COALESCE(p_task->>'expected_minutes', p_task->>'expectedMinutes'), '')::INTEGER
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('expected_minutes');
  END IF;
  IF ((p_task ? 'cognitive_load') OR (p_task ? 'cognitiveLoad'))
    AND v_remote.cognitive_load IS DISTINCT FROM COALESCE(p_task->>'cognitive_load', p_task->>'cognitiveLoad')
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('cognitive_load');
  END IF;
  IF ((p_task ? 'wait_minutes') OR (p_task ? 'waitMinutes'))
    AND v_remote.wait_minutes IS DISTINCT FROM NULLIF(COALESCE(p_task->>'wait_minutes', p_task->>'waitMinutes'), '')::INTEGER
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('wait_minutes');
  END IF;
  IF (p_task ? 'tags')
    AND v_remote.tags IS DISTINCT FROM NULLIF(p_task->'tags', 'null'::jsonb)
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('tags');
  END IF;
  IF (p_task ? 'attachments')
    AND v_remote.attachments IS DISTINCT FROM NULLIF(p_task->'attachments', 'null'::jsonb)
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('attachments');
  END IF;
  IF ((p_task ? 'deleted_at') OR (p_task ? 'deletedAt'))
    AND v_remote.deleted_at IS DISTINCT FROM NULLIF(COALESCE(p_task->>'deleted_at', p_task->>'deletedAt'), '')::TIMESTAMPTZ
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('deleted_at');
  END IF;
  IF ((p_task ? 'completed_at') OR (p_task ? 'completedAt'))
    AND v_remote.completed_at IS DISTINCT FROM NULLIF(COALESCE(p_task->>'completed_at', p_task->>'completedAt'), '')::TIMESTAMPTZ
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('completed_at');
  END IF;
  IF ((p_task ? 'parking_meta') OR (p_task ? 'parkingMeta'))
    AND v_remote.parking_meta IS DISTINCT FROM NULLIF(COALESCE(p_task->'parking_meta', p_task->'parkingMeta'), 'null'::jsonb)
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('parking_meta');
  END IF;
  IF ((p_task ? 'attention_meta') OR (p_task ? 'attentionMeta'))
    AND v_remote.attention_meta IS DISTINCT FROM NULLIF(COALESCE(p_task->'attention_meta', p_task->'attentionMeta'), 'null'::jsonb)
  THEN
    v_changed_fields := v_changed_fields || jsonb_build_array('attention_meta');
  END IF;

  RETURN v_changed_fields;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_task_changed_fields(UUID, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_upsert_task(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_local_updated TIMESTAMPTZ := public.sync_extract_local_updated(payload, 'task');
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_task JSONB := payload->'task';
  v_task_id UUID := (v_task->>'id')::UUID;
  v_project_id UUID := (v_task->>'project_id')::UUID;
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_owner UUID;
  v_existing_project_id UUID;
  v_existing_updated TIMESTAMPTZ;
  v_existing_stage INTEGER;
  v_existing_parent UUID;
  v_existing_content TEXT;
  v_existing_title TEXT;
  v_existing_deleted TIMESTAMPTZ;
  v_existing_attention_meta JSONB;
  v_payload_stage INTEGER;
  v_payload_parent UUID;
  v_payload_deleted TIMESTAMPTZ;
  v_task_for_write JSONB;
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
  v_sync_mode TEXT;
  v_quarantine_id BIGINT;
  v_origin_unverified BOOLEAN := true;
  v_changed_fields JSONB := '[]'::jsonb;
  v_audit_id BIGINT;
  v_skew_grace CONSTANT INTERVAL := INTERVAL '1 second';
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'no auth');
  END IF;
  IF v_op_id IS NULL OR v_task_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_task'), hashtext(v_task_id::TEXT));

  SELECT user_id, payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    IF v_log_existing.payload_digest IS NOT NULL
      AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN jsonb_build_object(
        'status', 'unauthorized',
        'reason', 'operation_id_payload_mismatch',
        'operation_id', v_op_id,
        'existing_payload_digest', v_log_existing.payload_digest,
        'payload_digest', v_payload_digest
      );
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    v_result := jsonb_build_object(
      'status', 'client-version-rejected',
      'decision', 'rejected',
      'reason', CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'client-version-rejected',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  SELECT COALESCE(value, 'normal') INTO v_sync_mode
    FROM public.data_safety_flags
    WHERE key = 'sync_mode';
  v_sync_mode := COALESCE(v_sync_mode, 'normal');

  SELECT NOT EXISTS (
    SELECT 1
    FROM public.sync_trusted_client_deployments d
    WHERE d.client_git_sha = v_client_git
      AND d.deployment_epoch = v_client_epoch
      AND (d.deployment_target IS NULL OR d.deployment_target = v_deployment_target)
      AND d.retired_at IS NULL
  ) INTO v_origin_unverified;

  v_origin_unverified := v_origin_unverified
    OR v_client_git IS NULL OR btrim(v_client_git) = ''
    OR v_client_origin IS NULL OR btrim(v_client_origin) = '';

  SELECT p.owner_id INTO v_existing_owner FROM public.projects p WHERE p.id = v_project_id;
  IF v_existing_owner IS DISTINCT FROM v_user THEN
    v_result := jsonb_build_object('status', 'unauthorized', 'decision', 'rejected', 'reason', 'project_not_owned');
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'unauthorized',
      'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  SELECT t.project_id, p.owner_id, t.updated_at, t.stage, t.parent_id, t.content, t.title, t.deleted_at, t.attention_meta
    INTO v_existing_project_id, v_existing_owner, v_existing_updated, v_existing_stage,
      v_existing_parent, v_existing_content, v_existing_title, v_existing_deleted, v_existing_attention_meta
    FROM public.tasks t
    JOIN public.projects p ON p.id = t.project_id
    WHERE t.id = v_task_id
    FOR UPDATE;

  IF v_existing_project_id IS NOT NULL
    AND (v_existing_project_id <> v_project_id OR v_existing_owner IS DISTINCT FROM v_user)
  THEN
    v_result := jsonb_build_object('status', 'unauthorized', 'decision', 'rejected', 'reason', 'task_owned_by_other_project');
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'unauthorized',
      'task_owned_by_other_project', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  v_payload_stage := NULLIF(v_task->>'stage', '')::INTEGER;
  v_payload_parent := NULLIF(COALESCE(v_task->>'parentId', v_task->>'parent_id'), '')::UUID;
  v_payload_deleted := NULLIF(COALESCE(v_task->>'deletedAt', v_task->>'deleted_at'), '')::TIMESTAMPTZ;
  v_task_for_write := v_task;
  IF v_local_updated IS NOT NULL
    AND NOT (v_task_for_write ? 'updated_at')
    AND NOT (v_task_for_write ? 'updatedAt')
  THEN
    v_task_for_write := jsonb_set(v_task_for_write, '{updated_at}', to_jsonb(v_local_updated::TEXT), true);
  END IF;

  v_changed_fields := public.sync_task_changed_fields(v_task_id, v_task);
  IF v_changed_fields IS NULL THEN
    v_changed_fields := jsonb_build_array('insert');
  END IF;

  IF v_existing_project_id IS NOT NULL AND v_local_updated IS NULL THEN
    IF v_sync_mode = 'quarantine' THEN
      v_quarantine_id := public.record_sync_write_quarantine(
        v_op_id, v_user, 'task', v_task_id, v_client_git, v_client_origin, 'missing_task_timestamp', payload
      );
    END IF;

    v_result := jsonb_build_object(
      'status', CASE WHEN v_quarantine_id IS NULL THEN 'remote-newer' ELSE 'quarantined' END,
      'decision', CASE WHEN v_quarantine_id IS NULL THEN 'rejected' ELSE 'quarantined' END,
      'reason', 'missing_task_timestamp',
      'quarantine_id', v_quarantine_id,
      'remote_updated_at', v_existing_updated,
      'changed_fields', v_changed_fields
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, CASE WHEN v_quarantine_id IS NULL THEN 'remote-newer' ELSE 'quarantined' END,
      'missing_task_timestamp', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);

    RETURN v_result;
  END IF;

  IF v_sync_mode = 'read_only' THEN
    v_result := jsonb_build_object(
      'status', 'remote-newer',
      'decision', 'rejected',
      'reason', 'sync_read_only',
      'remote_updated_at', v_existing_updated,
      'changed_fields', v_changed_fields
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'remote-newer',
      'sync_read_only', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);

    RETURN v_result;
  END IF;

  IF v_sync_mode = 'quarantine' THEN
    v_quarantine_id := public.record_sync_write_quarantine(
      v_op_id, v_user, 'task', v_task_id, v_client_git, v_client_origin, 'sync_quarantine', payload
    );
    v_result := jsonb_build_object(
      'status', 'quarantined',
      'decision', 'quarantined',
      'reason', 'sync_quarantine',
      'quarantine_id', v_quarantine_id,
      'changed_fields', v_changed_fields
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'quarantined',
      'sync_quarantine', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);

    RETURN v_result;
  END IF;

  IF v_existing_project_id IS NOT NULL
    AND v_local_updated IS NOT NULL
    AND v_existing_updated IS NOT NULL
    AND v_existing_updated > v_local_updated + v_skew_grace
  THEN
    v_result := jsonb_build_object(
      'status', 'remote-newer',
      'decision', 'rejected',
      'reason', 'stale_task_payload',
      'remote_updated_at', v_existing_updated,
      'changed_fields', v_changed_fields
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'remote-newer',
      'stale_task_payload', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);

    RETURN v_result;
  END IF;

  PERFORM set_config('app.operation_id', v_op_id::TEXT, true);
  PERFORM set_config('app.client_git_sha', COALESCE(v_client_git, ''), true);
  PERFORM set_config('app.client_origin', COALESCE(v_client_origin, ''), true);
  PERFORM set_config('app.deployment_epoch', v_client_epoch::TEXT, true);
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  PERFORM set_config('app.origin_unverified', v_origin_unverified::TEXT, true);

  PERFORM public.batch_upsert_tasks(ARRAY[v_task_for_write], v_project_id);
  SELECT t.updated_at INTO v_written_updated FROM public.tasks t WHERE t.id = v_task_id;
  SELECT a.id INTO v_audit_id
  FROM public.task_change_audit a
  WHERE a.operation_id = v_op_id
    AND a.task_id = v_task_id
  ORDER BY a.id DESC
  LIMIT 1;

  v_result := jsonb_build_object(
    'status', 'applied',
    'decision', 'applied',
    'reason', CASE
      WHEN v_sync_mode = 'audit_only' THEN 'audit_only'
      WHEN v_existing_project_id IS NULL THEN 'insert'
      ELSE 'fresh-local-update'
    END,
    'operation_id', v_op_id,
    'task_id', v_task_id,
    'updated_at', v_written_updated,
    'changed_fields', v_changed_fields,
    'audit_id', v_audit_id,
    'origin_unverified', v_origin_unverified
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
    payload_digest, result_payload)
  VALUES (v_op_id, v_user, 'task', v_task_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
    v_payload_digest, v_result);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_connection(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_local_updated TIMESTAMPTZ := public.sync_extract_local_updated(payload, 'connection');
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_conn JSONB := payload->'connection';
  v_local_deleted TIMESTAMPTZ := NULLIF(payload->'connection'->>'deleted_at', '')::TIMESTAMPTZ;
  v_conn_id UUID := (v_conn->>'id')::UUID;
  v_project_id UUID := (v_conn->>'project_id')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_local_freshness TIMESTAMPTZ;
  v_same_id_tombstone_deleted TIMESTAMPTZ;
  v_endpoint_tombstone_deleted TIMESTAMPTZ;
  v_existing_owner UUID;
  v_existing_project_id UUID;
  v_existing_updated TIMESTAMPTZ;
  v_existing_source UUID;
  v_existing_target UUID;
  v_existing_deleted TIMESTAMPTZ;
  v_is_stale BOOLEAN;
  v_skew_grace CONSTANT INTERVAL := INTERVAL '1 second';
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_conn_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_connection'), hashtext(v_conn_id::TEXT));
  PERFORM set_config('app.payload_digest', v_payload_digest, true);

  SELECT user_id, payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    IF v_log_existing.payload_digest IS NOT NULL
      AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN jsonb_build_object(
        'status', 'unauthorized',
        'reason', 'operation_id_payload_mismatch',
        'operation_id', v_op_id,
        'existing_payload_digest', v_log_existing.payload_digest,
        'payload_digest', v_payload_digest
      );
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'client-version-rejected',
      CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
  END IF;

  SELECT p.owner_id INTO v_existing_owner FROM public.projects p WHERE p.id = v_project_id;
  IF v_existing_owner IS DISTINCT FROM v_user THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'unauthorized',
      'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.tasks source_task
    JOIN public.tasks target_task ON target_task.id = (v_conn->>'target_id')::UUID
    WHERE source_task.id = (v_conn->>'source_id')::UUID
      AND source_task.project_id = v_project_id
      AND target_task.project_id = v_project_id
      AND source_task.deleted_at IS NULL
      AND target_task.deleted_at IS NULL
  ) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'unauthorized',
      'connection_endpoint_not_in_project', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'connection_endpoint_not_in_project');
  END IF;

  v_local_freshness := GREATEST(
    COALESCE(v_local_updated, '-infinity'::TIMESTAMPTZ),
    COALESCE(v_local_deleted, '-infinity'::TIMESTAMPTZ)
  );

  SELECT ct.deleted_at INTO v_same_id_tombstone_deleted
    FROM public.connection_tombstones ct
    WHERE ct.connection_id = v_conn_id
    LIMIT 1;

  IF v_same_id_tombstone_deleted IS NOT NULL THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'remote-newer',
      'connection_tombstone', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'remote-newer',
      'remote_updated_at', v_same_id_tombstone_deleted,
      'reason', 'connection_tombstone'
    );
  END IF;

  SELECT ct.deleted_at INTO v_endpoint_tombstone_deleted
    FROM public.connection_tombstones ct
    WHERE ct.project_id = v_project_id
      AND ct.source_id = (v_conn->>'source_id')::UUID
      AND ct.target_id = (v_conn->>'target_id')::UUID
    ORDER BY ct.deleted_at DESC
    LIMIT 1;

  IF v_endpoint_tombstone_deleted IS NOT NULL AND v_endpoint_tombstone_deleted >= v_local_freshness THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'remote-newer',
      'endpoint_tombstone', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'remote-newer',
      'remote_updated_at', v_endpoint_tombstone_deleted,
      'reason', 'endpoint_tombstone'
    );
  END IF;

  SELECT ct.deleted_at INTO v_endpoint_tombstone_deleted
    FROM public.connection_tombstones ct
    WHERE ct.project_id = v_project_id
      AND ct.source_id IS NULL
      AND ct.target_id IS NULL
    ORDER BY ct.deleted_at DESC
    LIMIT 1;

  IF v_endpoint_tombstone_deleted IS NOT NULL AND v_endpoint_tombstone_deleted >= v_local_freshness THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'remote-newer',
      'legacy_endpointless_tombstone', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'remote-newer',
      'remote_updated_at', v_endpoint_tombstone_deleted,
      'reason', 'legacy_endpointless_tombstone'
    );
  END IF;

  SELECT c.project_id, p.owner_id, c.updated_at, c.source_id, c.target_id, c.deleted_at
    INTO v_existing_project_id, v_existing_owner, v_existing_updated, v_existing_source, v_existing_target, v_existing_deleted
    FROM public.connections c
    JOIN public.projects p ON p.id = c.project_id
    WHERE c.id = v_conn_id
    FOR UPDATE;

  IF v_existing_project_id IS NOT NULL
    AND (v_existing_project_id <> v_project_id OR v_existing_owner IS DISTINCT FROM v_user)
  THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'unauthorized',
      'connection_owned_by_other_project', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'connection_owned_by_other_project');
  END IF;

  v_is_stale := COALESCE(
    v_existing_updated IS NOT NULL
      AND v_local_updated IS NOT NULL
      AND v_existing_updated > v_local_updated + v_skew_grace,
    FALSE
  );

  INSERT INTO public.connections AS c (id, project_id, source_id, target_id, title, description, deleted_at, updated_at)
  VALUES (
    v_conn_id,
    v_project_id,
    (v_conn->>'source_id')::UUID,
    (v_conn->>'target_id')::UUID,
    NULLIF(v_conn->>'title', ''),
    NULLIF(v_conn->>'description', ''),
    NULLIF(v_conn->>'deleted_at', '')::TIMESTAMPTZ,
    NOW()
  )
  ON CONFLICT (id) DO UPDATE
    SET source_id = CASE WHEN v_is_stale THEN v_existing_source ELSE EXCLUDED.source_id END,
        target_id = CASE WHEN v_is_stale THEN v_existing_target ELSE EXCLUDED.target_id END,
        deleted_at = CASE WHEN v_is_stale THEN v_existing_deleted ELSE EXCLUDED.deleted_at END,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        updated_at = NOW()
  RETURNING c.updated_at INTO v_written_updated;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'connection_id', v_conn_id,
    'updated_at', v_written_updated,
    'stale_payload', v_is_stale
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'connection', v_conn_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_blackbox_entry(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_local_updated TIMESTAMPTZ := public.sync_extract_local_updated(payload, 'entry');
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_entry JSONB := payload->'entry';
  v_entry_id UUID := (v_entry->>'id')::UUID;
  v_project_id UUID := NULLIF(v_entry->>'project_id', '')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_owner UUID;
  v_existing_exists BOOLEAN := FALSE;
  v_existing_updated TIMESTAMPTZ;
  v_existing_project UUID;
  v_existing_is_read BOOLEAN;
  v_existing_is_completed BOOLEAN;
  v_existing_completed_at TIMESTAMPTZ;
  v_existing_is_archived BOOLEAN;
  v_existing_snooze_until TIMESTAMPTZ;
  v_existing_snooze_count INTEGER;
  v_existing_deleted TIMESTAMPTZ;
  v_existing_focus_meta JSONB;
  v_is_stale BOOLEAN;
  v_skew_grace CONSTANT INTERVAL := INTERVAL '1 second';
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_entry_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_blackbox_entry'), hashtext(v_entry_id::TEXT));
  PERFORM set_config('app.payload_digest', v_payload_digest, true);

  SELECT user_id, payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    IF v_log_existing.payload_digest IS NOT NULL
      AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN jsonb_build_object(
        'status', 'unauthorized',
        'reason', 'operation_id_payload_mismatch',
        'operation_id', v_op_id,
        'existing_payload_digest', v_log_existing.payload_digest,
        'payload_digest', v_payload_digest
      );
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'client-version-rejected',
      CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
  END IF;

  SELECT TRUE, b.user_id, b.updated_at, b.project_id, b.is_read, b.is_completed,
      b.completed_at, b.is_archived, b.snooze_until, b.snooze_count, b.deleted_at, b.focus_meta
    INTO v_existing_exists, v_existing_owner, v_existing_updated, v_existing_project,
      v_existing_is_read, v_existing_is_completed, v_existing_completed_at, v_existing_is_archived,
      v_existing_snooze_until, v_existing_snooze_count, v_existing_deleted, v_existing_focus_meta
    FROM public.black_box_entries b
    WHERE b.id = v_entry_id
    FOR UPDATE;

  IF v_existing_exists AND v_existing_owner IS NOT NULL AND v_existing_owner <> v_user THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'unauthorized',
      'entry_owned_by_other', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'entry_owned_by_other');
  END IF;

  IF v_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id = v_project_id AND p.owner_id = v_user
  ) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'unauthorized',
      'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
  END IF;

  IF length(COALESCE(v_entry->>'content', '')) > 1000000 THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'content_too_large');
  END IF;

  IF v_entry ? 'focus_meta' AND pg_column_size(v_entry->'focus_meta') > 262144 THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'focus_meta_too_large');
  END IF;

  v_is_stale := COALESCE(
    v_existing_exists
      AND v_local_updated IS NOT NULL
      AND v_existing_updated IS NOT NULL
      AND v_existing_updated > v_local_updated + v_skew_grace,
    FALSE
  );

  INSERT INTO public.black_box_entries AS b (
    id, user_id, project_id, content, date, created_at, updated_at,
    is_read, is_completed, completed_at, is_archived, snooze_until,
    snooze_count, deleted_at, focus_meta
  )
  VALUES (
    v_entry_id,
    v_user,
    v_project_id,
    v_entry->>'content',
    COALESCE(NULLIF(v_entry->>'date','')::DATE, CURRENT_DATE),
    COALESCE(NULLIF(v_entry->>'created_at','')::TIMESTAMPTZ, NOW()),
    NOW(),
    COALESCE((v_entry->>'is_read')::BOOLEAN, FALSE),
    COALESCE((v_entry->>'is_completed')::BOOLEAN, FALSE),
    CASE
      WHEN COALESCE((v_entry->>'is_completed')::BOOLEAN, FALSE) THEN
        COALESCE(NULLIF(v_entry->>'completed_at','')::TIMESTAMPTZ, NULLIF(v_entry->>'completedAt','')::TIMESTAMPTZ, NOW())
      ELSE NULL
    END,
    COALESCE((v_entry->>'is_archived')::BOOLEAN, FALSE),
    NULLIF(v_entry->>'snooze_until','')::TIMESTAMPTZ,
    COALESCE((v_entry->>'snooze_count')::INTEGER, 0),
    NULLIF(v_entry->>'deleted_at','')::TIMESTAMPTZ,
    v_entry->'focus_meta'
  )
  ON CONFLICT (id) DO UPDATE
    SET content = CASE WHEN v_is_stale THEN b.content ELSE EXCLUDED.content END,
        date = CASE WHEN v_is_stale THEN b.date ELSE EXCLUDED.date END,
        project_id = CASE WHEN v_is_stale THEN v_existing_project ELSE EXCLUDED.project_id END,
        is_read = CASE WHEN v_is_stale THEN v_existing_is_read ELSE EXCLUDED.is_read END,
        is_completed = CASE WHEN v_is_stale THEN v_existing_is_completed ELSE EXCLUDED.is_completed END,
        completed_at = CASE WHEN v_is_stale THEN v_existing_completed_at ELSE EXCLUDED.completed_at END,
        is_archived = CASE WHEN v_is_stale THEN v_existing_is_archived ELSE EXCLUDED.is_archived END,
        snooze_until = CASE WHEN v_is_stale THEN v_existing_snooze_until ELSE EXCLUDED.snooze_until END,
        snooze_count = CASE WHEN v_is_stale THEN v_existing_snooze_count ELSE EXCLUDED.snooze_count END,
        deleted_at = CASE WHEN v_is_stale THEN v_existing_deleted ELSE EXCLUDED.deleted_at END,
        focus_meta = CASE WHEN v_is_stale THEN v_existing_focus_meta ELSE EXCLUDED.focus_meta END,
        updated_at = CASE WHEN v_is_stale THEN b.updated_at ELSE NOW() END
  RETURNING b.updated_at INTO v_written_updated;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'entry_id', v_entry_id,
    'updated_at', v_written_updated,
    'stale_payload', v_is_stale
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_project(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_local_updated TIMESTAMPTZ := public.sync_extract_local_updated(payload, 'project');
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_project JSONB := payload->'project';
  v_project_id UUID := (v_project->>'id')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_owner UUID;
  v_existing_updated TIMESTAMPTZ;
  v_existing_deleted TIMESTAMPTZ;
  v_existing_title TEXT;
  v_existing_description TEXT;
  v_existing_version INTEGER;
  v_existing_migrated BOOLEAN;
  v_is_stale BOOLEAN;
  v_skew_grace CONSTANT INTERVAL := INTERVAL '1 second';
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_project'), hashtext(v_project_id::TEXT));
  PERFORM set_config('app.payload_digest', v_payload_digest, true);

  SELECT user_id, payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    IF v_log_existing.payload_digest IS NOT NULL
      AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN jsonb_build_object(
        'status', 'unauthorized',
        'reason', 'operation_id_payload_mismatch',
        'operation_id', v_op_id,
        'existing_payload_digest', v_log_existing.payload_digest,
        'payload_digest', v_payload_digest
      );
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'project', v_project_id, 'client-version-rejected',
      CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
  END IF;

  SELECT owner_id, updated_at, deleted_at, title, description, version, migrated_to_v2
    INTO v_existing_owner, v_existing_updated, v_existing_deleted,
         v_existing_title, v_existing_description, v_existing_version, v_existing_migrated
    FROM public.projects
    WHERE id = v_project_id
    FOR UPDATE;

  IF v_existing_owner IS NOT NULL AND v_existing_owner <> v_user THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'project', v_project_id, 'unauthorized',
      'project_owned_by_other', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_owned_by_other');
  END IF;

  IF v_existing_deleted IS NOT NULL THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'project', v_project_id, 'deleted-remote-newer',
      'remote_project_tombstone', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'deleted-remote-newer',
      'remote_updated_at', COALESCE(v_existing_updated, v_existing_deleted),
      'reason', 'remote_project_tombstone'
    );
  END IF;

  v_is_stale := COALESCE(
    v_existing_updated IS NOT NULL
      AND v_local_updated IS NOT NULL
      AND v_existing_updated > v_local_updated + v_skew_grace,
    FALSE
  );

  IF v_existing_updated IS NULL THEN
    INSERT INTO public.projects AS p (id, owner_id, title, description, version, migrated_to_v2, deleted_at, updated_at)
    VALUES (
      v_project_id,
      v_user,
      v_project->>'title',
      NULLIF(v_project->>'description', ''),
      COALESCE((v_project->>'version')::INTEGER, 1),
      COALESCE((v_project->>'migrated_to_v2')::BOOLEAN, TRUE),
      NULLIF(v_project->>'deleted_at', '')::TIMESTAMPTZ,
      NOW()
    )
    RETURNING p.updated_at INTO v_written_updated;
  ELSE
    UPDATE public.projects AS p
    SET title = CASE WHEN v_is_stale THEN v_existing_title ELSE v_project->>'title' END,
        description = CASE
          WHEN v_is_stale THEN v_existing_description
          ELSE NULLIF(v_project->>'description', '')
        END,
        version = CASE
          WHEN v_is_stale THEN COALESCE(v_existing_version, p.version, 1)
          ELSE COALESCE((v_project->>'version')::INTEGER, p.version, 1)
        END,
        migrated_to_v2 = CASE
          WHEN v_is_stale THEN COALESCE(v_existing_migrated, TRUE)
          ELSE COALESCE((v_project->>'migrated_to_v2')::BOOLEAN, TRUE)
        END,
        deleted_at = CASE
          WHEN v_is_stale THEN v_existing_deleted
          ELSE NULLIF(v_project->>'deleted_at', '')::TIMESTAMPTZ
        END,
        updated_at = NOW()
    WHERE p.id = v_project_id
    RETURNING p.updated_at INTO v_written_updated;
  END IF;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'project_id', v_project_id,
    'updated_at', v_written_updated,
    'stale_payload', v_is_stale
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'project', v_project_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_user_preferences(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_target_user UUID := (payload->>'user_id')::UUID;
  v_base_updated_at TIMESTAMPTZ := NULLIF(payload->>'base_updated_at', '')::TIMESTAMPTZ;
  v_preferences JSONB := COALESCE(payload->'preferences', '{}'::JSONB);
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_log_existing RECORD;
  v_existing_preferences RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'no auth');
  END IF;
  IF v_op_id IS NULL OR v_target_user IS NULL OR v_target_user IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing_or_mismatched_user');
  END IF;
  IF jsonb_typeof(v_preferences) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'invalid_preferences');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_user_preferences'), hashtext(v_target_user::TEXT));
  PERFORM set_config('app.payload_digest', v_payload_digest, true);

  SELECT user_id, payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    IF v_log_existing.payload_digest IS NOT NULL
      AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN jsonb_build_object(
        'status', 'unauthorized',
        'reason', 'operation_id_payload_mismatch',
        'operation_id', v_op_id,
        'existing_payload_digest', v_log_existing.payload_digest,
        'payload_digest', v_payload_digest
      );
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    v_result := jsonb_build_object(
      'status', 'client-version-rejected',
      'reason', CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'user-preferences', v_target_user, 'client-version-rejected',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  SELECT updated_at
    INTO v_existing_preferences
    FROM public.user_preferences WHERE user_id = v_target_user FOR UPDATE;
  IF FOUND AND (
    v_base_updated_at IS NULL
    OR v_existing_preferences.updated_at > v_base_updated_at + INTERVAL '1 second'
  ) THEN
    v_result := jsonb_build_object( 'status', 'remote-newer',
      'remote_updated_at', v_existing_preferences.updated_at,
      'reason', CASE
        WHEN v_base_updated_at IS NULL THEN 'missing_base_updated_at'
        ELSE 'remote_updated_at_after_base'
      END
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'user-preferences', v_target_user, 'remote-newer',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  INSERT INTO public.user_preferences AS prefs (
    id,
    user_id,
    theme,
    layout_direction,
    floating_window_pref,
    color_mode,
    auto_resolve_conflicts,
    local_backup_enabled,
    local_backup_interval_ms,
    last_backup_proof_at,
    focus_preferences,
    updated_at
  )
  VALUES (
    v_target_user,
    v_target_user,
    COALESCE(NULLIF(v_preferences->>'theme', ''), 'default'),
    COALESCE(NULLIF(v_preferences->>'layout_direction', ''), 'ltr'),
    COALESCE(NULLIF(v_preferences->>'floating_window_pref', ''), 'auto'),
    COALESCE(NULLIF(v_preferences->>'color_mode', ''), 'system'),
    COALESCE((v_preferences->>'auto_resolve_conflicts')::BOOLEAN, TRUE),
    COALESCE((v_preferences->>'local_backup_enabled')::BOOLEAN, FALSE),
    COALESCE((v_preferences->>'local_backup_interval_ms')::INTEGER, 3600000),
    NULLIF(v_preferences->>'last_backup_proof_at', '')::TIMESTAMPTZ,
    CASE
      WHEN v_preferences ? 'focus_preferences' THEN v_preferences->'focus_preferences'
      ELSE '{"gateEnabled":true,"strataEnabled":true,"blackBoxEnabled":true,"maxSnoozePerDay":3}'::JSONB
    END,
    NOW()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET theme = CASE WHEN v_preferences ? 'theme' THEN EXCLUDED.theme ELSE prefs.theme END,
      layout_direction = CASE
        WHEN v_preferences ? 'layout_direction' THEN EXCLUDED.layout_direction
        ELSE prefs.layout_direction
      END,
      floating_window_pref = CASE
        WHEN v_preferences ? 'floating_window_pref' THEN EXCLUDED.floating_window_pref
        ELSE prefs.floating_window_pref
      END,
      color_mode = CASE WHEN v_preferences ? 'color_mode' THEN EXCLUDED.color_mode ELSE prefs.color_mode END,
      auto_resolve_conflicts = CASE
        WHEN v_preferences ? 'auto_resolve_conflicts' THEN EXCLUDED.auto_resolve_conflicts
        ELSE prefs.auto_resolve_conflicts
      END,
      local_backup_enabled = CASE
        WHEN v_preferences ? 'local_backup_enabled' THEN EXCLUDED.local_backup_enabled
        ELSE prefs.local_backup_enabled
      END,
      local_backup_interval_ms = CASE
        WHEN v_preferences ? 'local_backup_interval_ms' THEN EXCLUDED.local_backup_interval_ms
        ELSE prefs.local_backup_interval_ms
      END,
      last_backup_proof_at = CASE
        WHEN v_preferences ? 'last_backup_proof_at' THEN EXCLUDED.last_backup_proof_at
        ELSE prefs.last_backup_proof_at
      END,
      focus_preferences = CASE
        WHEN v_preferences ? 'focus_preferences' THEN EXCLUDED.focus_preferences
        ELSE prefs.focus_preferences
      END,
      updated_at = NOW()
  RETURNING prefs.updated_at INTO v_written_updated;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'user_id', v_target_user,
    'updated_at', v_written_updated
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
    payload_digest, result_payload)
  VALUES (v_op_id, v_user, 'user-preferences', v_target_user, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
    v_payload_digest, v_result);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_focus_session(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_record JSONB := COALESCE(payload->'focus_session', '{}'::JSONB);
  v_session_id UUID := (v_record->>'id')::UUID;
  v_target_user UUID := (v_record->>'user_id')::UUID;
  v_session_state JSONB := COALESCE(v_record->'session_state', '{}'::JSONB);
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_log_existing RECORD;
  v_result JSONB;
  v_started_at TIMESTAMPTZ;
  v_ended_at TIMESTAMPTZ;
  v_local_updated TIMESTAMPTZ;
  v_local_saved_at TIMESTAMPTZ;
  v_existing_owner UUID;
  v_existing_updated TIMESTAMPTZ;
  v_existing_saved_at TIMESTAMPTZ;
  v_written_updated TIMESTAMPTZ;
  v_is_stale BOOLEAN := FALSE;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'no auth');
  END IF;
  IF v_op_id IS NULL OR v_session_id IS NULL OR v_target_user IS NULL OR v_target_user IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing_or_mismatched_user');
  END IF;
  IF jsonb_typeof(v_session_state) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'invalid_focus_session');
  END IF;

  v_started_at := COALESCE(NULLIF(v_record->>'started_at', '')::TIMESTAMPTZ, NOW());
  v_ended_at := NULLIF(v_record->>'ended_at', '')::TIMESTAMPTZ;
  v_local_updated := COALESCE(NULLIF(v_record->>'updated_at', '')::TIMESTAMPTZ, NOW());
  v_local_saved_at := NULLIF(v_record #>> '{session_state,savedAt}', '')::TIMESTAMPTZ;

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_focus_session'), hashtext(v_session_id::TEXT));
  PERFORM set_config('app.payload_digest', v_payload_digest, true);

  SELECT user_id, payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    IF v_log_existing.payload_digest IS NOT NULL
      AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN jsonb_build_object(
        'status', 'unauthorized',
        'reason', 'operation_id_payload_mismatch',
        'operation_id', v_op_id,
        'existing_payload_digest', v_log_existing.payload_digest,
        'payload_digest', v_payload_digest
      );
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    v_result := jsonb_build_object(
      'status', 'client-version-rejected',
      'reason', CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'focus-session', v_session_id, 'client-version-rejected',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  SELECT user_id, updated_at, NULLIF(session_state->>'savedAt', '')::TIMESTAMPTZ
    INTO v_existing_owner, v_existing_updated, v_existing_saved_at
    FROM public.focus_sessions
    WHERE id = v_session_id
    FOR UPDATE;

  IF v_existing_owner IS NOT NULL AND v_existing_owner IS DISTINCT FROM v_user THEN
    v_result := jsonb_build_object('status', 'unauthorized', 'reason', 'focus_session_owned_by_other_user');
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'focus-session', v_session_id, 'unauthorized',
      'focus_session_owned_by_other_user', v_protocol, v_client_epoch, v_deployment_target, v_client_git,
      v_client_origin, v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  IF v_existing_owner = v_user
    AND GREATEST(v_existing_updated, COALESCE(v_existing_saved_at, v_existing_updated))
      > GREATEST(v_local_updated, COALESCE(v_local_saved_at, v_local_updated))
  THEN
    v_is_stale := TRUE;
    v_written_updated := v_existing_updated;
  ELSE
    INSERT INTO public.focus_sessions AS sessions (
      id,
      user_id,
      started_at,
      ended_at,
      session_state,
      updated_at
    )
    VALUES (
      v_session_id,
      v_target_user,
      v_started_at,
      v_ended_at,
      v_session_state,
      v_local_updated
    )
    ON CONFLICT (id) DO UPDATE
    SET started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        session_state = EXCLUDED.session_state,
        updated_at = EXCLUDED.updated_at
    RETURNING sessions.updated_at INTO v_written_updated;
  END IF;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'focus_session_id', v_session_id,
    'updated_at', v_written_updated,
    'stale_payload', v_is_stale
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
    payload_digest, result_payload)
  VALUES (v_op_id, v_user, 'focus-session', v_session_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
    v_payload_digest, v_result);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_routine_task(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_target_user UUID := (payload->>'user_id')::UUID;
  v_task JSONB := COALESCE(payload->'routine_task', '{}'::JSONB);
  v_task_id UUID := (v_task->>'id')::UUID;
  v_title TEXT := NULLIF(v_task->>'title', '');
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_log_existing RECORD;
  v_result JSONB;
  v_max_times_per_day INTEGER;
  v_is_enabled BOOLEAN;
  v_local_updated_text TEXT;
  v_local_updated TIMESTAMPTZ;
  v_existing_owner UUID;
  v_existing_updated TIMESTAMPTZ;
  v_written_updated TIMESTAMPTZ;
  v_is_stale BOOLEAN := FALSE;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'no auth');
  END IF;
  IF v_op_id IS NULL OR v_task_id IS NULL OR v_target_user IS NULL OR v_target_user IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing_or_mismatched_user');
  END IF;
  IF v_title IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'invalid_routine_task');
  END IF;

  v_max_times_per_day := COALESCE((v_task->>'max_times_per_day')::INTEGER, 1);
  v_is_enabled := COALESCE((v_task->>'is_enabled')::BOOLEAN, TRUE);
  v_local_updated_text := NULLIF(v_task->>'updated_at', '');
  v_local_updated := COALESCE(v_local_updated_text::TIMESTAMPTZ, NOW());

  PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_routine_task'), hashtext(v_task_id::TEXT));
  PERFORM set_config('app.payload_digest', v_payload_digest, true);

  SELECT user_id, payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    IF v_log_existing.payload_digest IS NOT NULL
      AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN jsonb_build_object(
        'status', 'unauthorized',
        'reason', 'operation_id_payload_mismatch',
        'operation_id', v_op_id,
        'existing_payload_digest', v_log_existing.payload_digest,
        'payload_digest', v_payload_digest
      );
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    v_result := jsonb_build_object(
      'status', 'client-version-rejected',
      'reason', CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'routine-task', v_task_id, 'client-version-rejected',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  SELECT user_id, updated_at
    INTO v_existing_owner, v_existing_updated
    FROM public.routine_tasks
    WHERE id = v_task_id
    FOR UPDATE;

  IF v_existing_owner IS NOT NULL AND v_existing_owner IS DISTINCT FROM v_user THEN
    v_result := jsonb_build_object('status', 'unauthorized', 'reason', 'routine_task_owned_by_other_user');
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'routine-task', v_task_id, 'unauthorized',
      'routine_task_owned_by_other_user', v_protocol, v_client_epoch, v_deployment_target, v_client_git,
      v_client_origin, v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  IF v_existing_owner = v_user
    AND (v_local_updated_text IS NULL OR v_existing_updated > v_local_updated)
  THEN
    v_is_stale := TRUE;
    v_written_updated := v_existing_updated;
  ELSE
    INSERT INTO public.routine_tasks AS tasks (
      id,
      user_id,
      title,
      max_times_per_day,
      is_enabled,
      updated_at
    )
    VALUES (
      v_task_id,
      v_target_user,
      v_title,
      v_max_times_per_day,
      v_is_enabled,
      v_local_updated
    )
    ON CONFLICT (id) DO UPDATE
    SET title = EXCLUDED.title,
        max_times_per_day = EXCLUDED.max_times_per_day,
        is_enabled = EXCLUDED.is_enabled,
        updated_at = EXCLUDED.updated_at
    RETURNING tasks.updated_at INTO v_written_updated;
  END IF;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'routine_task_id', v_task_id,
    'updated_at', v_written_updated,
    'stale_payload', v_is_stale
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
    payload_digest, result_payload)
  VALUES (v_op_id, v_user, 'routine-task', v_task_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
    v_payload_digest, v_result);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_increment_routine_completion(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_target_user UUID := (payload->>'user_id')::UUID;
  v_completion JSONB := COALESCE(payload->'routine_completion', '{}'::JSONB);
  v_completion_id UUID := (v_completion->>'id')::UUID;
  v_routine_id UUID := (v_completion->>'routine_id')::UUID;
  v_date_key DATE := NULLIF(v_completion->>'date_key', '')::DATE;
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_log_existing RECORD;
  v_result JSONB;
  v_next_count INTEGER;
  v_updated_at TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'no auth');
  END IF;
  IF v_op_id IS NULL
    OR v_completion_id IS NULL
    OR v_routine_id IS NULL
    OR v_date_key IS NULL
    OR v_target_user IS NULL
    OR v_target_user IS DISTINCT FROM v_user
  THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing_or_mismatched_user');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_increment_routine_completion'), hashtext(v_completion_id::TEXT));
  PERFORM set_config('app.payload_digest', v_payload_digest, true);

  SELECT user_id, payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    IF v_log_existing.payload_digest IS NOT NULL
      AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN jsonb_build_object(
        'status', 'unauthorized',
        'reason', 'operation_id_payload_mismatch',
        'operation_id', v_op_id,
        'existing_payload_digest', v_log_existing.payload_digest,
        'payload_digest', v_payload_digest
      );
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    v_result := jsonb_build_object(
      'status', 'client-version-rejected',
      'reason', CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'routine-completion', v_completion_id, 'client-version-rejected',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  PERFORM 1
    FROM public.routine_tasks
    WHERE id = v_routine_id
      AND user_id = v_user
    FOR UPDATE;
  IF NOT FOUND THEN
    v_result := jsonb_build_object('status', 'unauthorized', 'reason', 'routine_not_owned');
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'routine-completion', v_completion_id, 'unauthorized',
      'routine_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git,
      v_client_origin, v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  INSERT INTO public.routine_completion_events (id, routine_id, user_id, date_key)
  VALUES (v_completion_id, v_routine_id, v_user, v_date_key)
  ON CONFLICT (id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT count, updated_at
      INTO v_next_count, v_updated_at
      FROM public.routine_completions
      WHERE user_id = v_user
        AND routine_id = v_routine_id
        AND date_key = v_date_key;

    v_result := jsonb_build_object(
      'status', 'idempotent-replay',
      'operation_id', v_op_id,
      'routine_completion_id', v_completion_id,
      'routine_id', v_routine_id,
      'date_key', v_date_key,
      'count', COALESCE(v_next_count, 0),
      'updated_at', COALESCE(v_updated_at, NOW())
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'routine-completion', v_completion_id, 'idempotent-replay',
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  INSERT INTO public.routine_completions (id, routine_id, user_id, date_key, count)
  VALUES (v_completion_id, v_routine_id, v_user, v_date_key, 1)
  ON CONFLICT (user_id, routine_id, date_key) DO UPDATE
  SET count = public.routine_completions.count + 1
  RETURNING count, updated_at INTO v_next_count, v_updated_at;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'routine_completion_id', v_completion_id,
    'routine_id', v_routine_id,
    'date_key', v_date_key,
    'count', v_next_count,
    'updated_at', v_updated_at
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
    payload_digest, result_payload)
  VALUES (v_op_id, v_user, 'routine-completion', v_completion_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
    v_payload_digest, v_result);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_delete_project(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_base_updated TIMESTAMPTZ := NULLIF(payload->>'base_updated_at', '')::TIMESTAMPTZ;
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_project_id UUID := (payload->>'project_id')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_owner UUID;
  v_existing_updated TIMESTAMPTZ;
  v_existing_deleted TIMESTAMPTZ;
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  PERFORM set_config('app.payload_digest', v_payload_digest, true);

  SELECT user_id, payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    IF v_log_existing.payload_digest IS NOT NULL
      AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN jsonb_build_object(
        'status', 'unauthorized',
        'reason', 'operation_id_payload_mismatch',
        'operation_id', v_op_id,
        'existing_payload_digest', v_log_existing.payload_digest,
        'payload_digest', v_payload_digest
      );
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    v_result := jsonb_build_object(
      'status', 'client-version-rejected',
      'reason', CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'client-version-rejected',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  SELECT owner_id, updated_at, deleted_at
    INTO v_existing_owner, v_existing_updated, v_existing_deleted
    FROM public.projects
    WHERE id = v_project_id
    FOR UPDATE;

  IF NOT FOUND THEN
    v_result := jsonb_build_object(
      'status', 'applied',
      'operation_id', v_op_id,
      'project_id', v_project_id,
      'deleted_count', 0
    );
  ELSE
    IF v_existing_owner IS DISTINCT FROM v_user THEN
      v_result := jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
        payload_digest, result_payload)
      VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'unauthorized',
        'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
        v_payload_digest, v_result);
      RETURN v_result;
    END IF;

    IF v_existing_deleted IS NULL
      AND v_base_updated IS NULL
    THEN
      v_result := jsonb_build_object(
        'status', 'remote-newer',
        'operation_id', v_op_id,
        'project_id', v_project_id,
        'remote_updated_at', v_existing_updated,
        'reason', 'missing_base_updated_at'
      );
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
        payload_digest, result_payload)
      VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'remote-newer',
        'missing_base_updated_at', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
        v_payload_digest, v_result);
      RETURN v_result;
    END IF;

    IF v_existing_deleted IS NULL
      AND v_base_updated IS DISTINCT FROM v_existing_updated
    THEN
      v_result := jsonb_build_object(
        'status', 'remote-newer',
        'operation_id', v_op_id,
        'project_id', v_project_id,
        'remote_updated_at', v_existing_updated,
        'reason', 'cas_mismatch'
      );
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
        payload_digest, result_payload)
      VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'remote-newer',
        'cas_mismatch', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
        v_payload_digest, v_result);
      RETURN v_result;
    END IF;

    IF v_existing_deleted IS NULL THEN
      PERFORM public.soft_delete_project(v_project_id);
      SELECT updated_at INTO v_written_updated FROM public.projects WHERE id = v_project_id;
    ELSE
      v_written_updated := v_existing_updated;
    END IF;

    v_result := jsonb_build_object(
      'status', 'applied',
      'operation_id', v_op_id,
      'project_id', v_project_id,
      'updated_at', v_written_updated
    );
  END IF;

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
    payload_digest, result_payload)
  VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
    v_payload_digest, v_result);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_delete_tasks(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_project_id UUID := (payload->>'project_id')::UUID;
  v_delete_mode TEXT := COALESCE(NULLIF(payload->>'delete_mode', ''), 'purge');
  v_task_ids UUID[];
  v_base_map JSONB := payload->'base_updated_at_map';
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_owner_id UUID;
  v_log_existing RECORD;
  v_result JSONB;
  v_deleted_count INTEGER;
  v_attachment_paths TEXT[];
  v_task_id UUID;
  v_existing_updated TIMESTAMPTZ;
  v_base_str TEXT;
  v_base_ts TIMESTAMPTZ;
  v_kept UUID[] := ARRAY[]::UUID[];
  v_skipped UUID[] := ARRAY[]::UUID[];
  v_skew_grace CONSTANT INTERVAL := INTERVAL '1 second';
  v_missing_base_map BOOLEAN := v_base_map IS NULL OR jsonb_typeof(v_base_map) <> 'object';
  v_max_task_ids CONSTANT INTEGER := 100;
BEGIN
  IF payload ? 'task_ids' AND jsonb_typeof(payload->'task_ids') <> 'array' THEN
    RAISE EXCEPTION 'sync_delete_tasks task_ids must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(COALESCE(payload->'task_ids', '[]'::JSONB)) > v_max_task_ids THEN
    RAISE EXCEPTION 'sync_delete_tasks accepts at most % task ids', v_max_task_ids
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(task_id::UUID), ARRAY[]::UUID[])
    INTO v_task_ids
    FROM jsonb_array_elements_text(COALESCE(payload->'task_ids', '[]'::JSONB)) AS t(task_id);

  IF v_user IS NULL OR v_op_id IS NULL OR v_project_id IS NULL OR array_length(v_task_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  IF v_delete_mode NOT IN ('soft', 'purge') THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'invalid delete_mode');
  END IF;

  PERFORM set_config('app.payload_digest', v_payload_digest, true);

  SELECT user_id, payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    IF v_log_existing.payload_digest IS NOT NULL
      AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
    THEN
      RETURN jsonb_build_object(
        'status', 'unauthorized',
        'reason', 'operation_id_payload_mismatch',
        'operation_id', v_op_id,
        'existing_payload_digest', v_log_existing.payload_digest,
        'payload_digest', v_payload_digest
      );
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'client-version-rejected',
      CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
  END IF;

  SELECT owner_id INTO v_owner_id
    FROM public.projects
    WHERE id = v_project_id
      AND owner_id = v_user;

  IF v_owner_id IS NULL THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'unauthorized',
      'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
  END IF;

  FOREACH v_task_id IN ARRAY v_task_ids
  LOOP
    SELECT t.updated_at
      INTO v_existing_updated
      FROM public.tasks t
      WHERE t.id = v_task_id
        AND t.project_id = v_project_id
      FOR UPDATE;

    IF v_missing_base_map THEN
      v_skipped := array_append(v_skipped, v_task_id);
      CONTINUE;
    END IF;

    v_base_str := v_base_map->>(v_task_id::TEXT);
    v_base_ts := NULLIF(v_base_str, '')::TIMESTAMPTZ;

    IF v_base_ts IS NULL
      OR (
        v_existing_updated IS NOT NULL
        AND v_existing_updated > v_base_ts + v_skew_grace
      )
    THEN
      v_skipped := array_append(v_skipped, v_task_id);
    ELSE
      v_kept := array_append(v_kept, v_task_id);
    END IF;
  END LOOP;
  v_task_ids := v_kept;

  IF array_length(v_task_ids, 1) IS NULL THEN
    v_result := jsonb_build_object(
      'status', 'applied',
      'operation_id', v_op_id,
      'project_id', v_project_id,
      'delete_mode', v_delete_mode,
      'deleted_count', 0,
      'attachment_paths', '[]'::JSONB,
      'skipped_ids', COALESCE(to_jsonb(v_skipped), '[]'::JSONB)
    );

    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
    VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'applied',
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

    RETURN v_result;
  END IF;

  IF v_delete_mode = 'soft' THEN
    v_deleted_count := public.safe_delete_tasks(v_task_ids, v_project_id);
    v_attachment_paths := ARRAY[]::TEXT[];
  ELSE
    SELECT purged_count, attachment_paths
      INTO v_deleted_count, v_attachment_paths
      FROM public.purge_tasks_v3(v_project_id, v_task_ids);
  END IF;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'project_id', v_project_id,
    'delete_mode', v_delete_mode,
    'deleted_count', COALESCE(v_deleted_count, 0),
    'attachment_paths', COALESCE(to_jsonb(v_attachment_paths), '[]'::JSONB),
    'skipped_ids', COALESCE(to_jsonb(v_skipped), '[]'::JSONB)
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_upsert_task(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_connection(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_project(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_user_preferences(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_focus_session(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_routine_task(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_increment_routine_completion(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_delete_project(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_delete_tasks(JSONB) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.sync_upsert_task(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_connection(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_project(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_user_preferences(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_focus_session(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_routine_task(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_increment_routine_completion(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_delete_project(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_delete_tasks(JSONB) TO authenticated;

COMMENT ON FUNCTION public.sync_upsert_task(JSONB) IS
  'Sync-protected task upsert with idempotency, protocol fence, data-safety mode, quarantine, audit attribution, stale payload rejection, and task attention_meta diagnostics.';
COMMENT ON FUNCTION public.sync_upsert_connection(JSONB) IS
  'Sync-protected connection upsert with idempotency, protocol fence, tombstone guards, ownership checks, server-arrival LWW, and stale-write protection on source_id/target_id/deleted_at.';
COMMENT ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) IS
  'Sync-protected blackbox upsert with idempotency, protocol fence, ownership checks, size guards, completed_at support, and stale-write protection.';
COMMENT ON FUNCTION public.sync_upsert_project(JSONB) IS
  'Sync-protected project upsert with idempotency, tombstone barrier, protocol fence, ownership checks, server-arrival LWW, and stale-write protection.';
COMMENT ON FUNCTION public.sync_upsert_user_preferences(JSONB) IS
  'Sync-protected user_preferences field patch with idempotency, protocol fence, auth.uid ownership, and operation log replay.';
COMMENT ON FUNCTION public.sync_upsert_focus_session(JSONB) IS
  'Sync-protected focus session upsert with idempotency, protocol fence, auth.uid ownership, operation log replay, and stale payload no-op protection.';
COMMENT ON FUNCTION public.sync_upsert_routine_task(JSONB) IS
  'Sync-protected routine task upsert with idempotency, protocol fence, auth.uid ownership, operation log replay, and stale payload no-op protection.';
COMMENT ON FUNCTION public.sync_increment_routine_completion(JSONB) IS
  'Sync-protected routine completion increment with idempotency, protocol fence, auth.uid ownership, event dedupe, operation log replay, and atomic counter updates.';
COMMENT ON FUNCTION public.sync_delete_project(JSONB) IS
  'Sync-protected project delete using soft_delete_project after idempotency, optional CAS, and protocol/deployment epoch fence.';
COMMENT ON FUNCTION public.sync_delete_tasks(JSONB) IS
  'Sync-protected task batch delete/purge capped at 100 task IDs with idempotency, protocol fence, and optional base_updated_at_map stale-write filtering.';

-- ============================================================
-- Durable attachment cleanup cloud outbox
-- ============================================================

-- Durable cloud outbox for attachment Storage deletion.
-- Task metadata removal and outbox insertion happen in one PostgreSQL transaction.

CREATE TABLE IF NOT EXISTS public.attachment_cleanup_jobs (
  bucket TEXT NOT NULL DEFAULT 'attachments',
  object_path TEXT NOT NULL,
  owner_id UUID NOT NULL,
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  claim_token UUID,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, object_path),
  CONSTRAINT attachment_cleanup_jobs_bucket_check
    CHECK (bucket = 'attachments'),
  CONSTRAINT attachment_cleanup_jobs_path_check
    CHECK (
      length(object_path) BETWEEN 1 AND 1024
      AND object_path NOT LIKE '/%'
      AND object_path NOT LIKE '../%'
      AND object_path NOT LIKE '%/../%'
      AND object_path NOT LIKE '%/..'
      AND object_path LIKE (
        owner_id::TEXT || '/' || project_id::TEXT || '/' || task_id::TEXT || '/%'
      )
    ),
  CONSTRAINT attachment_cleanup_jobs_claim_check
    CHECK ((claim_token IS NULL) = (locked_until IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_jobs_due
  ON public.attachment_cleanup_jobs (
    next_attempt_at,
    created_at,
    object_path
  );

ALTER TABLE public.attachment_cleanup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_cleanup_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "attachment_cleanup_jobs_service_role_all"
  ON public.attachment_cleanup_jobs;
CREATE POLICY "attachment_cleanup_jobs_service_role_all"
  ON public.attachment_cleanup_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.attachment_cleanup_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.attachment_cleanup_jobs
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_task_attachment_cleanup(
  p_task_id UUID,
  p_project_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_remaining_attachments JSONB,
  p_jobs JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_updated BOOLEAN := false;
BEGIN
  IF p_expected_updated_at IS NULL THEN
    RETURN false;
  END IF;

  IF p_remaining_attachments IS NOT NULL
    AND jsonb_typeof(p_remaining_attachments) <> 'array'
  THEN
    RAISE EXCEPTION 'remaining attachments must be a JSON array or null';
  END IF;

  IF p_jobs IS NULL OR jsonb_typeof(p_jobs) <> 'array' THEN
    RAISE EXCEPTION 'attachment cleanup jobs must be a JSON array';
  END IF;

  IF jsonb_array_length(p_jobs) = 0 THEN
    RAISE EXCEPTION 'attachment cleanup jobs must not be empty';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_jobs) AS job(
      bucket TEXT,
      object_path TEXT,
      owner_id UUID,
      project_id UUID,
      task_id UUID
    )
    WHERE job.bucket IS DISTINCT FROM 'attachments'
      OR job.object_path IS NULL
      OR job.owner_id IS NULL
      OR job.project_id IS DISTINCT FROM p_project_id
      OR job.task_id IS DISTINCT FROM p_task_id
  ) THEN
    RAISE EXCEPTION 'attachment cleanup job ownership does not match the task claim';
  END IF;

  UPDATE public.tasks AS task
  SET attachments = CASE
    WHEN p_remaining_attachments IS NULL
      OR jsonb_array_length(p_remaining_attachments) = 0
      THEN NULL
    ELSE p_remaining_attachments
  END
  WHERE task.id = p_task_id
    AND task.project_id = p_project_id
    AND task.updated_at = p_expected_updated_at
  RETURNING true INTO v_updated;

  IF NOT COALESCE(v_updated, false) THEN
    RETURN false;
  END IF;

  INSERT INTO public.attachment_cleanup_jobs (
    bucket,
    object_path,
    owner_id,
    project_id,
    task_id
  )
  SELECT
    job.bucket,
    job.object_path,
    job.owner_id,
    job.project_id,
    job.task_id
  FROM jsonb_to_recordset(p_jobs) AS job(
    bucket TEXT,
    object_path TEXT,
    owner_id UUID,
    project_id UUID,
    task_id UUID
  )
  ON CONFLICT (bucket, object_path) DO NOTHING;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_attachment_cleanup_jobs(
  p_limit INTEGER DEFAULT 100,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
  bucket TEXT,
  object_path TEXT,
  claim_token UUID,
  attempt_count INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH lease AS MATERIALIZED (
    SELECT now() + make_interval(
      secs => LEAST(GREATEST(p_lease_seconds, 30), 1800)
    ) AS expires_at
  ),
  candidates AS MATERIALIZED (
    SELECT
      jobs.bucket AS candidate_bucket,
      jobs.object_path AS candidate_path
    FROM public.attachment_cleanup_jobs AS jobs
    WHERE jobs.next_attempt_at <= now()
      AND (jobs.locked_until IS NULL OR jobs.locked_until <= now())
    ORDER BY jobs.next_attempt_at ASC, jobs.created_at ASC, jobs.object_path ASC
    FOR UPDATE OF jobs SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 500)
  ),
  claimed AS (
    UPDATE public.attachment_cleanup_jobs AS jobs
    SET
      claim_token = extensions.gen_random_uuid(),
      next_attempt_at = lease.expires_at,
      locked_until = lease.expires_at,
      updated_at = now()
    FROM candidates, lease
    WHERE jobs.bucket = candidates.candidate_bucket
      AND jobs.object_path = candidates.candidate_path
    RETURNING
      jobs.bucket AS claimed_bucket,
      jobs.object_path AS claimed_path,
      jobs.claim_token AS claimed_token,
      jobs.attempt_count AS claimed_attempt_count
  )
  SELECT
    claimed.claimed_bucket,
    claimed.claimed_path,
    claimed.claimed_token,
    claimed.claimed_attempt_count
  FROM claimed;
$$;

CREATE OR REPLACE FUNCTION public.complete_attachment_cleanup_job(
  p_bucket TEXT,
  p_object_path TEXT,
  p_claim_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_deleted BOOLEAN := false;
BEGIN
  DELETE FROM public.attachment_cleanup_jobs AS jobs
  WHERE jobs.bucket = p_bucket
    AND jobs.object_path = p_object_path
    AND jobs.claim_token = p_claim_token
  RETURNING true INTO v_deleted;

  RETURN COALESCE(v_deleted, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_attachment_cleanup_job(
  p_bucket TEXT,
  p_object_path TEXT,
  p_claim_token UUID,
  p_error TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_updated BOOLEAN := false;
BEGIN
  UPDATE public.attachment_cleanup_jobs AS jobs
  SET
    attempt_count = jobs.attempt_count + 1,
    next_attempt_at = now() + make_interval(
      secs => LEAST(
        3600,
        (30 * power(2, LEAST(jobs.attempt_count, 7)))::INTEGER
      )
    ),
    locked_until = NULL,
    claim_token = NULL,
    last_error = left(
      COALESCE(NULLIF(btrim(p_error), ''), 'storage delete failed'),
      1000
    ),
    updated_at = now()
  WHERE jobs.bucket = p_bucket
    AND jobs.object_path = p_object_path
    AND jobs.claim_token = p_claim_token
  RETURNING true INTO v_updated;

  RETURN COALESCE(v_updated, false);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_task_attachment_cleanup(
  UUID, UUID, TIMESTAMPTZ, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_attachment_cleanup_jobs(
  INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_attachment_cleanup_job(
  TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_attachment_cleanup_job(
  TEXT, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_task_attachment_cleanup(
  UUID, UUID, TIMESTAMPTZ, JSONB, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_attachment_cleanup_jobs(
  INTEGER, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_attachment_cleanup_job(
  TEXT, TEXT, UUID
) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_attachment_cleanup_job(
  TEXT, TEXT, UUID, TEXT
) TO service_role;

COMMENT ON TABLE public.attachment_cleanup_jobs IS
  'Service-role-only durable outbox for retrying attachment Storage deletions.';
COMMENT ON FUNCTION public.claim_task_attachment_cleanup(
  UUID, UUID, TIMESTAMPTZ, JSONB, JSONB
) IS
  'Atomically CAS-updates task attachment metadata and enqueues Storage deletion jobs.';
COMMENT ON FUNCTION public.claim_attachment_cleanup_jobs(
  INTEGER, INTEGER
) IS
  'Claims due attachment cleanup jobs with a bounded lease using SKIP LOCKED.';

-- Legacy mutation RPCs retired after sync CAS coverage.
REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_routine_completion(uuid, uuid, date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_routine_completion(uuid, uuid, date) TO service_role;

COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS
  'Internal task mutation helper; authenticated clients must use sync_upsert_task(JSONB).';
COMMENT ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) IS
  'Internal task purge helper; authenticated clients must use sync_delete_tasks(JSONB).';
COMMENT ON FUNCTION public.increment_routine_completion(uuid, uuid, date) IS
  'Service-only legacy helper; authenticated clients must use sync_increment_routine_completion(JSONB).';

-- Legacy safe_delete_tasks RPC retired after guarded sync delete coverage.
REVOKE ALL ON FUNCTION public.safe_delete_tasks(uuid[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO service_role;

COMMENT ON FUNCTION public.safe_delete_tasks(uuid[], uuid) IS
  'Internal soft-delete circuit-breaker helper; authenticated clients must use sync_delete_tasks(JSONB).';

-- Legacy purge_tasks_v2 RPC retired after guarded sync purge coverage.
REVOKE ALL ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO service_role;

COMMENT ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) IS
  'Service-only legacy purge helper; authenticated clients must use sync_delete_tasks(JSONB).';

-- Legacy attachment mutation RPCs retired after durable attachment sync coverage.
REVOKE ALL ON FUNCTION public.append_task_attachment(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remove_task_attachment(uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.append_task_attachment(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_task_attachment(uuid, text) TO service_role;

COMMENT ON FUNCTION public.append_task_attachment(uuid, jsonb) IS
  'Service-only legacy attachment helper; authenticated clients must persist metadata through sync_upsert_task(JSONB).';
COMMENT ON FUNCTION public.remove_task_attachment(uuid, text) IS
  'Service-only legacy attachment helper; authenticated clients must use sync_upsert_task(JSONB) and the attachment cleanup outbox.';

-- ============================================================
-- FINAL CONVERGENCE: external_source_links current schema
-- ============================================================

CREATE TABLE IF NOT EXISTS public.external_source_links (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL DEFAULT 'siyuan-block',
  target_id TEXT NOT NULL,
  uri TEXT NOT NULL,
  label TEXT,
  hpath TEXT,
  role TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  operation_id UUID,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT external_source_links_source_type_check
    CHECK (source_type = 'siyuan-block'),
  CONSTRAINT external_source_links_target_id_check
    CHECK (target_id ~ '^\d{14}-[a-z0-9]{7}$'),
  CONSTRAINT external_source_links_role_check
    CHECK (role IS NULL OR role IN ('context', 'spec', 'reference', 'evidence', 'next-action')),
  CONSTRAINT external_source_links_uri_check
    CHECK (uri ~ '^siyuan://blocks/\d{14}-[a-z0-9]{7}\?focus=1$'),
  CONSTRAINT external_source_links_id_length_check
    CHECK (char_length(id) <= 64),
  CONSTRAINT external_source_links_uri_length_check
    CHECK (char_length(uri) <= 128),
  CONSTRAINT external_source_links_label_length_check
    CHECK (label IS NULL OR char_length(label) <= 256),
  CONSTRAINT external_source_links_hpath_length_check
    CHECK (hpath IS NULL OR char_length(hpath) <= 1024)
);

ALTER TABLE public.external_source_links
  ADD COLUMN IF NOT EXISTS operation_id UUID;

CREATE INDEX IF NOT EXISTS external_source_links_user_id_cursor_idx
  ON public.external_source_links (user_id, id);

CREATE INDEX IF NOT EXISTS external_source_links_task_idx
  ON public.external_source_links (task_id, sort_order);

CREATE UNIQUE INDEX IF NOT EXISTS external_source_links_unique_active_target
  ON public.external_source_links (user_id, task_id, source_type, target_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS external_source_links_operation_id_unique_idx
  ON public.external_source_links (operation_id)
  WHERE operation_id IS NOT NULL;

COMMENT ON COLUMN public.external_source_links.operation_id IS
  'Client-generated idempotency key for the latest local-first external source link sync operation.';

CREATE OR REPLACE FUNCTION public.prevent_external_source_links_stale_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF OLD.updated_at IS NOT NULL
    AND NEW.updated_at IS NOT NULL
    AND OLD.updated_at > NEW.updated_at + interval '1 second'
  THEN
    RETURN OLD;
  END IF;

  IF OLD.deleted_at IS NOT NULL
    AND NEW.deleted_at IS NULL
    AND OLD.updated_at IS NOT NULL
    AND NEW.updated_at IS NOT NULL
    AND OLD.updated_at >= NEW.updated_at - interval '1 second'
  THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_external_source_links_stale_write()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_external_source_links_prevent_stale_write
  ON public.external_source_links;
CREATE TRIGGER trg_external_source_links_prevent_stale_write
  BEFORE UPDATE ON public.external_source_links
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_external_source_links_stale_write();

ALTER TABLE public.external_source_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_source_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS external_source_links_owner_select ON public.external_source_links;
DROP POLICY IF EXISTS external_source_links_owner_insert ON public.external_source_links;
DROP POLICY IF EXISTS external_source_links_owner_update ON public.external_source_links;
DROP POLICY IF EXISTS external_source_links_owner_delete ON public.external_source_links;

CREATE POLICY external_source_links_owner_select
  ON public.external_source_links
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.tasks task_row
      JOIN public.projects project_row ON project_row.id = task_row.project_id
      WHERE task_row.id = external_source_links.task_id
        AND project_row.owner_id = (SELECT auth.uid())
    )
  );

CREATE POLICY external_source_links_owner_insert
  ON public.external_source_links
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.tasks task_row
      JOIN public.projects project_row ON project_row.id = task_row.project_id
      WHERE task_row.id = external_source_links.task_id
        AND project_row.owner_id = (SELECT auth.uid())
    )
  );

CREATE POLICY external_source_links_owner_update
  ON public.external_source_links
  FOR UPDATE TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.tasks task_row
      JOIN public.projects project_row ON project_row.id = task_row.project_id
      WHERE task_row.id = external_source_links.task_id
        AND project_row.owner_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.tasks task_row
      JOIN public.projects project_row ON project_row.id = task_row.project_id
      WHERE task_row.id = external_source_links.task_id
        AND project_row.owner_id = (SELECT auth.uid())
    )
  );

CREATE POLICY external_source_links_owner_delete
  ON public.external_source_links
  FOR DELETE TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.tasks task_row
      JOIN public.projects project_row ON project_row.id = task_row.project_id
      WHERE task_row.id = external_source_links.task_id
        AND project_row.owner_id = (SELECT auth.uid())
    )
  );

REVOKE ALL ON TABLE public.external_source_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.external_source_links TO authenticated;
GRANT ALL ON TABLE public.external_source_links TO service_role;

-- ============================================================
-- FINAL CONVERGENCE: 20260715017900 owner-scoped RLS
-- Keep this block after every historical migration fragment.
-- ============================================================

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects FORCE ROW LEVEL SECURITY;
ALTER TABLE public.focus_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.focus_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.routine_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE public.purge_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purge_rate_limits FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner select" ON public.projects;
DROP POLICY IF EXISTS "owner insert" ON public.projects;
DROP POLICY IF EXISTS "owner update" ON public.projects;
DROP POLICY IF EXISTS "owner delete" ON public.projects;

CREATE POLICY "owner select" ON public.projects
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = owner_id);
CREATE POLICY "owner insert" ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = owner_id);
CREATE POLICY "owner update" ON public.projects
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = owner_id)
  WITH CHECK ((SELECT auth.uid()) = owner_id);
CREATE POLICY "owner delete" ON public.projects
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = owner_id AND deleted_at IS NULL);

DROP POLICY IF EXISTS "focus_sessions_select" ON public.focus_sessions;
DROP POLICY IF EXISTS "focus_sessions_insert" ON public.focus_sessions;
DROP POLICY IF EXISTS "focus_sessions_update" ON public.focus_sessions;
DROP POLICY IF EXISTS "focus_sessions_delete" ON public.focus_sessions;

CREATE POLICY "focus_sessions_select" ON public.focus_sessions
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "focus_sessions_insert" ON public.focus_sessions
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "focus_sessions_update" ON public.focus_sessions
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "focus_sessions_delete" ON public.focus_sessions
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "routine_tasks_update" ON public.routine_tasks;
CREATE POLICY "routine_tasks_update" ON public.routine_tasks
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "transcription_usage_update_policy" ON public.transcription_usage;
CREATE POLICY "transcription_usage_update_policy" ON public.transcription_usage
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can delete own preferences" ON public.user_preferences;

CREATE POLICY "Users can view own preferences" ON public.user_preferences
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can insert own preferences" ON public.user_preferences
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own preferences" ON public.user_preferences
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can delete own preferences" ON public.user_preferences
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "purge_rate_limits_own" ON public.purge_rate_limits;

REVOKE ALL ON TABLE public.projects FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.projects TO authenticated;
GRANT ALL ON TABLE public.projects TO service_role;

REVOKE ALL ON TABLE public.focus_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.focus_sessions TO authenticated;
GRANT ALL ON TABLE public.focus_sessions TO service_role;

REVOKE ALL ON TABLE public.routine_tasks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.routine_tasks TO authenticated;
GRANT ALL ON TABLE public.routine_tasks TO service_role;

REVOKE ALL ON TABLE public.transcription_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.transcription_usage TO authenticated;
GRANT ALL ON TABLE public.transcription_usage TO service_role;

REVOKE ALL ON TABLE public.user_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_preferences TO authenticated;
GRANT ALL ON TABLE public.user_preferences TO service_role;

REVOKE ALL ON TABLE public.purge_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.purge_rate_limits TO service_role;

-- ============================================================
-- FINAL CONVERGENCE: 20260715018000 core sync table privileges
-- ============================================================

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.tasks, public.connections
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.tasks, public.connections
  TO authenticated;
GRANT ALL ON TABLE public.tasks, public.connections TO service_role;

REVOKE ALL ON TABLE public.task_tombstones, public.connection_tombstones
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT
  ON TABLE public.task_tombstones, public.connection_tombstones
  TO authenticated;
GRANT ALL ON TABLE public.task_tombstones, public.connection_tombstones TO service_role;

REVOKE ALL ON TABLE public.active_tasks, public.active_connections
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.active_tasks, public.active_connections TO authenticated;

-- ============================================================
-- FINAL CONVERGENCE: 20260715018100 default function execute privileges
-- ============================================================

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- FINAL CONVERGENCE: 20260715019000 attachment internal table privileges
-- ============================================================

ALTER TABLE public.attachment_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_scans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.quarantined_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quarantined_files FORCE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_cleanup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_cleanup_jobs FORCE ROW LEVEL SECURITY;

REVOKE ALL
  ON TABLE public.attachment_scans,
           public.quarantined_files,
           public.attachment_cleanup_jobs
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.attachment_scans,
           public.quarantined_files,
           public.attachment_cleanup_jobs
  TO service_role;

-- ============================================================
-- FINAL CONVERGENCE: 20260715019200 cleanup logs cursor and privileges
-- ============================================================

ALTER TABLE public.cleanup_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cleanup_logs FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.cleanup_logs
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.cleanup_logs TO service_role;

-- ============================================================
-- FINAL CONVERGENCE: 20260716000900 function execute privilege convergence
-- ============================================================

DO $$
DECLARE
  function_signature text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'public.current_user_id()',
    'public.user_is_project_owner(uuid)',
    'public.user_has_project_access(uuid)',
    'public.user_accessible_project_ids()'
  ]
  LOOP
    IF to_regprocedure(function_signature) IS NULL THEN
      CONTINUE;
    END IF;

    function_signature := to_regprocedure(function_signature)::text;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', function_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', function_signature);
  END LOOP;
END;
$$;

DO $$
DECLARE
  function_signature text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'public.update_updated_at_column()',
    'public.trigger_set_updated_at()',
    'public.user_preferences_keep_latest_backup_proof()',
    'public.prevent_tombstoned_connection_writes()',
    'public.record_connection_tombstone()',
    'public.prevent_tombstoned_task_writes()',
    'public.check_version_increment()',
    'public.validate_task_data()',
    'public.update_attachment_scans_timestamp()',
    'public.prevent_soft_deleted_row_resurrection()',
    'public.cleanup_cron_job_run_details(interval)'
  ]
  LOOP
    IF to_regprocedure(function_signature) IS NULL THEN
      CONTINUE;
    END IF;

    function_signature := to_regprocedure(function_signature)::text;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', function_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', function_signature);
  END LOOP;
END;
$$;

-- ============================================================
-- FINAL CONVERGENCE: 20260716001000 widget notify bounded fanout RPC
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_widget_notify_devices(
  p_user_id UUID,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
  id UUID,
  binding_generation INTEGER,
  installation_id TEXT,
  capabilities JSONB,
  push_token TEXT,
  expires_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    device.id,
    device.binding_generation,
    device.installation_id,
    device.capabilities,
    device.push_token,
    device.expires_at
  FROM public.widget_devices AS device
  WHERE p_user_id IS NOT NULL
    AND device.user_id = p_user_id
    AND device.platform = 'android-widget'
    AND device.revoked_at IS NULL
    AND device.expires_at > NOW()
    AND NULLIF(BTRIM(device.push_token), '') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.widget_instances AS instance
      WHERE instance.user_id = p_user_id
        AND instance.platform = 'android-widget'
        AND instance.device_id = device.id
        AND instance.binding_generation = device.binding_generation
        AND instance.uninstalled_at IS NULL
    )
  ORDER BY device.last_seen_at DESC, device.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100);
$$;

REVOKE ALL ON FUNCTION public.list_widget_notify_devices(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_widget_notify_devices(UUID, INTEGER)
  TO service_role;

COMMENT ON FUNCTION public.list_widget_notify_devices(UUID, INTEGER) IS
  'Returns at most 100 recently active Android widget devices with a current instance binding.';

-- ============================================================
-- FINAL CONVERGENCE: 20260716001100 foreign key index coverage
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_task_tombstones_deleted_by
  ON public.task_tombstones (deleted_by)
  WHERE deleted_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_connection_tombstones_deleted_by
  ON public.connection_tombstones (deleted_by)
  WHERE deleted_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_routine_completions_routine_id
  ON public.routine_completions (routine_id);

CREATE INDEX IF NOT EXISTS idx_routine_completion_events_routine_id
  ON public.routine_completion_events (routine_id);

-- ============================================================
-- FINAL CONVERGENCE: 20260716001200 default sequence privileges
-- ============================================================

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public
  FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ============================================================
-- FINAL CONVERGENCE: 20260716001300 sync internal table FORCE RLS
-- ============================================================

ALTER TABLE public.sync_operation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_operation_log FORCE ROW LEVEL SECURITY;

ALTER TABLE public.sync_protocol_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_protocol_state FORCE ROW LEVEL SECURITY;

-- Legacy unbounded project-head RPC retired after bounded keyset convergence.

ALTER FUNCTION public.list_project_heads_since(TIMESTAMPTZ) SECURITY INVOKER;
ALTER FUNCTION public.list_project_heads_since(TIMESTAMPTZ) STABLE;

REVOKE ALL ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) IS
  '已退役的 owner-only 无界项目头聚合；客户端使用 list_project_heads_page';

CREATE OR REPLACE FUNCTION public.list_project_heads_page(
  p_since TIMESTAMPTZ,
  p_until TIMESTAMPTZ,
  p_after_updated_at TIMESTAMPTZ,
  p_after_project_id UUID,
  p_limit INTEGER
)
RETURNS TABLE (
  project_id UUID,
  updated_at TIMESTAMPTZ,
  version INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_until IS NULL THEN
    RAISE EXCEPTION 'p_until is required' USING ERRCODE = '22023';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;

  IF (p_after_updated_at IS NULL) <> (p_after_project_id IS NULL) THEN
    RAISE EXCEPTION 'project-head cursor values must both be null or non-null'
      USING ERRCODE = '22023';
  END IF;

  IF p_since IS NOT NULL AND p_until < p_since THEN
    RAISE EXCEPTION 'p_until must not precede p_since' USING ERRCODE = '22023';
  END IF;

  IF p_after_updated_at IS NOT NULL AND p_after_updated_at > p_until THEN
    RAISE EXCEPTION 'project-head cursor exceeds p_until' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH project_changes AS (
    SELECT
      project.id AS project_id,
      GREATEST(
        COALESCE(project.updated_at, '-infinity'::TIMESTAMPTZ),
        COALESCE((
          SELECT MAX(task.updated_at)
          FROM public.tasks AS task
          WHERE task.project_id = project.id
        ), '-infinity'::TIMESTAMPTZ),
        COALESCE((
          SELECT MAX(connection.updated_at)
          FROM public.connections AS connection
          WHERE connection.project_id = project.id
        ), '-infinity'::TIMESTAMPTZ),
        COALESCE((
          SELECT MAX(task_tombstone.deleted_at)
          FROM public.task_tombstones AS task_tombstone
          WHERE task_tombstone.project_id = project.id
        ), '-infinity'::TIMESTAMPTZ),
        COALESCE((
          SELECT MAX(connection_tombstone.deleted_at)
          FROM public.connection_tombstones AS connection_tombstone
          WHERE connection_tombstone.project_id = project.id
        ), '-infinity'::TIMESTAMPTZ)
      ) AS updated_at,
      COALESCE(project.version, 1)::INTEGER AS version
    FROM public.projects AS project
    WHERE project.owner_id = v_user_id
      AND project.deleted_at IS NULL
  )
  SELECT
    pc.project_id,
    pc.updated_at,
    pc.version
  FROM project_changes AS pc
  WHERE pc.updated_at > COALESCE(p_since, '-infinity'::TIMESTAMPTZ)
    AND pc.updated_at <= p_until
    AND (
      p_after_updated_at IS NULL
      OR (pc.updated_at, pc.project_id) > (p_after_updated_at, p_after_project_id)
    )
  ORDER BY pc.updated_at ASC, pc.project_id ASC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_project_heads_page(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_project_heads_page(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER)
  TO authenticated;

COMMENT ON FUNCTION public.list_project_heads_page(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER) IS
  '每页最多 100 个 owner 项目头；使用固定水位上界与 updated_at/project_id keyset 游标';

-- Legacy user-project metadata aggregate retired after keyset convergence.

ALTER FUNCTION public.get_user_projects_meta(TIMESTAMPTZ) SECURITY INVOKER;
ALTER FUNCTION public.get_user_projects_meta(TIMESTAMPTZ) STABLE;

REVOKE ALL ON FUNCTION public.get_user_projects_meta(TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_user_projects_meta(TIMESTAMPTZ) IS
  '已退役的 owner-only 用户项目元数据聚合；客户端使用 keyset 项目查询与 list_project_heads_page';

-- Legacy dashboard stats RPC retired after local-state convergence.

ALTER FUNCTION public.get_dashboard_stats() SECURITY INVOKER;
ALTER FUNCTION public.get_dashboard_stats() STABLE;

REVOKE ALL ON FUNCTION public.get_dashboard_stats()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_dashboard_stats() IS
  '已退役的 owner-only Dashboard 统计聚合；客户端从本地项目状态计算统计';

-- Legacy service-role mutation RPCs retired after internal-owner convergence.

REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purge_tasks_v3(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.increment_routine_completion(uuid, uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.safe_delete_tasks(uuid[], uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purge_tasks_v2(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_task_attachment(uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.remove_task_attachment(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS
  'owner-only 旧任务批量 helper；Data API 入口为 sync_upsert_task';
COMMENT ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) IS
  'owner-only 旧永久删除 helper；Data API 入口为 sync_delete_tasks';
COMMENT ON FUNCTION public.increment_routine_completion(uuid, uuid, date) IS
  'owner-only 旧日常完成 helper；Data API 入口为 sync_increment_routine_completion';
COMMENT ON FUNCTION public.safe_delete_tasks(uuid[], uuid) IS
  'owner-only 旧软删除 helper；Data API 入口为 sync_delete_tasks';
COMMENT ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) IS
  'owner-only 旧永久删除兼容 helper，仅保留诊断用途';
COMMENT ON FUNCTION public.append_task_attachment(uuid, jsonb) IS
  'owner-only 旧附件追加 helper；客户端变更走 durable sync';
COMMENT ON FUNCTION public.remove_task_attachment(uuid, text) IS
  'owner-only 旧附件移除 helper；客户端变更走 durable cleanup';

-- Legacy admin and tombstone RPCs retired after durable replacement convergence.

REVOKE ALL ON FUNCTION public.cleanup_deleted_attachments(integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.migrate_project_data_to_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.migrate_all_projects_to_v2()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purge_tasks(uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_task_tombstoned(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_connection_tombstoned(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.cleanup_deleted_attachments(integer) IS
  'owner-only 旧附件扫描清理；durable 清理使用 attachment cleanup outbox';
COMMENT ON FUNCTION public.migrate_project_data_to_v2(uuid) IS
  'owner-only 单项目 v1-to-v2 恢复 helper，仅用于有界迁移工具';
COMMENT ON FUNCTION public.migrate_all_projects_to_v2() IS
  'owner-only 全项目 v1-to-v2 恢复 helper，仅用于受控维护';
COMMENT ON FUNCTION public.purge_tasks(uuid[]) IS
  'owner-only 旧永久删除 helper；authenticated Data API 入口为 sync_delete_tasks';
COMMENT ON FUNCTION public.is_task_tombstoned(uuid) IS
  'owner-only 旧单点探测；authenticated 有界入口为 batch_get_tombstones';
COMMENT ON FUNCTION public.is_connection_tombstoned(uuid) IS
  'owner-only 旧单点探测；authenticated 有界入口为 batch_get_tombstones';

-- Internal sync and trigger helpers converged to owner-only execution.

REVOKE ALL ON FUNCTION public.soft_delete_project(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sync_operation_log_fill_payload_digest()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sync_canonical_payload_digest(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_sync_write_quarantine(uuid, uuid, text, uuid, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prevent_black_box_content_loss()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.soft_delete_project(uuid) IS
  'owner-only 项目删除 helper；authenticated 客户端使用 sync_delete_project';
COMMENT ON FUNCTION public.sync_operation_log_fill_payload_digest() IS
  'owner-only sync_operation_log payload digest 触发器函数';
COMMENT ON FUNCTION public.sync_canonical_payload_digest(jsonb) IS
  'owner-only quarantine-aware sync canonical digest helper';
COMMENT ON FUNCTION public.record_sync_write_quarantine(uuid, uuid, text, uuid, text, text, text, jsonb) IS
  'owner-only 隔离记录 helper，由 guarded sync write 函数内部调用';
COMMENT ON FUNCTION public.prevent_black_box_content_loss() IS
  'owner-only black-box 内容防丢触发器函数';

-- DR maintenance cron jobs converged after bounded cleanup functions.

DO $cron_jobs$
DECLARE
  v_job RECORD;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'Skipping DR maintenance cron convergence; pg_cron job table is absent.';
  ELSIF to_regprocedure('public.purge_expired_sync_write_quarantine()') IS NULL
    OR to_regprocedure('public.archive_old_task_change_audit(interval)') IS NULL
  THEN
    RAISE NOTICE 'Skipping DR maintenance cron convergence; target functions are absent.';
  ELSE
    FOR v_job IN
      SELECT jobid
      FROM cron.job
      WHERE jobname IN (
        'nanoflow-sync-write-quarantine-gc',
        'nanoflow-task-change-audit-archive'
      )
    LOOP
      PERFORM cron.unschedule(v_job.jobid);
    END LOOP;

    PERFORM cron.schedule(
      'nanoflow-sync-write-quarantine-gc',
      '0 3 * * *',
      $cmd$SELECT public.purge_expired_sync_write_quarantine();$cmd$
    );

    PERFORM cron.schedule(
      'nanoflow-task-change-audit-archive',
      '30 3 * * *',
      $cmd$SELECT public.archive_old_task_change_audit(INTERVAL '180 days');$cmd$
    );
  END IF;
END
$cron_jobs$;

-- Core retention cron jobs converged across fresh-init and upgrades.

DO $core_retention_cron$
DECLARE
  v_job RECORD;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'Skipping core retention cron convergence; pg_cron job table is absent.';
  ELSIF to_regprocedure('public.cleanup_old_deleted_tasks()') IS NULL
    OR to_regprocedure('public.cleanup_old_deleted_connections()') IS NULL
    OR to_regprocedure('public.cleanup_old_logs()') IS NULL
  THEN
    RAISE NOTICE 'Skipping core retention cron convergence; target functions are absent.';
  ELSE
    FOR v_job IN
      SELECT jobid
      FROM cron.job
      WHERE jobname IN (
        'nanoflow-cleanup-deleted-tasks',
        'nanoflow-cleanup-deleted-connections',
        'nanoflow-cleanup-logs'
      )
    LOOP
      PERFORM cron.unschedule(v_job.jobid);
    END LOOP;

    PERFORM cron.schedule(
      'nanoflow-cleanup-deleted-tasks',
      '10 3 * * *',
      $job$SELECT public.cleanup_old_deleted_tasks();$job$
    );

    PERFORM cron.schedule(
      'nanoflow-cleanup-deleted-connections',
      '20 3 * * *',
      $job$SELECT public.cleanup_old_deleted_connections();$job$
    );

    PERFORM cron.schedule(
      'nanoflow-cleanup-logs',
      '30 3 * * *',
      $job$SELECT public.cleanup_old_logs();$job$
    );
  END IF;
END
$core_retention_cron$;

-- Scheduled maintenance functions converged to pg_cron owner-only execution.

REVOKE ALL ON FUNCTION public.cleanup_old_deleted_tasks()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cleanup_old_deleted_connections()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cleanup_old_logs()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cleanup_personal_retention_artifacts()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cleanup_cron_job_run_details(interval)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purge_expired_sync_write_quarantine()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.archive_old_task_change_audit(interval)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.cleanup_old_deleted_tasks() IS
  'owner-only 有界清理，由 nanoflow-cleanup-deleted-tasks 调用';
COMMENT ON FUNCTION public.cleanup_old_deleted_connections() IS
  'owner-only 有界清理，由 nanoflow-cleanup-deleted-connections 调用';
COMMENT ON FUNCTION public.cleanup_old_logs() IS
  'owner-only 有界清理，由 nanoflow-cleanup-logs 调用';
COMMENT ON FUNCTION public.cleanup_personal_retention_artifacts() IS
  'owner-only 有界清理，由 nanoflow-personal-retention 调用';
COMMENT ON FUNCTION public.cleanup_cron_job_run_details(interval) IS
  'owner-only 有界清理，由 nanoflow-cron-log-retention 调用';
COMMENT ON FUNCTION public.purge_expired_sync_write_quarantine() IS
  'owner-only 有界清理，由 nanoflow-sync-write-quarantine-gc 调用';
COMMENT ON FUNCTION public.archive_old_task_change_audit(interval) IS
  'owner-only 有界归档，由 nanoflow-task-change-audit-archive 调用';

-- FINAL CONVERGENCE: 20260716015618 redundant index convergence

DO $redundant_index_convergence$
DECLARE
  target RECORD;
  replacement_index REGCLASS;
  replacement_valid BOOLEAN;
  replacement_ready BOOLEAN;
  replacement_btree BOOLEAN;
  replacement_single_key BOOLEAN;
  replacement_columns NAME[];
  predicate_sql TEXT;
  tombstone_primary_valid BOOLEAN;
  tombstone_primary_ready BOOLEAN;
  tombstone_primary BOOLEAN;
  tombstone_primary_btree BOOLEAN;
  tombstone_primary_single_key BOOLEAN;
  tombstone_primary_columns NAME[];
BEGIN
  FOR target IN
    SELECT *
    FROM (
      VALUES
        ('idx_connections_deleted_at_cleanup', 'connections', ARRAY['deleted_at']::NAME[], true),
        ('idx_connections_project', 'connections', ARRAY['project_id']::NAME[], false),
        ('idx_tasks_deleted_cleanup', 'tasks', ARRAY['deleted_at']::NAME[], true)
    ) AS replacement(index_name, table_name, expected_columns, requires_not_null_predicate)
  LOOP
    replacement_index := to_regclass(format('%I.%I', 'public', target.index_name));
    replacement_valid := false;
    replacement_ready := false;
    replacement_btree := false;
    replacement_single_key := false;
    replacement_columns := NULL;
    predicate_sql := NULL;

    SELECT
      index_row.indisvalid,
      index_row.indisready,
      access_method.amname = 'btree',
      index_row.indnkeyatts = 1,
      array_agg(attribute_row.attname ORDER BY key_column.ordinality),
      pg_get_expr(index_row.indpred, index_row.indrelid)
    INTO
      replacement_valid,
      replacement_ready,
      replacement_btree,
      replacement_single_key,
      replacement_columns,
      predicate_sql
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
    CROSS JOIN LATERAL unnest(index_row.indkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_attribute AS attribute_row
      ON attribute_row.attrelid = index_row.indrelid
     AND attribute_row.attnum = key_column.attnum
    WHERE index_row.indexrelid = replacement_index
      AND index_row.indrelid = to_regclass(format('%I.%I', 'public', target.table_name))
      AND key_column.ordinality <= index_row.indnkeyatts
    GROUP BY
      index_row.indisvalid,
      index_row.indisready,
      access_method.amname,
      index_row.indnkeyatts,
      index_row.indpred,
      index_row.indrelid;

    IF NOT COALESCE(replacement_valid, false)
      OR NOT COALESCE(replacement_ready, false)
      OR NOT COALESCE(replacement_btree, false)
      OR NOT COALESCE(replacement_single_key, false)
      OR replacement_columns IS DISTINCT FROM target.expected_columns
      OR (
        target.requires_not_null_predicate
        AND (
          predicate_sql IS NULL
          OR predicate_sql NOT ILIKE '%deleted_at%IS NOT NULL%'
        )
      )
      OR (
        NOT target.requires_not_null_predicate
        AND predicate_sql IS NOT NULL
      )
    THEN
      RAISE EXCEPTION 'redundant index replacement is missing or invalid'
        USING DETAIL = format(
          'Index public.%I valid=%s ready=%s btree=%s single_key=%s columns=%s predicate=%s',
          target.index_name,
          replacement_valid,
          replacement_ready,
          replacement_btree,
          replacement_single_key,
          replacement_columns,
          predicate_sql
        );
    END IF;
  END LOOP;

  SELECT
    index_row.indisvalid,
    index_row.indisready,
    index_row.indisprimary,
    access_method.amname = 'btree',
    index_row.indnkeyatts = 1,
    array_agg(attribute_row.attname ORDER BY key_column.ordinality)
  INTO
    tombstone_primary_valid,
    tombstone_primary_ready,
    tombstone_primary,
    tombstone_primary_btree,
    tombstone_primary_single_key,
    tombstone_primary_columns
  FROM pg_index AS index_row
  JOIN pg_class AS index_relation
    ON index_relation.oid = index_row.indexrelid
  JOIN pg_am AS access_method
    ON access_method.oid = index_relation.relam
  CROSS JOIN LATERAL unnest(index_row.indkey)
    WITH ORDINALITY AS key_column(attnum, ordinality)
  JOIN pg_attribute AS attribute_row
    ON attribute_row.attrelid = index_row.indrelid
   AND attribute_row.attnum = key_column.attnum
  WHERE index_row.indrelid = to_regclass('public.task_tombstones')
    AND index_row.indisprimary
    AND index_row.indpred IS NULL
    AND key_column.ordinality <= index_row.indnkeyatts
  GROUP BY
    index_row.indisvalid,
    index_row.indisready,
    index_row.indisprimary,
    access_method.amname,
    index_row.indnkeyatts;

  IF NOT COALESCE(tombstone_primary_valid, false)
    OR NOT COALESCE(tombstone_primary_ready, false)
    OR NOT COALESCE(tombstone_primary, false)
    OR NOT COALESCE(tombstone_primary_btree, false)
    OR NOT COALESCE(tombstone_primary_single_key, false)
    OR tombstone_primary_columns IS DISTINCT FROM ARRAY['task_id']::NAME[]
  THEN
    RAISE EXCEPTION 'task_tombstones primary key is missing or invalid'
      USING DETAIL = format(
        'valid=%s ready=%s primary=%s btree=%s single_key=%s columns=%s',
        tombstone_primary_valid,
        tombstone_primary_ready,
        tombstone_primary,
        tombstone_primary_btree,
        tombstone_primary_single_key,
        tombstone_primary_columns
      );
  END IF;
END
$redundant_index_convergence$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_connections_deleted_cleanup;
DROP INDEX IF EXISTS public.idx_connections_project_id;
DROP INDEX IF EXISTS public.idx_task_tombstones_task_id;
DROP INDEX IF EXISTS public.idx_tasks_deleted_at;
SET LOCAL lock_timeout = DEFAULT;

-- FINAL CONVERGENCE: 20260531120000 secure diagnostic view parity

CREATE OR REPLACE VIEW public.project_structure_audit
WITH (security_invoker = true)
AS
SELECT
  p.owner_id,
  p.id AS project_id,
  p.title,
  count(t.id) FILTER (WHERE t.deleted_at IS NULL) AS active_tasks,
  count(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.stage IS NULL) AS stage_null,
  count(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.parent_id IS NOT NULL) AS child_tasks,
  count(t.id) FILTER (
    WHERE t.deleted_at IS NULL
      AND COALESCE(t.content, '') = COALESCE(t.title, '')
  ) AS content_equals_title,
  max(t.updated_at) AS last_task_update
FROM public.projects p
LEFT JOIN public.tasks t ON t.project_id = p.id
WHERE p.deleted_at IS NULL
GROUP BY p.owner_id, p.id, p.title;

REVOKE ALL ON public.project_structure_audit FROM PUBLIC, anon;
GRANT SELECT ON public.project_structure_audit TO authenticated;

CREATE OR REPLACE VIEW public.stage_null_recovery_diagnostics
WITH (security_invoker = true)
AS
WITH active AS (
  SELECT t.*, p.owner_id
  FROM public.tasks t
  JOIN public.projects p ON p.id = t.project_id
  WHERE p.deleted_at IS NULL
    AND t.deleted_at IS NULL
)
SELECT
  a.owner_id,
  a.project_id,
  a.id AS task_id,
  a.title,
  (COALESCE(a.content, '') = COALESCE(a.title, '')) AS materialized_sig,
  a.updated_at,
  COALESCE(child.child_n, 0) AS child_n,
  child.child_stages,
  a.parent_id,
  parent.stage AS parent_stage,
  COALESCE(soft_deleted.soft_deleted_stage_candidates, 0) AS soft_deleted_stage_candidates,
  COALESCE(audit.audit_preimage_candidates, 0) AS audit_preimage_candidates,
  CASE
    WHEN COALESCE(child.child_n, 0) > 0 THEN 'S1'
    WHEN COALESCE(soft_deleted.soft_deleted_stage_candidates, 0) > 0 THEN 'S2'
    WHEN COALESCE(audit.audit_preimage_candidates, 0) > 0 THEN 'S3'
    ELSE 'S4'
  END AS evidence_class
FROM active a
LEFT JOIN active parent ON parent.id = a.parent_id
LEFT JOIN LATERAL (
  SELECT count(*) AS child_n, array_agg(DISTINCT c.stage) AS child_stages
  FROM active c
  WHERE c.parent_id = a.id
) child ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS soft_deleted_stage_candidates
  FROM public.tasks d
  WHERE d.project_id = a.project_id
    AND d.deleted_at IS NOT NULL
    AND d.title = a.title
    AND d.stage IS NOT NULL
) soft_deleted ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS audit_preimage_candidates
  FROM public.task_change_audit audit
  WHERE audit.task_id = a.id
    AND audit.old_stage IS NOT NULL
) audit ON true
WHERE a.stage IS NULL;

REVOKE ALL ON public.stage_null_recovery_diagnostics FROM PUBLIC, anon;
GRANT SELECT ON public.stage_null_recovery_diagnostics TO authenticated;

-- FINAL CONVERGENCE: 20260716024708 diagnostic view privilege convergence

SET LOCAL lock_timeout = '2s';

REVOKE ALL ON TABLE
  public.project_structure_audit,
  public.stage_null_recovery_diagnostics
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.project_structure_audit,
  public.stage_null_recovery_diagnostics
TO authenticated;

SET LOCAL lock_timeout = DEFAULT;

-- FINAL CONVERGENCE: 20260716031311 black-box status NOT NULL convergence

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $black_box_status_preflight$
DECLARE
  null_row_count BIGINT;
BEGIN
  SELECT count(*)
  INTO null_row_count
  FROM public.black_box_entries
  WHERE is_read IS NULL
     OR is_completed IS NULL
     OR is_archived IS NULL
     OR snooze_count IS NULL;

  IF null_row_count > 10000 THEN
    RAISE EXCEPTION 'black_box_entries status NULL backfill exceeds safe migration limit'
      USING DETAIL = format('null_row_count=%s limit=10000', null_row_count),
            HINT = 'Export affected rows and backfill them in reviewed batches before retrying.';
  END IF;
END
$black_box_status_preflight$;

ALTER TABLE public.black_box_entries
  DROP CONSTRAINT IF EXISTS black_box_entries_status_fields_not_null;

ALTER TABLE public.black_box_entries
  ADD CONSTRAINT black_box_entries_status_fields_not_null
  CHECK (
    is_read IS NOT NULL
    AND is_completed IS NOT NULL
    AND is_archived IS NOT NULL
    AND snooze_count IS NOT NULL
  ) NOT VALID;

UPDATE public.black_box_entries
SET
  is_read = COALESCE(is_read, false),
  is_completed = COALESCE(is_completed, false),
  is_archived = COALESCE(is_archived, false),
  snooze_count = COALESCE(snooze_count, 0)
WHERE is_read IS NULL
   OR is_completed IS NULL
   OR is_archived IS NULL
   OR snooze_count IS NULL;

ALTER TABLE public.black_box_entries
  VALIDATE CONSTRAINT black_box_entries_status_fields_not_null;

ALTER TABLE public.black_box_entries
  ALTER COLUMN is_read SET DEFAULT false,
  ALTER COLUMN is_read SET NOT NULL,
  ALTER COLUMN is_completed SET DEFAULT false,
  ALTER COLUMN is_completed SET NOT NULL,
  ALTER COLUMN is_archived SET DEFAULT false,
  ALTER COLUMN is_archived SET NOT NULL,
  ALTER COLUMN snooze_count SET DEFAULT 0,
  ALTER COLUMN snooze_count SET NOT NULL;

ALTER TABLE public.black_box_entries
  DROP CONSTRAINT black_box_entries_status_fields_not_null;

SET LOCAL statement_timeout = DEFAULT;
SET LOCAL lock_timeout = DEFAULT;

-- FINAL CONVERGENCE: 20260716033440 focus session state required insert convergence

SET LOCAL lock_timeout = '2s';

ALTER TABLE public.focus_sessions
  ALTER COLUMN session_state DROP DEFAULT;

SET LOCAL lock_timeout = DEFAULT;

-- FINAL CONVERGENCE: 20260728000200 focus sessions started_at required insert convergence

SET LOCAL lock_timeout = '2s';

ALTER TABLE public.focus_sessions
  ALTER COLUMN started_at DROP DEFAULT;

SET LOCAL lock_timeout = DEFAULT;

-- FINAL CONVERGENCE: 20260716043500 widget operational retention

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_widget_notify_events_retention
  ON public.widget_notify_events (processed_at, webhook_id);

CREATE INDEX IF NOT EXISTS idx_widget_request_rate_limits_retention
  ON public.widget_request_rate_limits (updated_at, scope_type, scope_key);

CREATE OR REPLACE FUNCTION public.cleanup_widget_operational_state(
  p_retention INTERVAL DEFAULT INTERVAL '30 days',
  p_batch_size INTEGER DEFAULT 5000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_notify_events_deleted INTEGER := 0;
  v_rate_limits_deleted INTEGER := 0;
  v_result JSONB;
BEGIN
  IF p_retention IS NULL
    OR p_retention < INTERVAL '1 day'
    OR p_retention > INTERVAL '365 days'
  THEN
    RAISE EXCEPTION 'widget retention must be between 1 and 365 days'
      USING ERRCODE = '22023';
  END IF;

  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'widget retention batch size must be between 1 and 10000'
      USING ERRCODE = '22023';
  END IF;

  WITH expired_events AS MATERIALIZED (
    SELECT events.ctid AS row_ctid
    FROM public.widget_notify_events AS events
    WHERE events.processed_at < v_now - p_retention
    ORDER BY events.processed_at, events.webhook_id
    FOR UPDATE OF events SKIP LOCKED
    LIMIT p_batch_size
  ),
  deleted AS (
    DELETE FROM public.widget_notify_events AS events
    WHERE events.ctid IN (
      SELECT expired_events.row_ctid
      FROM expired_events
    )
    RETURNING 1
  )
  SELECT count(*)::INTEGER
  INTO v_notify_events_deleted
  FROM deleted;

  WITH expired_limits AS MATERIALIZED (
    SELECT limits.ctid AS row_ctid
    FROM public.widget_request_rate_limits AS limits
    WHERE limits.updated_at < v_now - p_retention
      AND (limits.blocked_until IS NULL OR limits.blocked_until <= v_now)
    ORDER BY limits.updated_at, limits.scope_type, limits.scope_key
    FOR UPDATE OF limits SKIP LOCKED
    LIMIT p_batch_size
  ),
  deleted AS (
    DELETE FROM public.widget_request_rate_limits AS limits
    WHERE limits.ctid IN (
      SELECT expired_limits.row_ctid
      FROM expired_limits
    )
    RETURNING 1
  )
  SELECT count(*)::INTEGER
  INTO v_rate_limits_deleted
  FROM deleted;

  v_result := pg_catalog.jsonb_build_object(
    'widget_notify_events_deleted', v_notify_events_deleted,
    'widget_request_rate_limits_deleted', v_rate_limits_deleted,
    'retention_seconds', EXTRACT(EPOCH FROM p_retention)::BIGINT,
    'batch_limit', p_batch_size,
    'cleanup_time', v_now
  );

  IF v_notify_events_deleted + v_rate_limits_deleted > 0 THEN
    INSERT INTO public.cleanup_logs (type, details, created_at)
    VALUES ('widget_operational_retention', v_result, v_now);
  END IF;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.cleanup_widget_operational_state(INTERVAL, INTEGER) IS
  'Deletes bounded 30-day Widget operational state and is callable only by the database owner/pg_cron.';

REVOKE ALL ON FUNCTION public.cleanup_widget_operational_state(INTERVAL, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;

DO $widget_operational_retention_cron$
DECLARE
  v_job RECORD;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'Skipping Widget operational retention schedule; pg_cron job table is absent.';
  ELSIF to_regprocedure('public.cleanup_widget_operational_state(interval,integer)') IS NULL THEN
    RAISE NOTICE 'Skipping Widget operational retention schedule; cleanup function is absent.';
  ELSE
    FOR v_job IN
      SELECT jobid
      FROM cron.job
      WHERE jobname = 'nanoflow-widget-operational-retention'
    LOOP
      PERFORM cron.unschedule(v_job.jobid);
    END LOOP;

    PERFORM cron.schedule(
      'nanoflow-widget-operational-retention',
      '40 3 * * *',
      $job$SELECT public.cleanup_widget_operational_state();$job$
    );
  END IF;
END
$widget_operational_retention_cron$;

SET LOCAL statement_timeout = DEFAULT;
SET LOCAL lock_timeout = DEFAULT;


-- FINAL CONVERGENCE: 20260716052000 routine task keyset index

CREATE INDEX IF NOT EXISTS idx_routine_tasks_user_updated_id
  ON public.routine_tasks (user_id, updated_at, id);

DROP INDEX IF EXISTS public.idx_routine_tasks_user_updated;


-- FINAL CONVERGENCE: 20260718003000 project metadata keyset index

CREATE INDEX IF NOT EXISTS idx_projects_owner_updated_id
  ON public.projects (owner_id, updated_at, id);

DROP INDEX IF EXISTS public.idx_projects_owner_id_updated;


-- FINAL CONVERGENCE: 20260718003100 task tombstone keyset pagination

CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_deleted_task
  ON public.task_tombstones (project_id, deleted_at, task_id);

DROP INDEX IF EXISTS public.idx_task_tombstones_project_deleted_desc;
DROP INDEX IF EXISTS public.idx_task_tombstones_project_id;


-- FINAL CONVERGENCE: 20260718003200 tasks created_at keyset convergence

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.tasks
  ALTER COLUMN created_at SET DEFAULT now();

ALTER TABLE public.tasks
  DROP CONSTRAINT IF EXISTS tasks_created_at_not_null_convergence;

ALTER TABLE public.tasks
  ADD CONSTRAINT tasks_created_at_not_null_convergence
  CHECK (created_at IS NOT NULL) NOT VALID;

DO $tasks_created_at_preflight$
DECLARE
  null_row_count BIGINT;
BEGIN
  SELECT count(*)
  INTO null_row_count
  FROM public.tasks
  WHERE created_at IS NULL;

  IF null_row_count > 10000 THEN
    RAISE EXCEPTION 'tasks.created_at NULL backfill exceeds safe migration limit'
      USING DETAIL = format('null_row_count=%s limit=10000', null_row_count),
            HINT = 'Export affected tasks and backfill them in reviewed batches before retrying.';
  END IF;
END
$tasks_created_at_preflight$;

UPDATE public.tasks
SET created_at = COALESCE(created_at, updated_at, now())
WHERE created_at IS NULL;

ALTER TABLE public.tasks
  VALIDATE CONSTRAINT tasks_created_at_not_null_convergence;

ALTER TABLE public.tasks
  ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE public.tasks
  DROP CONSTRAINT tasks_created_at_not_null_convergence;

SET LOCAL statement_timeout = DEFAULT;
SET LOCAL lock_timeout = DEFAULT;

-- FRESH-INIT PRELUDE: materialize the full mutation implementations that the
-- stable replay wrappers delegate to. Upgrade installs already obtained these
-- targets from 20260628193000; a consolidated bootstrap must create them here.

SET LOCAL lock_timeout = '2s';

DO $materialize_sync_rpc_targets$
DECLARE
  v_source REGPROCEDURE;
  v_source_definition TEXT;
BEGIN
  IF to_regprocedure('public.sync_upsert_task__unguarded_20260628(jsonb)') IS NULL THEN
    v_source := to_regprocedure('public.sync_upsert_task(jsonb)');
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_task__unguarded_20260628(JSONB): source public.sync_upsert_task(JSONB) is missing';
    END IF;
    v_source_definition := pg_get_functiondef(v_source);
    IF position('sync_upsert_task__unguarded_20260628' IN v_source_definition) > 0 THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_task__unguarded_20260628(JSONB): source already references the missing delegation target';
    END IF;
    ALTER FUNCTION public.sync_upsert_task(JSONB) RENAME TO sync_upsert_task__unguarded_20260628;
  END IF;

  IF to_regprocedure('public.sync_upsert_connection__unguarded_20260628(jsonb)') IS NULL THEN
    v_source := to_regprocedure('public.sync_upsert_connection(jsonb)');
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_connection__unguarded_20260628(JSONB): source public.sync_upsert_connection(JSONB) is missing';
    END IF;
    v_source_definition := pg_get_functiondef(v_source);
    IF position('sync_upsert_connection__unguarded_20260628' IN v_source_definition) > 0 THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_connection__unguarded_20260628(JSONB): source already references the missing delegation target';
    END IF;
    ALTER FUNCTION public.sync_upsert_connection(JSONB) RENAME TO sync_upsert_connection__unguarded_20260628;
  END IF;

  IF to_regprocedure('public.sync_upsert_blackbox_entry__unguarded_20260628(jsonb)') IS NULL THEN
    v_source := to_regprocedure('public.sync_upsert_blackbox_entry(jsonb)');
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_blackbox_entry__unguarded_20260628(JSONB): source public.sync_upsert_blackbox_entry(JSONB) is missing';
    END IF;
    v_source_definition := pg_get_functiondef(v_source);
    IF position('sync_upsert_blackbox_entry__unguarded_20260628' IN v_source_definition) > 0 THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_blackbox_entry__unguarded_20260628(JSONB): source already references the missing delegation target';
    END IF;
    ALTER FUNCTION public.sync_upsert_blackbox_entry(JSONB) RENAME TO sync_upsert_blackbox_entry__unguarded_20260628;
  END IF;

  IF to_regprocedure('public.sync_upsert_project__unguarded_20260628(jsonb)') IS NULL THEN
    v_source := to_regprocedure('public.sync_upsert_project(jsonb)');
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_project__unguarded_20260628(JSONB): source public.sync_upsert_project(JSONB) is missing';
    END IF;
    v_source_definition := pg_get_functiondef(v_source);
    IF position('sync_upsert_project__unguarded_20260628' IN v_source_definition) > 0 THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_project__unguarded_20260628(JSONB): source already references the missing delegation target';
    END IF;
    ALTER FUNCTION public.sync_upsert_project(JSONB) RENAME TO sync_upsert_project__unguarded_20260628;
  END IF;

  IF to_regprocedure('public.sync_upsert_user_preferences__unguarded_20260628(jsonb)') IS NULL THEN
    v_source := to_regprocedure('public.sync_upsert_user_preferences(jsonb)');
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_user_preferences__unguarded_20260628(JSONB): source public.sync_upsert_user_preferences(JSONB) is missing';
    END IF;
    v_source_definition := pg_get_functiondef(v_source);
    IF position('sync_upsert_user_preferences__unguarded_20260628' IN v_source_definition) > 0 THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_user_preferences__unguarded_20260628(JSONB): source already references the missing delegation target';
    END IF;
    ALTER FUNCTION public.sync_upsert_user_preferences(JSONB) RENAME TO sync_upsert_user_preferences__unguarded_20260628;
  END IF;

  IF to_regprocedure('public.sync_upsert_focus_session__unguarded_20260628(jsonb)') IS NULL THEN
    v_source := to_regprocedure('public.sync_upsert_focus_session(jsonb)');
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_focus_session__unguarded_20260628(JSONB): source public.sync_upsert_focus_session(JSONB) is missing';
    END IF;
    v_source_definition := pg_get_functiondef(v_source);
    IF position('sync_upsert_focus_session__unguarded_20260628' IN v_source_definition) > 0 THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_focus_session__unguarded_20260628(JSONB): source already references the missing delegation target';
    END IF;
    ALTER FUNCTION public.sync_upsert_focus_session(JSONB) RENAME TO sync_upsert_focus_session__unguarded_20260628;
  END IF;

  IF to_regprocedure('public.sync_upsert_routine_task__unguarded_20260628(jsonb)') IS NULL THEN
    v_source := to_regprocedure('public.sync_upsert_routine_task(jsonb)');
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_routine_task__unguarded_20260628(JSONB): source public.sync_upsert_routine_task(JSONB) is missing';
    END IF;
    v_source_definition := pg_get_functiondef(v_source);
    IF position('sync_upsert_routine_task__unguarded_20260628' IN v_source_definition) > 0 THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_upsert_routine_task__unguarded_20260628(JSONB): source already references the missing delegation target';
    END IF;
    ALTER FUNCTION public.sync_upsert_routine_task(JSONB) RENAME TO sync_upsert_routine_task__unguarded_20260628;
  END IF;

  IF to_regprocedure('public.sync_increment_routine_completion__unguarded_20260628(jsonb)') IS NULL THEN
    v_source := to_regprocedure('public.sync_increment_routine_completion(jsonb)');
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_increment_routine_completion__unguarded_20260628(JSONB): source public.sync_increment_routine_completion(JSONB) is missing';
    END IF;
    v_source_definition := pg_get_functiondef(v_source);
    IF position('sync_increment_routine_completion__unguarded_20260628' IN v_source_definition) > 0 THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_increment_routine_completion__unguarded_20260628(JSONB): source already references the missing delegation target';
    END IF;
    ALTER FUNCTION public.sync_increment_routine_completion(JSONB) RENAME TO sync_increment_routine_completion__unguarded_20260628;
  END IF;

  IF to_regprocedure('public.sync_delete_tasks__unguarded_20260628(jsonb)') IS NULL THEN
    v_source := to_regprocedure('public.sync_delete_tasks(jsonb)');
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_delete_tasks__unguarded_20260628(JSONB): source public.sync_delete_tasks(JSONB) is missing';
    END IF;
    v_source_definition := pg_get_functiondef(v_source);
    IF position('sync_delete_tasks__unguarded_20260628' IN v_source_definition) > 0 THEN
      RAISE EXCEPTION 'Cannot materialize public.sync_delete_tasks__unguarded_20260628(JSONB): source already references the missing delegation target';
    END IF;
    ALTER FUNCTION public.sync_delete_tasks(JSONB) RENAME TO sync_delete_tasks__unguarded_20260628;
  END IF;
END;
$materialize_sync_rpc_targets$;

REVOKE ALL ON FUNCTION public.sync_upsert_task__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_upsert_connection__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_upsert_blackbox_entry__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_upsert_project__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_upsert_user_preferences__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_upsert_focus_session__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_upsert_routine_task__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_increment_routine_completion__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_delete_tasks__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;

SET LOCAL lock_timeout = DEFAULT;


-- FINAL CONVERGENCE: 20260726000000 sync RPC replay digest stability

-- Keep operation-id replay stable when transport/audit metadata changes after
-- an app upgrade. Business payload fields remain digest-protected.

SET LOCAL lock_timeout = '2s';

ALTER TABLE public.sync_operation_log
  ADD COLUMN IF NOT EXISTS replay_payload_digest TEXT;

SET LOCAL lock_timeout = DEFAULT;

COMMENT ON COLUMN public.sync_operation_log.replay_payload_digest IS
  'Digest of the logical sync mutation with volatile client/deployment envelope fields removed.';

CREATE OR REPLACE FUNCTION public.sync_rpc_replay_payload_digest(p_payload JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, extensions, pg_temp
AS $$
  SELECT encode(
    extensions.digest(
      (
        COALESCE(p_payload, '{}'::JSONB)
        - 'operation_id'
        - 'operationId'
        - 'protocol_version'
        - 'protocolVersion'
        - 'client_git_sha'
        - 'clientGitSha'
        - 'client_origin'
        - 'clientOrigin'
        - 'deployment_epoch'
        - 'deploymentEpoch'
        - 'deployment_target'
        - 'deploymentTarget'
      )::TEXT,
      'sha256'
    ),
    'hex'
  );
$$;

COMMENT ON FUNCTION public.sync_rpc_replay_payload_digest(JSONB) IS
  'Hashes logical sync mutation fields while excluding volatile retry envelope metadata.';

REVOKE ALL ON FUNCTION public.sync_rpc_replay_payload_digest(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_operation_log_fill_payload_digest()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_payload_digest TEXT := NULLIF(current_setting('app.payload_digest', true), '');
  v_replay_payload_digest TEXT := NULLIF(current_setting('app.replay_payload_digest', true), '');
BEGIN
  IF NEW.payload_digest IS NULL AND v_payload_digest IS NOT NULL THEN
    NEW.payload_digest := v_payload_digest;
  END IF;

  IF NEW.replay_payload_digest IS NULL AND v_replay_payload_digest IS NOT NULL THEN
    NEW.replay_payload_digest := v_replay_payload_digest;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_resolve_operation_replay(
  p_operation_id UUID,
  p_user_id UUID,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_payload_digest TEXT := encode(extensions.digest(p_payload::TEXT, 'sha256'), 'hex');
  v_replay_payload_digest TEXT := public.sync_rpc_replay_payload_digest(p_payload);
  v_log_existing RECORD;
BEGIN
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  PERFORM set_config('app.replay_payload_digest', v_replay_payload_digest, true);

  IF p_operation_id IS NULL OR p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Keep the lock until the outer mutation transaction ends. Concurrent first
  -- use of one operation id must not both miss the log and race on its PK.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::TEXT, 0)
  );

  SELECT user_id, payload_digest, replay_payload_digest, result_payload, status, reject_reason
    INTO v_log_existing
    FROM public.sync_operation_log
    WHERE operation_id = p_operation_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_log_existing.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object(
      'status', 'unauthorized',
      'reason', 'operation_id owned by other user'
    );
  END IF;

  IF v_log_existing.replay_payload_digest IS NOT NULL
    AND v_log_existing.replay_payload_digest IS DISTINCT FROM v_replay_payload_digest
  THEN
    RETURN jsonb_build_object(
      'status', 'unauthorized',
      'reason', 'operation_id_payload_mismatch',
      'operation_id', p_operation_id,
      'existing_payload_digest', v_log_existing.replay_payload_digest,
      'payload_digest', v_replay_payload_digest
    );
  END IF;

  -- Legacy rows have only the full-payload digest. Trust their owner-scoped
  -- operation id so a deploy-envelope change cannot strand an unknown outcome.
  -- Only an exact legacy match is safe to ratchet into the new digest column.
  IF v_log_existing.replay_payload_digest IS NULL
    AND v_log_existing.payload_digest IS NOT DISTINCT FROM v_payload_digest
  THEN
    UPDATE public.sync_operation_log
       SET replay_payload_digest = v_replay_payload_digest
     WHERE operation_id = p_operation_id
       AND user_id = p_user_id
       AND replay_payload_digest IS NULL;
  END IF;

  RETURN COALESCE(
    v_log_existing.result_payload,
    jsonb_build_object(
      'status', v_log_existing.status,
      'reason', v_log_existing.reject_reason
    )
  );
END;
$$;

COMMENT ON FUNCTION public.sync_resolve_operation_replay(UUID, UUID, JSONB) IS
  'Resolves owner-scoped idempotent replay with stable digests and legacy-row compatibility.';

REVOKE ALL ON FUNCTION public.sync_resolve_operation_replay(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

DO $sync_rpc_replay_digest_self_check$
DECLARE
  v_base JSONB := jsonb_build_object(
    'operation_id', '11111111-1111-4111-8111-111111111111',
    'protocol_version', 1,
    'client_git_sha', 'release-a',
    'client_origin', 'https://origin-a.example',
    'deployment_epoch', 1,
    'deployment_target', 'production',
    'task', jsonb_build_object('id', '22222222-2222-4222-8222-222222222222', 'title', 'same')
  );
  v_envelope_drift JSONB := jsonb_build_object(
    'operation_id', '33333333-3333-4333-8333-333333333333',
    'protocol_version', 9,
    'client_git_sha', 'release-b',
    'client_origin', 'https://origin-b.example',
    'deployment_epoch', 9,
    'deployment_target', 'replacement',
    'task', jsonb_build_object('id', '22222222-2222-4222-8222-222222222222', 'title', 'same')
  );
  v_business_change JSONB := v_envelope_drift
    || jsonb_build_object(
      'task', jsonb_build_object('id', '22222222-2222-4222-8222-222222222222', 'title', 'changed')
    );
BEGIN
  IF public.sync_rpc_replay_payload_digest(v_base)
    IS DISTINCT FROM public.sync_rpc_replay_payload_digest(v_envelope_drift)
  THEN
    RAISE EXCEPTION 'sync replay digest changes across deployment envelope drift';
  END IF;

  IF public.sync_rpc_replay_payload_digest(v_base)
    IS NOT DISTINCT FROM public.sync_rpc_replay_payload_digest(v_business_change)
  THEN
    RAISE EXCEPTION 'sync replay digest ignores a business payload change';
  END IF;
END;
$sync_rpc_replay_digest_self_check$;

CREATE OR REPLACE FUNCTION public.sync_upsert_task(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := NULLIF(payload->>'operation_id', '')::UUID;
  v_task JSONB := COALESCE(payload->'task', '{}'::JSONB);
  v_task_id UUID := NULLIF(v_task->>'id', '')::UUID;
  v_project_id UUID := NULLIF(v_task->>'project_id', '')::UUID;
  v_write_intent TEXT := COALESCE(NULLIF(v_task->>'write_intent', ''), NULLIF(v_task->>'writeIntent', ''));
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_replay_payload_digest TEXT := public.sync_rpc_replay_payload_digest(payload);
  v_changed_fields JSONB;
  v_replay_result JSONB;
  v_result JSONB;
  v_quarantine_id BIGINT;
BEGIN
  IF v_task_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('sync_upsert_task'), hashtext(v_task_id::TEXT));
  END IF;

  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;

  IF v_task_id IS NOT NULL THEN
    v_changed_fields := public.sync_task_changed_fields(v_task_id, v_task);
  END IF;

  IF v_user IS NOT NULL AND v_op_id IS NOT NULL AND v_task_id IS NOT NULL AND v_project_id IS NOT NULL AND v_changed_fields IS NOT NULL AND v_write_intent IS NULL THEN
    v_quarantine_id := public.record_sync_write_quarantine(
      v_op_id,
      v_user,
      'task',
      v_task_id,
      v_client_git,
      v_client_origin,
      'task_write_intent_required',
      payload
    );
    v_result := jsonb_build_object(
      'status', 'quarantined',
      'decision', 'quarantined',
      'reason', 'task_write_intent_required',
      'operation_id', v_op_id,
      'task_id', v_task_id,
      'changed_fields', v_changed_fields,
      'write_intent', v_write_intent,
      'quarantine_id', v_quarantine_id,
      'audit_id', NULL
    );

    INSERT INTO public.sync_operation_log (
      operation_id,
      user_id,
      entity_type,
      entity_id,
      status,
      reject_reason,
      protocol_version,
      deployment_epoch,
      deployment_target,
      client_git_sha,
      client_origin,
      payload_digest,
      replay_payload_digest,
      result_payload
    )
    VALUES (
      v_op_id,
      v_user,
      'task',
      v_task_id,
      'quarantined',
      'task_write_intent_required',
      v_protocol,
      v_client_epoch,
      v_deployment_target,
      v_client_git,
      v_client_origin,
      v_payload_digest,
      v_replay_payload_digest,
      v_result
    );

    RETURN v_result;
  END IF;

  v_result := public.sync_upsert_task__unguarded_20260628(payload);

  IF v_changed_fields IS NOT NULL
    AND v_result->>'status' IN ('applied', 'remote-newer', 'quarantined')
  THEN
    v_result := jsonb_set(v_result, '{changed_fields}', v_changed_fields, true);
    IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
      UPDATE public.sync_operation_log
         SET result_payload = v_result
       WHERE operation_id = v_op_id
         AND user_id = v_user;
    END IF;
  END IF;

  RETURN v_result;
END;
$$;

-- All Data API task writes must pass through sync_upsert_task so existing rows
-- cannot bypass the write-intent and operation-log protocol.
REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_upsert_connection(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_upsert_connection__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_blackbox_entry(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_upsert_blackbox_entry__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_project(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_upsert_project__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_user_preferences(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_upsert_user_preferences__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_focus_session(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_upsert_focus_session__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_routine_task(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_upsert_routine_task__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_increment_routine_completion(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;
  RETURN public.sync_increment_routine_completion__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_delete_project(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_base_updated TIMESTAMPTZ := NULLIF(payload->>'base_updated_at', '')::TIMESTAMPTZ;
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_project_id UUID := (payload->>'project_id')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_owner UUID;
  v_existing_updated TIMESTAMPTZ;
  v_existing_deleted TIMESTAMPTZ;
  v_replay_result JSONB;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    v_result := jsonb_build_object(
      'status', 'client-version-rejected',
      'reason', CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
      payload_digest, result_payload)
    VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'client-version-rejected',
      v_result->>'reason', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
      v_payload_digest, v_result);
    RETURN v_result;
  END IF;

  SELECT owner_id, updated_at, deleted_at
    INTO v_existing_owner, v_existing_updated, v_existing_deleted
    FROM public.projects
    WHERE id = v_project_id
    FOR UPDATE;

  IF NOT FOUND THEN
    v_result := jsonb_build_object(
      'status', 'applied',
      'operation_id', v_op_id,
      'project_id', v_project_id,
      'deleted_count', 0
    );
  ELSE
    IF v_existing_owner IS DISTINCT FROM v_user THEN
      v_result := jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
        payload_digest, result_payload)
      VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'unauthorized',
        'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
        v_payload_digest, v_result);
      RETURN v_result;
    END IF;

    IF v_existing_deleted IS NULL AND v_base_updated IS NULL THEN
      v_result := jsonb_build_object(
        'status', 'remote-newer',
        'operation_id', v_op_id,
        'project_id', v_project_id,
        'remote_updated_at', v_existing_updated,
        'reason', 'missing_base_updated_at'
      );
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
        payload_digest, result_payload)
      VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'remote-newer',
        'missing_base_updated_at', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
        v_payload_digest, v_result);
      RETURN v_result;
    END IF;

    IF v_existing_deleted IS NULL AND v_base_updated IS DISTINCT FROM v_existing_updated THEN
      v_result := jsonb_build_object(
        'status', 'remote-newer',
        'operation_id', v_op_id,
        'project_id', v_project_id,
        'remote_updated_at', v_existing_updated,
        'reason', 'cas_mismatch'
      );
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
        payload_digest, result_payload)
      VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'remote-newer',
        'cas_mismatch', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
        v_payload_digest, v_result);
      RETURN v_result;
    END IF;

    IF v_existing_deleted IS NULL THEN
      PERFORM public.soft_delete_project(v_project_id);
      SELECT updated_at INTO v_written_updated FROM public.projects WHERE id = v_project_id;
    ELSE
      v_written_updated := v_existing_updated;
    END IF;

    v_result := jsonb_build_object(
      'status', 'applied',
      'operation_id', v_op_id,
      'project_id', v_project_id,
      'updated_at', v_written_updated
    );
  END IF;

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin,
    payload_digest, result_payload)
  VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin,
    v_payload_digest, v_result);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_delete_tasks(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_replay_result JSONB;
  v_max_task_ids CONSTANT INTEGER := 100;
BEGIN
  v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload);
  IF v_replay_result IS NOT NULL THEN
    RETURN v_replay_result;
  END IF;

  IF payload ? 'task_ids' AND jsonb_typeof(payload->'task_ids') <> 'array' THEN
    RAISE EXCEPTION 'sync_delete_tasks task_ids must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(COALESCE(payload->'task_ids', '[]'::JSONB)) > v_max_task_ids THEN
    RAISE EXCEPTION 'sync_delete_tasks accepts at most % task ids', v_max_task_ids
      USING ERRCODE = '22023';
  END IF;

  RETURN public.sync_delete_tasks__unguarded_20260628(payload);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_upsert_task(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_connection(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_project(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_user_preferences(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_focus_session(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_routine_task(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_increment_routine_completion(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_delete_project(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_delete_tasks(JSONB) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.sync_upsert_task(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_connection(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_project(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_user_preferences(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_focus_session(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_routine_task(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_increment_routine_completion(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_delete_project(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_delete_tasks(JSONB) TO authenticated;

COMMENT ON FUNCTION public.sync_delete_tasks(JSONB) IS
  'Stable replay-digest guarded task delete wrapper capped at 100 task IDs per call.';

-- FINAL CONVERGENCE: 20260728000300 tasks completed_at unused index retirement

DO $tasks_completed_at_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.idx_tasks_project_completed_at');

  IF target_index IS NOT NULL THEN
    SELECT
      lower(regexp_replace(pg_get_indexdef(index_row.indexrelid), '\s+', ' ', 'g')),
      lower(regexp_replace(pg_get_expr(index_row.indpred, index_row.indrelid), '\s+', ' ', 'g'))
    INTO
      normalized_index_definition,
      normalized_predicate
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_row.indexrelid = target_index
      AND index_row.indrelid = 'public.tasks'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NOT NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index idx_tasks_project_completed_at on public.tasks using btree (project_id, completed_at desc) where ((completed_at is not null) and (deleted_at is null))'
      OR normalized_predicate IS DISTINCT FROM
        '((completed_at is not null) and (deleted_at is null))'
    THEN
      RAISE EXCEPTION 'tasks completed_at legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.idx_tasks_project_completed_at on public.tasks(project_id, completed_at DESC) WHERE completed_at IS NOT NULL AND deleted_at IS NULL, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$tasks_completed_at_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_tasks_project_completed_at;
SET LOCAL lock_timeout = DEFAULT;

-- FINAL CONVERGENCE: 20260728000400 sync_write_quarantine user reason unused index retirement

DO $sync_write_quarantine_user_reason_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.sync_write_quarantine_user_reason_idx');

  IF target_index IS NOT NULL THEN
    SELECT
      lower(regexp_replace(pg_get_indexdef(index_row.indexrelid), '\s+', ' ', 'g')),
      lower(regexp_replace(pg_get_expr(index_row.indpred, index_row.indrelid), '\s+', ' ', 'g'))
    INTO
      normalized_index_definition,
      normalized_predicate
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_row.indexrelid = target_index
      AND index_row.indrelid = 'public.sync_write_quarantine'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 3
      AND index_row.indnatts = 3
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index sync_write_quarantine_user_reason_idx on public.sync_write_quarantine using btree (user_id, reason, created_at desc)'
      OR normalized_predicate IS NOT NULL
    THEN
      RAISE EXCEPTION 'sync_write_quarantine user/reason legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.sync_write_quarantine_user_reason_idx on public.sync_write_quarantine(user_id, reason, created_at DESC) without predicate, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$sync_write_quarantine_user_reason_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.sync_write_quarantine_user_reason_idx;
SET LOCAL lock_timeout = DEFAULT;

-- FINAL CONVERGENCE: 20260728000500 widget request rate limits blocked until unused index retirement

DO $widget_request_rate_limits_blocked_until_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.idx_widget_request_rate_limits_blocked_until');

  IF target_index IS NOT NULL THEN
    SELECT
      lower(regexp_replace(pg_get_indexdef(index_row.indexrelid), '\s+', ' ', 'g')),
      lower(regexp_replace(pg_get_expr(index_row.indpred, index_row.indrelid), '\s+', ' ', 'g'))
    INTO
      normalized_index_definition,
      normalized_predicate
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_row.indexrelid = target_index
      AND index_row.indrelid = 'public.widget_request_rate_limits'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NOT NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index idx_widget_request_rate_limits_blocked_until on public.widget_request_rate_limits using btree (blocked_until) where (blocked_until is not null)'
      OR normalized_predicate IS DISTINCT FROM
        '(blocked_until is not null)'
    THEN
      RAISE EXCEPTION 'widget_request_rate_limits blocked_until legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.idx_widget_request_rate_limits_blocked_until on public.widget_request_rate_limits(blocked_until) WHERE blocked_until IS NOT NULL, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$widget_request_rate_limits_blocked_until_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_widget_request_rate_limits_blocked_until;
SET LOCAL lock_timeout = DEFAULT;

-- FINAL CONVERGENCE: 20260728000600 widget devices expires_at unused index retirement

DO $widget_devices_expires_at_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.idx_widget_devices_expires_at');

  IF target_index IS NOT NULL THEN
    SELECT
      lower(regexp_replace(pg_get_indexdef(index_row.indexrelid), '\s+', ' ', 'g')),
      lower(regexp_replace(pg_get_expr(index_row.indpred, index_row.indrelid), '\s+', ' ', 'g'))
    INTO
      normalized_index_definition,
      normalized_predicate
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_row.indexrelid = target_index
      AND index_row.indrelid = 'public.widget_devices'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index idx_widget_devices_expires_at on public.widget_devices using btree (expires_at)'
      OR normalized_predicate IS NOT NULL
    THEN
      RAISE EXCEPTION 'widget_devices expires_at legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.idx_widget_devices_expires_at on public.widget_devices(expires_at) without predicate, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$widget_devices_expires_at_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_widget_devices_expires_at;
SET LOCAL lock_timeout = DEFAULT;

-- FINAL CONVERGENCE: 20260728000700 sync_operation_log payload_digest unused index retirement

DO $sync_operation_log_payload_digest_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.idx_sync_operation_log_payload_digest');

  IF target_index IS NOT NULL THEN
    SELECT
      lower(regexp_replace(pg_get_indexdef(index_row.indexrelid), '\s+', ' ', 'g')),
      lower(regexp_replace(pg_get_expr(index_row.indpred, index_row.indrelid), '\s+', ' ', 'g'))
    INTO
      normalized_index_definition,
      normalized_predicate
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_row.indexrelid = target_index
      AND index_row.indrelid = 'public.sync_operation_log'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NOT NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index idx_sync_operation_log_payload_digest on public.sync_operation_log using btree (payload_digest) where (payload_digest is not null)'
      OR normalized_predicate IS DISTINCT FROM
        '(payload_digest is not null)'
    THEN
      RAISE EXCEPTION 'sync_operation_log payload_digest legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.idx_sync_operation_log_payload_digest on public.sync_operation_log(payload_digest) WHERE payload_digest IS NOT NULL, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$sync_operation_log_payload_digest_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_sync_operation_log_payload_digest;
SET LOCAL lock_timeout = DEFAULT;

-- FINAL CONVERGENCE: 20260728000800 sync_operation_log entity-created unused index retirement

DO $sync_operation_log_entity_created_unused_index_retirement$
DECLARE
  target_index REGCLASS;
  normalized_index_definition TEXT;
  normalized_predicate TEXT;
BEGIN
  target_index := to_regclass('public.idx_sync_operation_log_entity_created');

  IF target_index IS NOT NULL THEN
    SELECT
      lower(regexp_replace(pg_get_indexdef(index_row.indexrelid), '\s+', ' ', 'g')),
      lower(regexp_replace(pg_get_expr(index_row.indpred, index_row.indrelid), '\s+', ' ', 'g'))
    INTO
      normalized_index_definition,
      normalized_predicate
    FROM pg_index AS index_row
    JOIN pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_row.indexrelid = target_index
      AND index_row.indrelid = 'public.sync_operation_log'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 3
      AND index_row.indnatts = 3
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
      AND access_method.amname = 'btree';

    IF normalized_index_definition IS DISTINCT FROM
      'create index idx_sync_operation_log_entity_created on public.sync_operation_log using btree (entity_type, entity_id, created_at desc)'
      OR normalized_predicate IS NOT NULL
    THEN
      RAISE EXCEPTION 'sync_operation_log entity-created legacy index is missing or invalid'
        USING DETAIL = format(
          'Expected public.idx_sync_operation_log_entity_created on public.sync_operation_log(entity_type, entity_id, created_at DESC) without predicate, got indexdef=%s predicate=%s',
          normalized_index_definition,
          normalized_predicate
        );
    END IF;
  END IF;
END
$sync_operation_log_entity_created_unused_index_retirement$;

SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_sync_operation_log_entity_created;
SET LOCAL lock_timeout = DEFAULT;

-- FINAL CONVERGENCE: 20260729000000 widget black box action idempotency

-- Durable Widget Gate action receipts make weak-network retries replayable
-- without refreshing black-box cooldown or completion timestamps.
CREATE TABLE IF NOT EXISTS public.widget_black_box_action_receipts (
  device_id UUID NOT NULL REFERENCES public.widget_devices(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL,
  user_id UUID NOT NULL,
  entry_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('read', 'complete')),
  origin_binding_generation INTEGER NOT NULL CHECK (origin_binding_generation >= 1),
  canonical_response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  PRIMARY KEY (device_id, operation_id),
  UNIQUE (operation_id),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_widget_black_box_action_receipts_retention
  ON public.widget_black_box_action_receipts (expires_at, device_id, operation_id);

ALTER TABLE public.widget_black_box_action_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_black_box_action_receipts FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.widget_black_box_action_receipts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_widget_black_box_action(
  p_user_id UUID,
  p_device_id UUID,
  p_entry_id UUID,
  p_action TEXT,
  p_origin_binding_generation INTEGER,
  p_operation_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $widget_black_box_action$
DECLARE
  v_now TIMESTAMPTZ;
  v_device public.widget_devices%ROWTYPE;
  v_receipt public.widget_black_box_action_receipts%ROWTYPE;
  v_entry public.black_box_entries%ROWTYPE;
  v_result JSONB;
BEGIN
  IF p_user_id IS NULL OR p_device_id IS NULL OR p_entry_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 400,
      'code', 'INVALID_REQUEST',
      'error', 'userId, deviceId, and entryId are required'
    );
  END IF;

  IF p_action IS DISTINCT FROM 'read' AND p_action IS DISTINCT FROM 'complete' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 400,
      'code', 'INVALID_ACTION',
      'error', 'action must be read or complete'
    );
  END IF;

  IF p_origin_binding_generation IS NULL OR p_origin_binding_generation < 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 400,
      'code', 'INVALID_BINDING_GENERATION',
      'error', 'originBindingGeneration must be a positive integer'
    );
  END IF;

  SELECT devices.*
  INTO v_device
  FROM public.widget_devices AS devices
  WHERE devices.id = p_device_id
  FOR UPDATE OF devices;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 401,
      'code', 'TOKEN_INVALID',
      'error', 'Widget device does not exist'
    );
  END IF;

  IF p_operation_id IS NOT NULL THEN
    -- The operation lock also serializes the vanishingly rare cross-device
    -- UUID collision before the globally unique receipt is inspected.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_operation_id::TEXT, 0)
    );
    v_now := pg_catalog.clock_timestamp();

    DELETE FROM public.widget_black_box_action_receipts AS receipts
    WHERE receipts.operation_id = p_operation_id
      AND receipts.expires_at <= v_now;

    SELECT receipts.*
    INTO v_receipt
    FROM public.widget_black_box_action_receipts AS receipts
    WHERE receipts.operation_id = p_operation_id
    FOR UPDATE OF receipts;

    IF FOUND THEN
      IF v_device.user_id IS DISTINCT FROM p_user_id
        OR v_receipt.device_id IS DISTINCT FROM p_device_id
        OR v_receipt.user_id IS DISTINCT FROM p_user_id
        OR v_receipt.entry_id IS DISTINCT FROM p_entry_id
        OR v_receipt.action IS DISTINCT FROM p_action
        OR v_receipt.origin_binding_generation IS DISTINCT FROM p_origin_binding_generation
      THEN
        RETURN pg_catalog.jsonb_build_object(
          'ok', FALSE,
          'status', 409,
          'code', 'OPERATION_ID_CONFLICT',
          'error', 'operationId is already bound to a different Widget action'
        );
      END IF;

      RETURN v_receipt.canonical_response;
    END IF;
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_device.user_id IS DISTINCT FROM p_user_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 401,
      'code', 'BINDING_MISMATCH',
      'error', 'Widget device belongs to another user'
    );
  END IF;

  IF v_device.revoked_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 401,
      'code', 'DEVICE_REVOKED',
      'error', 'Widget binding has been revoked'
    );
  END IF;

  IF v_device.expires_at <= v_now THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 401,
      'code', 'TOKEN_EXPIRED',
      'error', 'Widget token has expired'
    );
  END IF;

  IF v_device.binding_generation IS DISTINCT FROM p_origin_binding_generation THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 409,
      'code', 'BINDING_GENERATION_MISMATCH',
      'error', 'Widget action originated from a stale binding generation'
    );
  END IF;

  IF p_action = 'read' THEN
    UPDATE public.black_box_entries AS entries
    SET is_read = TRUE
    WHERE entries.id = p_entry_id
      AND entries.user_id = p_user_id
      AND entries.deleted_at IS NULL
    RETURNING entries.* INTO v_entry;
  ELSE
    UPDATE public.black_box_entries AS entries
    SET
      is_completed = TRUE,
      completed_at = COALESCE(entries.completed_at, v_now)
    WHERE entries.id = p_entry_id
      AND entries.user_id = p_user_id
      AND entries.deleted_at IS NULL
    RETURNING entries.* INTO v_entry;
  END IF;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', FALSE,
      'status', 404,
      'code', 'ENTRY_NOT_FOUND',
      'error', 'Black box entry not found for user'
    );
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'ok', TRUE,
    'entryId', v_entry.id,
    'action', p_action,
    'isRead', v_entry.is_read,
    'isCompleted', v_entry.is_completed,
    'completedAt', v_entry.completed_at,
    'snoozeUntil', v_entry.snooze_until,
    'updatedAt', v_entry.updated_at
  );

  IF p_operation_id IS NOT NULL THEN
    INSERT INTO public.widget_black_box_action_receipts (
      device_id,
      operation_id,
      user_id,
      entry_id,
      action,
      origin_binding_generation,
      canonical_response,
      created_at,
      expires_at
    )
    VALUES (
      p_device_id,
      p_operation_id,
      p_user_id,
      p_entry_id,
      p_action,
      p_origin_binding_generation,
      v_result,
      v_now,
      v_now + INTERVAL '30 days'
    );
  END IF;

  RETURN v_result;
END;
$widget_black_box_action$;

COMMENT ON FUNCTION public.apply_widget_black_box_action(UUID, UUID, UUID, TEXT, INTEGER, UUID) IS
  'Atomically applies or replays one owner-bound Widget Gate black-box action.';

REVOKE ALL ON FUNCTION public.apply_widget_black_box_action(UUID, UUID, UUID, TEXT, INTEGER, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_widget_black_box_action(UUID, UUID, UUID, TEXT, INTEGER, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.cleanup_widget_operational_state(
  p_retention INTERVAL DEFAULT INTERVAL '30 days',
  p_batch_size INTEGER DEFAULT 5000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_notify_events_deleted INTEGER := 0;
  v_rate_limits_deleted INTEGER := 0;
  v_receipts_deleted INTEGER := 0;
  v_result JSONB;
BEGIN
  IF p_retention IS NULL
    OR p_retention < INTERVAL '1 day'
    OR p_retention > INTERVAL '365 days'
  THEN
    RAISE EXCEPTION 'widget retention must be between 1 and 365 days'
      USING ERRCODE = '22023';
  END IF;

  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'widget retention batch size must be between 1 and 10000'
      USING ERRCODE = '22023';
  END IF;

  WITH expired_events AS MATERIALIZED (
    SELECT events.ctid AS row_ctid
    FROM public.widget_notify_events AS events
    WHERE events.processed_at < v_now - p_retention
    ORDER BY events.processed_at, events.webhook_id
    FOR UPDATE OF events SKIP LOCKED
    LIMIT p_batch_size
  ),
  deleted AS (
    DELETE FROM public.widget_notify_events AS events
    WHERE events.ctid IN (
      SELECT expired_events.row_ctid
      FROM expired_events
    )
    RETURNING 1
  )
  SELECT count(*)::INTEGER
  INTO v_notify_events_deleted
  FROM deleted;

  WITH expired_limits AS MATERIALIZED (
    SELECT limits.ctid AS row_ctid
    FROM public.widget_request_rate_limits AS limits
    WHERE limits.updated_at < v_now - p_retention
      AND (limits.blocked_until IS NULL OR limits.blocked_until <= v_now)
    ORDER BY limits.updated_at, limits.scope_type, limits.scope_key
    FOR UPDATE OF limits SKIP LOCKED
    LIMIT p_batch_size
  ),
  deleted AS (
    DELETE FROM public.widget_request_rate_limits AS limits
    WHERE limits.ctid IN (
      SELECT expired_limits.row_ctid
      FROM expired_limits
    )
    RETURNING 1
  )
  SELECT count(*)::INTEGER
  INTO v_rate_limits_deleted
  FROM deleted;

  WITH expired_receipts AS MATERIALIZED (
    SELECT receipts.device_id, receipts.operation_id
    FROM public.widget_black_box_action_receipts AS receipts
    WHERE receipts.expires_at <= v_now
    ORDER BY receipts.expires_at, receipts.device_id, receipts.operation_id
    FOR UPDATE OF receipts SKIP LOCKED
    LIMIT p_batch_size
  ),
  deleted AS (
    DELETE FROM public.widget_black_box_action_receipts AS receipts
    USING expired_receipts
    WHERE receipts.device_id = expired_receipts.device_id
      AND receipts.operation_id = expired_receipts.operation_id
    RETURNING 1
  )
  SELECT count(*)::INTEGER
  INTO v_receipts_deleted
  FROM deleted;

  v_result := pg_catalog.jsonb_build_object(
    'widget_notify_events_deleted', v_notify_events_deleted,
    'widget_request_rate_limits_deleted', v_rate_limits_deleted,
    'widget_black_box_action_receipts_deleted', v_receipts_deleted,
    'retention_seconds', EXTRACT(EPOCH FROM p_retention)::BIGINT,
    'batch_limit', p_batch_size,
    'cleanup_time', v_now
  );

  IF v_notify_events_deleted + v_rate_limits_deleted + v_receipts_deleted > 0 THEN
    INSERT INTO public.cleanup_logs (type, details, created_at)
    VALUES ('widget_operational_retention', v_result, v_now);
  END IF;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.cleanup_widget_operational_state(INTERVAL, INTEGER) IS
  'Deletes bounded 30-day Widget operational state and is callable only by the database owner/pg_cron.';

REVOKE ALL ON FUNCTION public.cleanup_widget_operational_state(INTERVAL, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;


NOTIFY pgrst, 'reload schema';

-- FINAL CONVERGENCE: 20260730000000 transcription usage quota immutability
ALTER TABLE public.transcription_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "transcription_usage_select_policy" ON public.transcription_usage;
DROP POLICY IF EXISTS "transcription_usage_select" ON public.transcription_usage;
DROP POLICY IF EXISTS "transcription_usage_insert_policy" ON public.transcription_usage;
DROP POLICY IF EXISTS "transcription_usage_update_policy" ON public.transcription_usage;
DROP POLICY IF EXISTS "transcription_usage_delete_policy" ON public.transcription_usage;
CREATE POLICY "transcription_usage_select" ON public.transcription_usage FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON TABLE public.transcription_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.transcription_usage TO authenticated;
GRANT ALL ON TABLE public.transcription_usage TO service_role;
NOTIFY pgrst, 'reload schema';

-- FINAL CONVERGENCE: 20260428083000 task completed_at trigger init parity

CREATE OR REPLACE FUNCTION public.set_task_completed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'completed' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.completed_at := COALESCE(NEW.completed_at, now());
    ELSIF OLD.status IS DISTINCT FROM 'completed' THEN
      NEW.completed_at := COALESCE(NEW.completed_at, now());
    ELSE
      NEW.completed_at := COALESCE(NEW.completed_at, OLD.completed_at, now());
    END IF;
  ELSE
    NEW.completed_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_task_completed_at()
  TO PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS set_task_completed_at ON public.tasks;
CREATE TRIGGER set_task_completed_at
  BEFORE INSERT OR UPDATE OF status, completed_at ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.set_task_completed_at();

-- FINAL CONVERGENCE: 20260319153259 get_vault_secret fresh-init parity

CREATE OR REPLACE FUNCTION public.get_vault_secret(p_name text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'pg_catalog', 'vault'
AS $$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE name = p_name
  ORDER BY updated_at DESC
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.get_vault_secret(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_vault_secret(text) FROM anon;
REVOKE ALL ON FUNCTION public.get_vault_secret(text) FROM authenticated;
-- FINAL CONVERGENCE: 20260731000000 external source link operation identity
CREATE OR REPLACE FUNCTION public.prevent_external_source_links_stale_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF OLD.operation_id IS NOT NULL
    AND NEW.operation_id = OLD.operation_id
  THEN
    IF ROW(
      OLD.id, OLD.user_id, OLD.task_id, OLD.source_type, OLD.target_id,
      OLD.uri, OLD.label, OLD.hpath, OLD.role, OLD.sort_order,
      OLD.deleted_at, OLD.created_at, OLD.updated_at
    ) IS DISTINCT FROM ROW(
      NEW.id, NEW.user_id, NEW.task_id, NEW.source_type, NEW.target_id,
      NEW.uri, NEW.label, NEW.hpath, NEW.role, NEW.sort_order,
      NEW.deleted_at, NEW.created_at, NEW.updated_at
    ) THEN
      RAISE EXCEPTION 'external_source_links operation replay payload mismatch'
        USING ERRCODE = '22023';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.updated_at IS NOT NULL
    AND NEW.updated_at IS NOT NULL
    AND OLD.updated_at > NEW.updated_at + interval '1 second'
  THEN
    RETURN OLD;
  END IF;

  IF OLD.deleted_at IS NOT NULL
    AND NEW.deleted_at IS NULL
    AND OLD.updated_at IS NOT NULL
    AND NEW.updated_at IS NOT NULL
    AND OLD.updated_at >= NEW.updated_at - interval '1 second'
  THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_external_source_links_stale_write()
  FROM PUBLIC, anon, authenticated;
-- ============================================================
-- 初始化完成
-- ============================================================
