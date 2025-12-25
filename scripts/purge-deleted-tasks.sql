-- ============================================================
-- NanoFlow: 服务器端自动清理软删除任务
-- ============================================================
-- 
-- 【来自高级顾问建议】
-- 不要在客户端实现硬删除同步逻辑，让数据库负责垃圾回收。
-- 使用 pg_cron 定期清理 30 天前的软删除记录。
--
-- 优点：
-- 1. 消除客户端"僵尸记录"问题（删除的任务在同步前被拉取回来）
-- 2. 简化客户端同步逻辑（只做软删除，无需处理硬删除同步）
-- 3. 保持数据一致性（单一数据源负责物理删除）
--
-- 执行方式：
-- 1. 在 Supabase SQL Editor 中运行此脚本
-- 2. 或者通过 Supabase 仪表板 -> Database -> Extensions 启用 pg_cron
-- ============================================================

-- 1. 启用 pg_cron 扩展（如果尚未启用）
-- 注意：在 Supabase 上，pg_cron 可能需要通过仪表板启用
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. 定义清理函数
-- 这个函数会：
--   a) 删除 30 天前软删除的任务记录
--   b) 同时删除相关的连接记录
--   c) 返回清理的记录数量
CREATE OR REPLACE FUNCTION purge_deleted_tasks()
RETURNS TABLE(deleted_tasks_count BIGINT, deleted_connections_count BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  tasks_deleted BIGINT;
  connections_deleted BIGINT;
  cutoff_time TIMESTAMPTZ;
BEGIN
  -- 计算截止时间：30 天前
  cutoff_time := NOW() - INTERVAL '30 days';
  
  -- 先删除相关的连接（外键约束）
  WITH deleted_conn AS (
    DELETE FROM connections
    WHERE source IN (SELECT id FROM tasks WHERE deleted_at < cutoff_time)
       OR target IN (SELECT id FROM tasks WHERE deleted_at < cutoff_time)
    RETURNING *
  )
  SELECT COUNT(*) INTO connections_deleted FROM deleted_conn;
  
  -- 删除软删除超过 30 天的任务
  WITH deleted AS (
    DELETE FROM tasks
    WHERE deleted_at < cutoff_time
    RETURNING *
  )
  SELECT COUNT(*) INTO tasks_deleted FROM deleted;
  
  -- 返回结果
  RETURN QUERY SELECT tasks_deleted, connections_deleted;
END;
$$;

-- 3. 设置定时任务：每天凌晨 3 点执行清理
-- 使用 pg_cron 调度
SELECT cron.schedule(
  'purge-deleted-tasks',        -- 任务名称
  '0 3 * * *',                  -- Cron 表达式：每天 03:00 UTC
  $$SELECT * FROM purge_deleted_tasks()$$
);

-- 4. 创建日志表（可选，用于监控清理情况）
CREATE TABLE IF NOT EXISTS task_purge_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  executed_at TIMESTAMPTZ DEFAULT NOW(),
  tasks_deleted BIGINT NOT NULL DEFAULT 0,
  connections_deleted BIGINT NOT NULL DEFAULT 0
);

-- 5. 增强清理函数：记录日志
CREATE OR REPLACE FUNCTION purge_deleted_tasks_with_log()
RETURNS TABLE(deleted_tasks_count BIGINT, deleted_connections_count BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  tasks_deleted BIGINT;
  connections_deleted BIGINT;
  cutoff_time TIMESTAMPTZ;
BEGIN
  cutoff_time := NOW() - INTERVAL '30 days';
  
  -- 删除相关连接
  WITH deleted_conn AS (
    DELETE FROM connections
    WHERE source IN (SELECT id FROM tasks WHERE deleted_at < cutoff_time)
       OR target IN (SELECT id FROM tasks WHERE deleted_at < cutoff_time)
    RETURNING *
  )
  SELECT COUNT(*) INTO connections_deleted FROM deleted_conn;
  
  -- 删除任务
  WITH deleted AS (
    DELETE FROM tasks
    WHERE deleted_at < cutoff_time
    RETURNING *
  )
  SELECT COUNT(*) INTO tasks_deleted FROM deleted;
  
  -- 记录日志（仅当有删除时）
  IF tasks_deleted > 0 OR connections_deleted > 0 THEN
    INSERT INTO task_purge_logs (tasks_deleted, connections_deleted)
    VALUES (tasks_deleted, connections_deleted);
  END IF;
  
  RETURN QUERY SELECT tasks_deleted, connections_deleted;
END;
$$;

-- 6. 更新定时任务使用带日志版本
SELECT cron.unschedule('purge-deleted-tasks');
SELECT cron.schedule(
  'purge-deleted-tasks',
  '0 3 * * *',
  $$SELECT * FROM purge_deleted_tasks_with_log()$$
);

-- ============================================================
-- 手动执行清理（用于测试或紧急清理）
-- ============================================================
-- SELECT * FROM purge_deleted_tasks_with_log();

-- ============================================================
-- 查看定时任务状态
-- ============================================================
-- SELECT * FROM cron.job;

-- ============================================================
-- 查看清理日志
-- ============================================================
-- SELECT * FROM task_purge_logs ORDER BY executed_at DESC LIMIT 10;

-- ============================================================
-- 禁用定时任务（如果需要）
-- ============================================================
-- SELECT cron.unschedule('purge-deleted-tasks');
