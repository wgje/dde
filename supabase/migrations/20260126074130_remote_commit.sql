


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."purge_result" AS (
	"purged_count" integer,
	"attachment_paths" "text"[]
);


ALTER TYPE "public"."purge_result" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."append_task_attachment"("p_task_id" "uuid", "p_attachment" "jsonb") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_current_attachments JSONB;
  v_attachment_id TEXT;
BEGIN
  v_attachment_id := p_attachment->>'id';
  IF v_attachment_id IS NULL THEN RAISE EXCEPTION 'Attachment must have an id'; END IF;
  
  SELECT attachments INTO v_current_attachments FROM tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found: %', p_task_id; END IF;
  IF v_current_attachments IS NULL THEN v_current_attachments := '[]'::JSONB; END IF;
  
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_current_attachments) AS elem WHERE elem->>'id' = v_attachment_id) THEN
    RETURN TRUE;
  END IF;
  
  UPDATE tasks SET attachments = v_current_attachments || p_attachment, updated_at = NOW() WHERE id = p_task_id;
  RETURN TRUE;
END; $$;


ALTER FUNCTION "public"."append_task_attachment"("p_task_id" "uuid", "p_attachment" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."batch_upsert_tasks"("p_tasks" "jsonb"[], "p_project_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_count integer := 0;
  v_task jsonb;
  v_user_id uuid;
BEGIN
  -- 权限校验：获取当前用户 ID
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
  END IF;
  
  -- 权限校验：验证用户是项目所有者或成员
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id 
      AND (
        p.owner_id = v_user_id
        OR EXISTS (
          SELECT 1 FROM public.project_members pm 
          WHERE pm.project_id = p.id AND pm.user_id = v_user_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'Unauthorized: not project owner or member (project_id: %, user_id: %)', p_project_id, v_user_id;
  END IF;
  
  -- 事务内执行，任何失败自动回滚
  FOREACH v_task IN ARRAY p_tasks
  LOOP
    INSERT INTO public.tasks (
      id, project_id, title, content, stage, parent_id, 
      "order", rank, status, x, y, short_id, deleted_at,
      attachments
    )
    VALUES (
      (v_task->>'id')::uuid,
      p_project_id,
      v_task->>'title',
      v_task->>'content',
      (v_task->>'stage')::integer,
      (v_task->>'parentId')::uuid,
      COALESCE((v_task->>'order')::integer, 0),
      COALESCE((v_task->>'rank')::numeric, 10000),
      COALESCE(v_task->>'status', 'active'),
      COALESCE((v_task->>'x')::numeric, 0),
      COALESCE((v_task->>'y')::numeric, 0),
      v_task->>'shortId',
      (v_task->>'deletedAt')::timestamptz,
      COALESCE(v_task->'attachments', '[]'::jsonb)
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
      attachments = EXCLUDED.attachments,
      updated_at = NOW();
    
    v_count := v_count + 1;
  END LOOP;
  
  RETURN v_count;
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$;


ALTER FUNCTION "public"."batch_upsert_tasks"("p_tasks" "jsonb"[], "p_project_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."batch_upsert_tasks"("p_tasks" "jsonb"[], "p_project_id" "uuid") IS 'Batch upsert tasks with transaction guarantee. Includes attachments field support (v5.2.3 - fixed owner_id reference).';



CREATE OR REPLACE FUNCTION "public"."check_version_increment"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."check_version_increment"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."check_version_increment"() IS 'Strict optimistic lock: rejects version regression instead of just warning. Logs to circuit_breaker_logs.';



CREATE OR REPLACE FUNCTION "public"."cleanup_deleted_attachments"("retention_days" integer DEFAULT 30) RETURNS TABLE("deleted_count" integer, "storage_paths" "text"[])
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION "public"."cleanup_deleted_attachments"("retention_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_expired_scan_records"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  deleted_count INTEGER;
  tmp_count INTEGER;
BEGIN
  -- 删除 30 天前的扫描记录（保留威胁检测记录更长时间）
  DELETE FROM public.attachment_scans
  WHERE scanned_at < NOW() - INTERVAL '30 days'
    AND status NOT IN ('threat_detected', 'quarantined');
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  -- 删除 90 天前的威胁检测记录
  DELETE FROM public.attachment_scans
  WHERE scanned_at < NOW() - INTERVAL '90 days';
  
  GET DIAGNOSTICS tmp_count = ROW_COUNT;
  deleted_count := deleted_count + tmp_count;
  
  -- 删除过期的隔离文件记录
  DELETE FROM public.quarantined_files
  WHERE expires_at < NOW() AND restored = FALSE;
  
  GET DIAGNOSTICS tmp_count = ROW_COUNT;
  deleted_count := deleted_count + tmp_count;
  
  -- 记录清理日志
  INSERT INTO public.cleanup_logs (type, details)
  VALUES ('scan_records', jsonb_build_object(
    'deleted_count', deleted_count,
    'cleaned_at', NOW()
  ));
  
  RETURN deleted_count;
END;
$$;


ALTER FUNCTION "public"."cleanup_expired_scan_records"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_old_deleted_connections"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM public.connections WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days' RETURNING id
  ) SELECT COUNT(*) INTO deleted_count FROM deleted;
  
  IF deleted_count > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES ('deleted_connections_cleanup', jsonb_build_object('deleted_count', deleted_count, 'cleanup_time', NOW()));
  END IF;
  
  RETURN deleted_count;
END; $$;


ALTER FUNCTION "public"."cleanup_old_deleted_connections"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_old_deleted_tasks"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM public.tasks WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days' RETURNING id
  ) SELECT COUNT(*) INTO deleted_count FROM deleted;
  RETURN deleted_count;
END; $$;


ALTER FUNCTION "public"."cleanup_old_deleted_tasks"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_old_logs"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM public.cleanup_logs WHERE created_at < NOW() - INTERVAL '30 days' RETURNING id
  ) SELECT COUNT(*) INTO deleted_count FROM deleted;
  RETURN deleted_count;
END; $$;


ALTER FUNCTION "public"."cleanup_old_logs"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_dashboard_stats"() RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
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
        AND t.status = 'active' 
        AND t.deleted_at IS NULL
    ),
    'completed', (
      SELECT COUNT(*) 
      FROM public.tasks t
      JOIN public.projects p ON t.project_id = p.id
      WHERE p.owner_id = current_user_id 
        AND t.status = 'completed' 
        AND t.deleted_at IS NULL
    ),
    'projects', (SELECT COUNT(*) FROM public.projects WHERE owner_id = current_user_id)
  );
END;
$$;


ALTER FUNCTION "public"."get_dashboard_stats"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_dashboard_stats"() IS 'Dashboard 统计聚合函数 - 返回用户的待处理任务数、已完成任务数和项目数。
   通过 project.owner_id 关联查询（tasks 表没有 user_id 列）。
   使用 SECURITY DEFINER 确保 RLS 生效。修复于 2026-01-07。';



CREATE OR REPLACE FUNCTION "public"."get_server_time"() RETURNS timestamp with time zone
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  SELECT NOW();
$$;


ALTER FUNCTION "public"."get_server_time"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_server_time"() IS '获取服务端当前时间，用于客户端时钟偏移检测';



CREATE OR REPLACE FUNCTION "public"."is_connection_tombstoned"("p_connection_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  -- 权限校验：无权访问时返回 false
  IF NOT EXISTS (
    SELECT 1 FROM public.connections c
    JOIN public.projects p ON c.project_id = p.id
    WHERE c.id = p_connection_id
      AND (
        p.owner_id = auth.uid() 
        OR EXISTS (
          SELECT 1 FROM public.project_members pm 
          WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
        )
      )
  ) THEN
    RETURN false;
  END IF;
  
  -- 检查是否在 tombstone 表中
  RETURN EXISTS (
    SELECT 1 FROM public.connection_tombstones
    WHERE connection_id = p_connection_id
  );
END;
$$;


ALTER FUNCTION "public"."is_connection_tombstoned"("p_connection_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_task_tombstoned"("p_task_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM public.task_tombstones 
    WHERE task_id = p_task_id
  );
$$;


ALTER FUNCTION "public"."is_task_tombstoned"("p_task_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_task_tombstoned"("p_task_id" "uuid") IS '
检查指定任务是否已被永久删除（在 tombstone 表中）。
返回 true 表示该任务已被永久删除，不应被恢复或显示。
';



CREATE OR REPLACE FUNCTION "public"."migrate_all_projects_to_v2"() RETURNS TABLE("project_id" "uuid", "project_title" "text", "tasks_migrated" integer, "connections_migrated" integer, "errors" "text"[])
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION "public"."migrate_all_projects_to_v2"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."migrate_project_data_to_v2"("p_project_id" "uuid") RETURNS TABLE("tasks_migrated" integer, "connections_migrated" integer, "errors" "text"[])
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
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


ALTER FUNCTION "public"."migrate_project_data_to_v2"("p_project_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_tombstoned_connection_writes"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.connection_tombstones WHERE connection_id = NEW.id) THEN
    -- 静默忽略，防止旧客户端数据复活
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."prevent_tombstoned_connection_writes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_tombstoned_task_writes"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
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


ALTER FUNCTION "public"."prevent_tombstoned_task_writes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_tasks"("p_task_ids" "uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
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


ALTER FUNCTION "public"."purge_tasks"("p_task_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_tasks_v2"("p_project_id" "uuid", "p_task_ids" "uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  -- 授权校验：仅项目 owner 可 purge
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 先落 tombstone（即使 tasks 行已不存在也会生效）
  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT unnest(p_task_ids), p_project_id, now(), auth.uid()
  ON CONFLICT (task_id)
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


ALTER FUNCTION "public"."purge_tasks_v2"("p_project_id" "uuid", "p_task_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_tasks_v3"("p_project_id" "uuid", "p_task_ids" "uuid"[]) RETURNS "public"."purge_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $_$
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

  -- 授权校验：仅项目 owner 可 purge
  SELECT p.owner_id INTO v_owner_id
  FROM public.projects p
  WHERE p.id = p_project_id
    AND p.owner_id = auth.uid();

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

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

  -- 落 tombstone
  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT unnest(p_task_ids), p_project_id, now(), auth.uid()
  ON CONFLICT (task_id)
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
$_$;


ALTER FUNCTION "public"."purge_tasks_v3"("p_project_id" "uuid", "p_task_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."purge_tasks_v3"("p_project_id" "uuid", "p_task_ids" "uuid"[]) IS '永久删除任务并返回附件存储路径。客户端需要调用 Storage API 删除返回的路径。';



CREATE OR REPLACE FUNCTION "public"."record_connection_tombstone"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  -- 只在真正删除时记录（不是软删除）
  IF OLD.deleted_at IS NOT NULL THEN
    INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_by)
    VALUES (OLD.id, OLD.project_id, auth.uid())
    ON CONFLICT (connection_id) DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$;


ALTER FUNCTION "public"."record_connection_tombstone"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_task_attachment"("p_task_id" "uuid", "p_attachment_id" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_current_attachments JSONB;
  v_new_attachments JSONB;
BEGIN
  SELECT attachments INTO v_current_attachments FROM tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found: %', p_task_id; END IF;
  IF v_current_attachments IS NULL OR jsonb_array_length(v_current_attachments) = 0 THEN RETURN TRUE; END IF;
  
  SELECT COALESCE(jsonb_agg(elem), '[]'::JSONB) INTO v_new_attachments
  FROM jsonb_array_elements(v_current_attachments) AS elem WHERE elem->>'id' != p_attachment_id;
  
  UPDATE tasks SET attachments = v_new_attachments, updated_at = NOW() WHERE id = p_task_id;
  RETURN TRUE;
END; $$;


ALTER FUNCTION "public"."remove_task_attachment"("p_task_id" "uuid", "p_attachment_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."safe_delete_tasks"("p_task_ids" "uuid"[], "p_project_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
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

  -- 授权检查
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.owner_id = auth.uid()
  ) THEN
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


ALTER FUNCTION "public"."safe_delete_tasks"("p_task_ids" "uuid"[], "p_project_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."safe_delete_tasks"("p_task_ids" "uuid"[], "p_project_id" "uuid") IS '安全的批量删除任务 RPC。限制：单次最多删除 50 条或 50% 的任务。';



CREATE OR REPLACE FUNCTION "public"."trigger_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_attachment_scans_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_attachment_scans_timestamp"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_task_data"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."validate_task_data"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."validate_task_data"() IS '任务数据校验触发器。确保 title/content 不同时为空，stage/rank 为有效值。';


SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."connection_tombstones" (
    "connection_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "deleted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_by" "uuid"
);


ALTER TABLE "public"."connection_tombstones" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "source_id" "uuid" NOT NULL,
    "target_id" "uuid" NOT NULL,
    "title" "text",
    "description" "text",
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);

ALTER TABLE ONLY "public"."connections" REPLICA IDENTITY FULL;


ALTER TABLE "public"."connections" OWNER TO "postgres";


COMMENT ON TABLE "public"."connections" IS '连接表 - REPLICA IDENTITY FULL for Realtime';



CREATE OR REPLACE VIEW "public"."active_connections" WITH ("security_invoker"='true') AS
 SELECT "id",
    "project_id",
    "source_id",
    "target_id",
    "title",
    "description",
    "created_at",
    "updated_at",
    "deleted_at"
   FROM "public"."connections" "c"
  WHERE ((NOT (EXISTS ( SELECT 1
           FROM "public"."connection_tombstones" "ct"
          WHERE ("ct"."connection_id" = "c"."id")))) AND ("deleted_at" IS NULL));


ALTER VIEW "public"."active_connections" OWNER TO "postgres";


COMMENT ON VIEW "public"."active_connections" IS '
Tombstone-aware 连接加载视图 - 过滤掉已永久删除的连接和软删除的连接。
与 active_tasks 视图逻辑一致，客户端应优先使用此视图而非直接查询 connections 表。
创建于 2026-01-07。
';



CREATE TABLE IF NOT EXISTS "public"."task_tombstones" (
    "task_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "deleted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_by" "uuid"
);


ALTER TABLE "public"."task_tombstones" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "parent_id" "uuid",
    "title" "text" DEFAULT ''::"text" NOT NULL,
    "content" "text" DEFAULT ''::"text",
    "stage" integer,
    "order" integer DEFAULT 0,
    "rank" numeric DEFAULT 10000,
    "status" character varying(20) DEFAULT 'active'::character varying,
    "x" numeric DEFAULT 0,
    "y" numeric DEFAULT 0,
    "short_id" character varying(20),
    "priority" character varying(20),
    "due_date" timestamp with time zone,
    "tags" "jsonb" DEFAULT '[]'::"jsonb",
    "attachments" "jsonb" DEFAULT '[]'::"jsonb",
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "tasks_priority_check" CHECK ((("priority" IS NULL) OR (("priority")::"text" = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'urgent'::character varying])::"text"[])))),
    CONSTRAINT "tasks_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['active'::character varying, 'completed'::character varying, 'archived'::character varying])::"text"[])))
);

ALTER TABLE ONLY "public"."tasks" REPLICA IDENTITY FULL;


ALTER TABLE "public"."tasks" OWNER TO "postgres";


COMMENT ON TABLE "public"."tasks" IS '任务表 - REPLICA IDENTITY FULL for Realtime';



CREATE OR REPLACE VIEW "public"."active_tasks" WITH ("security_invoker"='true') AS
 SELECT "id",
    "project_id",
    "parent_id",
    "title",
    "content",
    "stage",
    "order",
    "rank",
    "status",
    "x",
    "y",
    "short_id",
    "priority",
    "due_date",
    "tags",
    "attachments",
    "deleted_at",
    "created_at",
    "updated_at"
   FROM "public"."tasks" "t"
  WHERE ((NOT (EXISTS ( SELECT 1
           FROM "public"."task_tombstones" "tt"
          WHERE ("tt"."task_id" = "t"."id")))) AND ("deleted_at" IS NULL));


ALTER VIEW "public"."active_tasks" OWNER TO "postgres";


COMMENT ON VIEW "public"."active_tasks" IS '
自动过滤已被永久删除（tombstone）和软删除（deleted_at 不为 null）的任务的视图。
客户端应优先使用此视图而非直接查询 tasks 表，以避免已删除任务复活。
此视图解决了以下问题：
1. 永久删除的任务在其他设备上复活
2. 软删除的任务在其他设备上复活  
3. 待分配任务（stage = null）的删除也会在其他设备上恢复
';



CREATE TABLE IF NOT EXISTS "public"."app_config" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."app_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."attachment_scans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "file_id" "uuid" NOT NULL,
    "file_hash" character varying(64),
    "status" character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    "threat_name" character varying(255),
    "threat_description" "text",
    "scanner" character varying(50) DEFAULT 'clamav'::character varying NOT NULL,
    "engine_version" character varying(50),
    "signature_version" character varying(50),
    "scanned_at" timestamp with time zone DEFAULT "now"(),
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "valid_status" CHECK ((("status")::"text" = ANY ((ARRAY['pending'::character varying, 'scanning'::character varying, 'clean'::character varying, 'threat_detected'::character varying, 'failed'::character varying, 'quarantined'::character varying, 'skipped'::character varying])::"text"[])))
);


ALTER TABLE "public"."attachment_scans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."black_box_entries" (
    "id" "uuid" NOT NULL,
    "project_id" "uuid",
    "user_id" "uuid",
    "content" "text" NOT NULL,
    "date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "is_read" boolean DEFAULT false,
    "is_completed" boolean DEFAULT false,
    "is_archived" boolean DEFAULT false,
    "snooze_until" "date",
    "snooze_count" integer DEFAULT 0,
    "deleted_at" timestamp with time zone
);


ALTER TABLE "public"."black_box_entries" OWNER TO "postgres";


COMMENT ON TABLE "public"."black_box_entries" IS '黑匣子条目表 - 语音转写记录，用于紧急捕捉想法';



COMMENT ON COLUMN "public"."black_box_entries"."id" IS '由客户端 crypto.randomUUID() 生成';



COMMENT ON COLUMN "public"."black_box_entries"."content" IS '语音转写后的文本内容';



COMMENT ON COLUMN "public"."black_box_entries"."date" IS 'YYYY-MM-DD 格式，用于按日分组';



COMMENT ON COLUMN "public"."black_box_entries"."is_read" IS '是否已读，已读条目不会在大门中出现';



COMMENT ON COLUMN "public"."black_box_entries"."is_completed" IS '是否已完成，计入地质层';



COMMENT ON COLUMN "public"."black_box_entries"."is_archived" IS '是否已归档，不显示在主列表';



COMMENT ON COLUMN "public"."black_box_entries"."snooze_until" IS '跳过至该日期，在此之前不会在大门中出现';



COMMENT ON COLUMN "public"."black_box_entries"."snooze_count" IS '已跳过次数';



CREATE TABLE IF NOT EXISTS "public"."circuit_breaker_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "operation" "text" NOT NULL,
    "blocked" boolean DEFAULT false NOT NULL,
    "reason" "text",
    "details" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."circuit_breaker_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."circuit_breaker_logs" IS '熔断操作审计日志。记录所有批量删除操作（包括被阻止和成功的）。';



CREATE TABLE IF NOT EXISTS "public"."cleanup_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "type" character varying(50) NOT NULL,
    "details" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."cleanup_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" character varying(20) DEFAULT 'viewer'::character varying,
    "invited_by" "uuid",
    "invited_at" timestamp with time zone DEFAULT "now"(),
    "accepted_at" timestamp with time zone,
    CONSTRAINT "project_members_role_check" CHECK ((("role")::"text" = ANY ((ARRAY['viewer'::character varying, 'editor'::character varying, 'admin'::character varying])::"text"[])))
);


ALTER TABLE "public"."project_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "title" "text",
    "description" "text",
    "created_date" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "version" integer DEFAULT 1,
    "data" "jsonb" DEFAULT '{}'::"jsonb",
    "migrated_to_v2" boolean DEFAULT false
);

ALTER TABLE ONLY "public"."projects" REPLICA IDENTITY FULL;


ALTER TABLE "public"."projects" OWNER TO "postgres";


COMMENT ON TABLE "public"."projects" IS '项目表 - REPLICA IDENTITY FULL for Realtime';



CREATE TABLE IF NOT EXISTS "public"."purge_rate_limits" (
    "user_id" "uuid" NOT NULL,
    "call_count" integer DEFAULT 0,
    "window_start" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."purge_rate_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."quarantined_files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "original_file_id" "uuid" NOT NULL,
    "storage_path" "text" NOT NULL,
    "threat_name" character varying(255) NOT NULL,
    "threat_description" "text",
    "quarantined_at" timestamp with time zone DEFAULT "now"(),
    "quarantined_by" "uuid",
    "expires_at" timestamp with time zone,
    "restored" boolean DEFAULT false,
    "restored_at" timestamp with time zone,
    "notes" "text"
);


ALTER TABLE "public"."quarantined_files" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."transcription_usage" (
    "id" "uuid" NOT NULL,
    "user_id" "uuid",
    "date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "audio_seconds" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."transcription_usage" OWNER TO "postgres";


COMMENT ON TABLE "public"."transcription_usage" IS '转写 API 使用量追踪表 - 用于配额控制';



COMMENT ON COLUMN "public"."transcription_usage"."audio_seconds" IS '估算的音频秒数';



CREATE TABLE IF NOT EXISTS "public"."user_preferences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "theme" character varying(20) DEFAULT 'default'::character varying,
    "layout_direction" character varying(10) DEFAULT 'ltr'::character varying,
    "floating_window_pref" character varying(20) DEFAULT 'auto'::character varying,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "user_preferences_floating_window_pref_check" CHECK ((("floating_window_pref" IS NULL) OR (("floating_window_pref")::"text" = ANY ((ARRAY['auto'::character varying, 'fixed'::character varying])::"text"[])))),
    CONSTRAINT "user_preferences_layout_direction_check" CHECK ((("layout_direction" IS NULL) OR (("layout_direction")::"text" = ANY ((ARRAY['ltr'::character varying, 'rtl'::character varying])::"text"[]))))
);

ALTER TABLE ONLY "public"."user_preferences" REPLICA IDENTITY FULL;


ALTER TABLE "public"."user_preferences" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_preferences" IS '用户偏好表 - REPLICA IDENTITY FULL for Realtime';



ALTER TABLE ONLY "public"."app_config"
    ADD CONSTRAINT "app_config_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."attachment_scans"
    ADD CONSTRAINT "attachment_scans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."black_box_entries"
    ADD CONSTRAINT "black_box_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."circuit_breaker_logs"
    ADD CONSTRAINT "circuit_breaker_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cleanup_logs"
    ADD CONSTRAINT "cleanup_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."connection_tombstones"
    ADD CONSTRAINT "connection_tombstones_pkey" PRIMARY KEY ("connection_id");



ALTER TABLE ONLY "public"."connections"
    ADD CONSTRAINT "connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."connections"
    ADD CONSTRAINT "connections_project_id_source_id_target_id_key" UNIQUE ("project_id", "source_id", "target_id");



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_project_id_user_id_key" UNIQUE ("project_id", "user_id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purge_rate_limits"
    ADD CONSTRAINT "purge_rate_limits_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."quarantined_files"
    ADD CONSTRAINT "quarantined_files_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_tombstones"
    ADD CONSTRAINT "task_tombstones_pkey" PRIMARY KEY ("task_id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."transcription_usage"
    ADD CONSTRAINT "transcription_usage_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_user_id_key" UNIQUE ("user_id");



CREATE INDEX "idx_attachment_scans_file_hash" ON "public"."attachment_scans" USING "btree" ("file_hash");



CREATE INDEX "idx_attachment_scans_file_id" ON "public"."attachment_scans" USING "btree" ("file_id");



CREATE INDEX "idx_attachment_scans_scanned_at" ON "public"."attachment_scans" USING "btree" ("scanned_at");



CREATE INDEX "idx_attachment_scans_status" ON "public"."attachment_scans" USING "btree" ("status");



CREATE INDEX "idx_black_box_pending" ON "public"."black_box_entries" USING "btree" ("user_id", "is_read", "is_completed") WHERE (("deleted_at" IS NULL) AND ("is_archived" = false));



CREATE INDEX "idx_black_box_project" ON "public"."black_box_entries" USING "btree" ("project_id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_black_box_updated_at" ON "public"."black_box_entries" USING "btree" ("updated_at");



CREATE INDEX "idx_black_box_user_date" ON "public"."black_box_entries" USING "btree" ("user_id", "date");



CREATE INDEX "idx_circuit_breaker_logs_blocked" ON "public"."circuit_breaker_logs" USING "btree" ("blocked") WHERE ("blocked" = true);



CREATE INDEX "idx_circuit_breaker_logs_created_at" ON "public"."circuit_breaker_logs" USING "btree" ("created_at");



CREATE INDEX "idx_circuit_breaker_logs_user_id" ON "public"."circuit_breaker_logs" USING "btree" ("user_id");



CREATE INDEX "idx_cleanup_logs_created_at" ON "public"."cleanup_logs" USING "btree" ("created_at");



CREATE INDEX "idx_cleanup_logs_type" ON "public"."cleanup_logs" USING "btree" ("type");



CREATE INDEX "idx_connection_tombstones_deleted_at" ON "public"."connection_tombstones" USING "btree" ("deleted_at");



CREATE INDEX "idx_connection_tombstones_project_id" ON "public"."connection_tombstones" USING "btree" ("project_id");



CREATE INDEX "idx_connections_deleted_at" ON "public"."connections" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_connections_deleted_at_cleanup" ON "public"."connections" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE INDEX "idx_connections_project_id" ON "public"."connections" USING "btree" ("project_id");



CREATE INDEX "idx_connections_project_updated" ON "public"."connections" USING "btree" ("project_id", "updated_at" DESC);



CREATE INDEX "idx_connections_source_id" ON "public"."connections" USING "btree" ("source_id");



CREATE INDEX "idx_connections_source_target" ON "public"."connections" USING "btree" ("source_id", "target_id");



CREATE INDEX "idx_connections_target_id" ON "public"."connections" USING "btree" ("target_id");



CREATE INDEX "idx_connections_updated_at" ON "public"."connections" USING "btree" ("updated_at");



CREATE INDEX "idx_project_members_invited_by" ON "public"."project_members" USING "btree" ("invited_by");



CREATE INDEX "idx_project_members_project_id" ON "public"."project_members" USING "btree" ("project_id");



CREATE INDEX "idx_project_members_user_id" ON "public"."project_members" USING "btree" ("user_id");



CREATE INDEX "idx_projects_owner_id" ON "public"."projects" USING "btree" ("owner_id");



CREATE INDEX "idx_projects_owner_id_updated" ON "public"."projects" USING "btree" ("owner_id", "updated_at" DESC);



CREATE INDEX "idx_projects_updated_at" ON "public"."projects" USING "btree" ("updated_at");



CREATE INDEX "idx_quarantined_files_expires_at" ON "public"."quarantined_files" USING "btree" ("expires_at");



CREATE INDEX "idx_task_tombstones_project_id" ON "public"."task_tombstones" USING "btree" ("project_id");



CREATE INDEX "idx_task_tombstones_task_id" ON "public"."task_tombstones" USING "btree" ("task_id");



CREATE INDEX "idx_tasks_deleted_at" ON "public"."tasks" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE INDEX "idx_tasks_id_project_id" ON "public"."tasks" USING "btree" ("id", "project_id");



CREATE INDEX "idx_tasks_parent_id" ON "public"."tasks" USING "btree" ("parent_id");



CREATE INDEX "idx_tasks_project_id" ON "public"."tasks" USING "btree" ("project_id");



CREATE INDEX "idx_tasks_project_updated" ON "public"."tasks" USING "btree" ("project_id", "updated_at" DESC);



CREATE INDEX "idx_tasks_short_id" ON "public"."tasks" USING "btree" ("project_id", "short_id");



CREATE INDEX "idx_tasks_stage" ON "public"."tasks" USING "btree" ("project_id", "stage");



CREATE INDEX "idx_tasks_updated_at" ON "public"."tasks" USING "btree" ("updated_at");



CREATE INDEX "idx_transcription_usage_user_date" ON "public"."transcription_usage" USING "btree" ("user_id", "date");



CREATE INDEX "idx_user_preferences_updated_at" ON "public"."user_preferences" USING "btree" ("updated_at");



CREATE INDEX "idx_user_preferences_user_id" ON "public"."user_preferences" USING "btree" ("user_id");



CREATE OR REPLACE TRIGGER "check_version_increment" BEFORE UPDATE ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "public"."check_version_increment"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."connections" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."user_preferences" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_prevent_connection_resurrection" BEFORE INSERT OR UPDATE ON "public"."connections" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_tombstoned_connection_writes"();



CREATE OR REPLACE TRIGGER "trg_prevent_tombstoned_task_writes" BEFORE INSERT OR UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_tombstoned_task_writes"();



CREATE OR REPLACE TRIGGER "trg_record_connection_tombstone" BEFORE DELETE ON "public"."connections" FOR EACH ROW EXECUTE FUNCTION "public"."record_connection_tombstone"();



CREATE OR REPLACE TRIGGER "trg_update_attachment_scans_timestamp" BEFORE UPDATE ON "public"."attachment_scans" FOR EACH ROW EXECUTE FUNCTION "public"."update_attachment_scans_timestamp"();



CREATE OR REPLACE TRIGGER "trg_validate_task_data" BEFORE INSERT OR UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."validate_task_data"();



CREATE OR REPLACE TRIGGER "update_black_box_entries_updated_at" BEFORE UPDATE ON "public"."black_box_entries" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_connections_updated_at" BEFORE UPDATE ON "public"."connections" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_projects_updated_at" BEFORE UPDATE ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_tasks_updated_at" BEFORE UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_user_preferences_updated_at" BEFORE UPDATE ON "public"."user_preferences" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."black_box_entries"
    ADD CONSTRAINT "black_box_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."black_box_entries"
    ADD CONSTRAINT "black_box_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."connection_tombstones"
    ADD CONSTRAINT "connection_tombstones_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."connection_tombstones"
    ADD CONSTRAINT "connection_tombstones_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."connections"
    ADD CONSTRAINT "connections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."connections"
    ADD CONSTRAINT "connections_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."connections"
    ADD CONSTRAINT "connections_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purge_rate_limits"
    ADD CONSTRAINT "purge_rate_limits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."quarantined_files"
    ADD CONSTRAINT "quarantined_files_quarantined_by_fkey" FOREIGN KEY ("quarantined_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."task_tombstones"
    ADD CONSTRAINT "task_tombstones_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."task_tombstones"
    ADD CONSTRAINT "task_tombstones_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."transcription_usage"
    ADD CONSTRAINT "transcription_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Users can delete own preferences" ON "public"."user_preferences" FOR DELETE USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Users can insert own preferences" ON "public"."user_preferences" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Users can update own preferences" ON "public"."user_preferences" FOR UPDATE USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Users can view own preferences" ON "public"."user_preferences" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."app_config" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "app_config_select" ON "public"."app_config" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."attachment_scans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "attachment_scans_service_only" ON "public"."attachment_scans" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "black_box_delete_policy" ON "public"."black_box_entries" FOR DELETE USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."black_box_entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "black_box_insert_policy" ON "public"."black_box_entries" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "black_box_select_policy" ON "public"."black_box_entries" FOR SELECT USING (((( SELECT "auth"."uid"() AS "uid") = "user_id") OR ("project_id" IN ( SELECT "projects"."id"
   FROM "public"."projects"
  WHERE ("projects"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))
UNION
 SELECT "project_members"."project_id"
   FROM "public"."project_members"
  WHERE ("project_members"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "black_box_update_policy" ON "public"."black_box_entries" FOR UPDATE USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."circuit_breaker_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "circuit_breaker_logs_select_own" ON "public"."circuit_breaker_logs" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."cleanup_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cleanup_logs_service_role_delete" ON "public"."cleanup_logs" FOR DELETE TO "service_role" USING (true);



CREATE POLICY "cleanup_logs_service_role_insert" ON "public"."cleanup_logs" FOR INSERT TO "service_role" WITH CHECK (true);



CREATE POLICY "cleanup_logs_service_role_select" ON "public"."cleanup_logs" FOR SELECT TO "service_role" USING (true);



ALTER TABLE "public"."connection_tombstones" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "connection_tombstones_insert" ON "public"."connection_tombstones" FOR INSERT TO "authenticated" WITH CHECK (("project_id" IN ( SELECT "projects"."id"
   FROM "public"."projects"
  WHERE ("projects"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))
UNION
 SELECT "project_members"."project_id"
   FROM "public"."project_members"
  WHERE ("project_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



COMMENT ON POLICY "connection_tombstones_insert" ON "public"."connection_tombstones" IS 'INSERT 策略 - 使用 initplan 优化的 (select auth.uid())';



CREATE POLICY "connection_tombstones_select" ON "public"."connection_tombstones" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "projects"."id"
   FROM "public"."projects"
  WHERE ("projects"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))
UNION
 SELECT "project_members"."project_id"
   FROM "public"."project_members"
  WHERE ("project_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))));



COMMENT ON POLICY "connection_tombstones_select" ON "public"."connection_tombstones" IS 'SELECT 策略 - 使用 initplan 优化的 (select auth.uid())';



ALTER TABLE "public"."connections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "connections owner delete" ON "public"."connections" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "connections"."project_id") AND ("p"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "connections owner insert" ON "public"."connections" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "connections"."project_id") AND ("p"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "connections owner select" ON "public"."connections" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "connections"."project_id") AND ("p"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "connections owner update" ON "public"."connections" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "connections"."project_id") AND ("p"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "owner delete" ON "public"."projects" FOR DELETE USING ((( SELECT "auth"."uid"() AS "uid") = "owner_id"));



CREATE POLICY "owner insert" ON "public"."projects" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "owner_id"));



CREATE POLICY "owner select" ON "public"."projects" FOR SELECT USING (((( SELECT "auth"."uid"() AS "uid") = "owner_id") OR (EXISTS ( SELECT 1
   FROM "public"."project_members"
  WHERE (("project_members"."project_id" = "projects"."id") AND ("project_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "owner update" ON "public"."projects" FOR UPDATE USING (((( SELECT "auth"."uid"() AS "uid") = "owner_id") OR (EXISTS ( SELECT 1
   FROM "public"."project_members"
  WHERE (("project_members"."project_id" = "projects"."id") AND ("project_members"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (("project_members"."role")::"text" = ANY ((ARRAY['editor'::character varying, 'admin'::character varying])::"text"[])))))));



ALTER TABLE "public"."project_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_members delete" ON "public"."project_members" FOR DELETE USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR (EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "project_members"."project_id") AND ("p"."owner_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "project_members insert" ON "public"."project_members" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "project_members"."project_id") AND ("p"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "project_members select" ON "public"."project_members" FOR SELECT USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "project_members update" ON "public"."project_members" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "project_members"."project_id") AND ("p"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))))));



ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."purge_rate_limits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "purge_rate_limits_own" ON "public"."purge_rate_limits" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."quarantined_files" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "quarantined_files_service_only" ON "public"."quarantined_files" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."task_tombstones" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "task_tombstones_insert_owner" ON "public"."task_tombstones" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "task_tombstones"."project_id") AND ("p"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "task_tombstones_select_owner" ON "public"."task_tombstones" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "task_tombstones"."project_id") AND ("p"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))))));



ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tasks owner delete" ON "public"."tasks" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "tasks"."project_id") AND ("p"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "tasks owner insert" ON "public"."tasks" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "tasks"."project_id") AND ("p"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "tasks owner select" ON "public"."tasks" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "tasks"."project_id") AND ("p"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "tasks owner update" ON "public"."tasks" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."projects" "p"
  WHERE (("p"."id" = "tasks"."project_id") AND ("p"."owner_id" = ( SELECT "auth"."uid"() AS "uid"))))));



ALTER TABLE "public"."transcription_usage" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "transcription_usage_select_policy" ON "public"."transcription_usage" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."user_preferences" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."connections";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."projects";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."tasks";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."user_preferences";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

























































































































































REVOKE ALL ON FUNCTION "public"."append_task_attachment"("p_task_id" "uuid", "p_attachment" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."append_task_attachment"("p_task_id" "uuid", "p_attachment" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."append_task_attachment"("p_task_id" "uuid", "p_attachment" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."batch_upsert_tasks"("p_tasks" "jsonb"[], "p_project_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."batch_upsert_tasks"("p_tasks" "jsonb"[], "p_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."batch_upsert_tasks"("p_tasks" "jsonb"[], "p_project_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."check_version_increment"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_version_increment"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_version_increment"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_deleted_attachments"("retention_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_deleted_attachments"("retention_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_deleted_attachments"("retention_days" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_expired_scan_records"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_expired_scan_records"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_expired_scan_records"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_old_deleted_connections"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_old_deleted_connections"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_old_deleted_connections"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_old_deleted_tasks"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_old_deleted_tasks"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_old_deleted_tasks"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_old_logs"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_old_logs"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_old_logs"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_dashboard_stats"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_dashboard_stats"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_dashboard_stats"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_server_time"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_server_time"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_server_time"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_server_time"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_connection_tombstoned"("p_connection_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_connection_tombstoned"("p_connection_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_connection_tombstoned"("p_connection_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_task_tombstoned"("p_task_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_task_tombstoned"("p_task_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_task_tombstoned"("p_task_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."migrate_all_projects_to_v2"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."migrate_all_projects_to_v2"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."migrate_all_projects_to_v2"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."migrate_project_data_to_v2"("p_project_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."migrate_project_data_to_v2"("p_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."migrate_project_data_to_v2"("p_project_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_tombstoned_connection_writes"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_tombstoned_connection_writes"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_tombstoned_connection_writes"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_tombstoned_task_writes"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_tombstoned_task_writes"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_tombstoned_task_writes"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_tasks"("p_task_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_tasks"("p_task_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."purge_tasks"("p_task_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_tasks_v2"("p_project_id" "uuid", "p_task_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_tasks_v2"("p_project_id" "uuid", "p_task_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."purge_tasks_v2"("p_project_id" "uuid", "p_task_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_tasks_v3"("p_project_id" "uuid", "p_task_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_tasks_v3"("p_project_id" "uuid", "p_task_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."purge_tasks_v3"("p_project_id" "uuid", "p_task_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."record_connection_tombstone"() TO "anon";
GRANT ALL ON FUNCTION "public"."record_connection_tombstone"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_connection_tombstone"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."remove_task_attachment"("p_task_id" "uuid", "p_attachment_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."remove_task_attachment"("p_task_id" "uuid", "p_attachment_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."remove_task_attachment"("p_task_id" "uuid", "p_attachment_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."safe_delete_tasks"("p_task_ids" "uuid"[], "p_project_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."safe_delete_tasks"("p_task_ids" "uuid"[], "p_project_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."safe_delete_tasks"("p_task_ids" "uuid"[], "p_project_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."trigger_set_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_attachment_scans_timestamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_attachment_scans_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_attachment_scans_timestamp"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_task_data"() TO "anon";
GRANT ALL ON FUNCTION "public"."validate_task_data"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_task_data"() TO "service_role";


















GRANT ALL ON TABLE "public"."connection_tombstones" TO "anon";
GRANT ALL ON TABLE "public"."connection_tombstones" TO "authenticated";
GRANT ALL ON TABLE "public"."connection_tombstones" TO "service_role";



GRANT ALL ON TABLE "public"."connections" TO "anon";
GRANT ALL ON TABLE "public"."connections" TO "authenticated";
GRANT ALL ON TABLE "public"."connections" TO "service_role";



GRANT ALL ON TABLE "public"."active_connections" TO "anon";
GRANT ALL ON TABLE "public"."active_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."active_connections" TO "service_role";



GRANT ALL ON TABLE "public"."task_tombstones" TO "anon";
GRANT ALL ON TABLE "public"."task_tombstones" TO "authenticated";
GRANT ALL ON TABLE "public"."task_tombstones" TO "service_role";



GRANT ALL ON TABLE "public"."tasks" TO "anon";
GRANT ALL ON TABLE "public"."tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."tasks" TO "service_role";



GRANT ALL ON TABLE "public"."active_tasks" TO "anon";
GRANT ALL ON TABLE "public"."active_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."active_tasks" TO "service_role";



GRANT ALL ON TABLE "public"."app_config" TO "anon";
GRANT ALL ON TABLE "public"."app_config" TO "authenticated";
GRANT ALL ON TABLE "public"."app_config" TO "service_role";



GRANT ALL ON TABLE "public"."attachment_scans" TO "anon";
GRANT ALL ON TABLE "public"."attachment_scans" TO "service_role";



GRANT ALL ON TABLE "public"."black_box_entries" TO "anon";
GRANT ALL ON TABLE "public"."black_box_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."black_box_entries" TO "service_role";



GRANT ALL ON TABLE "public"."circuit_breaker_logs" TO "anon";
GRANT ALL ON TABLE "public"."circuit_breaker_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."circuit_breaker_logs" TO "service_role";



GRANT ALL ON TABLE "public"."cleanup_logs" TO "anon";
GRANT ALL ON TABLE "public"."cleanup_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."cleanup_logs" TO "service_role";



GRANT ALL ON TABLE "public"."project_members" TO "anon";
GRANT ALL ON TABLE "public"."project_members" TO "authenticated";
GRANT ALL ON TABLE "public"."project_members" TO "service_role";



GRANT ALL ON TABLE "public"."projects" TO "anon";
GRANT ALL ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



GRANT ALL ON TABLE "public"."purge_rate_limits" TO "anon";
GRANT ALL ON TABLE "public"."purge_rate_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."purge_rate_limits" TO "service_role";



GRANT ALL ON TABLE "public"."quarantined_files" TO "anon";
GRANT ALL ON TABLE "public"."quarantined_files" TO "service_role";



GRANT ALL ON TABLE "public"."transcription_usage" TO "anon";
GRANT ALL ON TABLE "public"."transcription_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."transcription_usage" TO "service_role";



GRANT ALL ON TABLE "public"."user_preferences" TO "anon";
GRANT ALL ON TABLE "public"."user_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."user_preferences" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop extension if exists "pg_net";

drop policy "owner update" on "public"."projects";

revoke delete on table "public"."attachment_scans" from "authenticated";

revoke insert on table "public"."attachment_scans" from "authenticated";

revoke references on table "public"."attachment_scans" from "authenticated";

revoke select on table "public"."attachment_scans" from "authenticated";

revoke trigger on table "public"."attachment_scans" from "authenticated";

revoke truncate on table "public"."attachment_scans" from "authenticated";

revoke update on table "public"."attachment_scans" from "authenticated";

revoke delete on table "public"."quarantined_files" from "authenticated";

revoke insert on table "public"."quarantined_files" from "authenticated";

revoke references on table "public"."quarantined_files" from "authenticated";

revoke select on table "public"."quarantined_files" from "authenticated";

revoke trigger on table "public"."quarantined_files" from "authenticated";

revoke truncate on table "public"."quarantined_files" from "authenticated";

revoke update on table "public"."quarantined_files" from "authenticated";

alter table "public"."attachment_scans" drop constraint "valid_status";

alter table "public"."project_members" drop constraint "project_members_role_check";

alter table "public"."tasks" drop constraint "tasks_priority_check";

alter table "public"."tasks" drop constraint "tasks_status_check";

alter table "public"."user_preferences" drop constraint "user_preferences_floating_window_pref_check";

alter table "public"."user_preferences" drop constraint "user_preferences_layout_direction_check";

alter table "public"."attachment_scans" add constraint "valid_status" CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'scanning'::character varying, 'clean'::character varying, 'threat_detected'::character varying, 'failed'::character varying, 'quarantined'::character varying, 'skipped'::character varying])::text[]))) not valid;

alter table "public"."attachment_scans" validate constraint "valid_status";

alter table "public"."project_members" add constraint "project_members_role_check" CHECK (((role)::text = ANY ((ARRAY['viewer'::character varying, 'editor'::character varying, 'admin'::character varying])::text[]))) not valid;

alter table "public"."project_members" validate constraint "project_members_role_check";

alter table "public"."tasks" add constraint "tasks_priority_check" CHECK (((priority IS NULL) OR ((priority)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'urgent'::character varying])::text[])))) not valid;

alter table "public"."tasks" validate constraint "tasks_priority_check";

alter table "public"."tasks" add constraint "tasks_status_check" CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'completed'::character varying, 'archived'::character varying])::text[]))) not valid;

alter table "public"."tasks" validate constraint "tasks_status_check";

alter table "public"."user_preferences" add constraint "user_preferences_floating_window_pref_check" CHECK (((floating_window_pref IS NULL) OR ((floating_window_pref)::text = ANY ((ARRAY['auto'::character varying, 'fixed'::character varying])::text[])))) not valid;

alter table "public"."user_preferences" validate constraint "user_preferences_floating_window_pref_check";

alter table "public"."user_preferences" add constraint "user_preferences_layout_direction_check" CHECK (((layout_direction IS NULL) OR ((layout_direction)::text = ANY ((ARRAY['ltr'::character varying, 'rtl'::character varying])::text[])))) not valid;

alter table "public"."user_preferences" validate constraint "user_preferences_layout_direction_check";


  create policy "owner update"
  on "public"."projects"
  as permissive
  for update
  to public
using (((( SELECT auth.uid() AS uid) = owner_id) OR (EXISTS ( SELECT 1
   FROM public.project_members
  WHERE ((project_members.project_id = projects.id) AND (project_members.user_id = ( SELECT auth.uid() AS uid)) AND ((project_members.role)::text = ANY ((ARRAY['editor'::character varying, 'admin'::character varying])::text[])))))));



  create policy "Project members can view attachments"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
using (((bucket_id = 'attachments'::text) AND (EXISTS ( SELECT 1
   FROM public.project_members pm
  WHERE ((pm.user_id = auth.uid()) AND ((pm.project_id)::text = (storage.foldername(objects.name))[2]))))));



  create policy "Users can delete own attachments"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'attachments'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "Users can update own attachments"
  on "storage"."objects"
  as permissive
  for update
  to authenticated
using (((bucket_id = 'attachments'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)))
with check (((bucket_id = 'attachments'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "Users can upload own attachments"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check (((bucket_id = 'attachments'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



  create policy "Users can view own attachments"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
using (((bucket_id = 'attachments'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



