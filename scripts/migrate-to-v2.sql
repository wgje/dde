-- NanoFlow 数据迁移脚本：从 JSONB 到独立表
-- 
-- 此脚本将现有数据从 projects.data JSONB 列迁移到独立的 tasks 和 connections 表
-- 
-- 使用方法：
-- 1. 确保已运行最新的 supabase-setup.sql 创建新表结构
-- 2. 在 Supabase SQL 编辑器中运行此迁移脚本
-- 3. 验证迁移结果
-- 4. 更新前端代码使用新的 API
--
-- 注意：此脚本是幂等的，可以安全地多次运行

-- ============================================
-- 1. 迁移函数
-- ============================================

CREATE OR REPLACE FUNCTION migrate_project_data_to_v2(p_project_id UUID)
RETURNS TABLE (
  tasks_migrated INTEGER,
  connections_migrated INTEGER,
  errors TEXT[]
) AS $$
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
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 2. 批量迁移所有项目
-- ============================================

CREATE OR REPLACE FUNCTION migrate_all_projects_to_v2()
RETURNS TABLE (
  project_id UUID,
  project_title TEXT,
  tasks_migrated INTEGER,
  connections_migrated INTEGER,
  errors TEXT[]
) AS $$
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
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 3. 执行迁移
-- ============================================

-- 运行批量迁移
SELECT * FROM migrate_all_projects_to_v2();

-- ============================================
-- 4. 验证迁移结果
-- ============================================

-- 检查迁移统计
SELECT 
  'Projects' as table_name,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE migrated_to_v2 = TRUE) as migrated
FROM public.projects

UNION ALL

SELECT 
  'Tasks' as table_name,
  COUNT(*) as total,
  NULL as migrated
FROM public.tasks

UNION ALL

SELECT 
  'Connections' as table_name,
  COUNT(*) as total,
  NULL as migrated
FROM public.connections;

-- 检查是否有孤儿任务（parent_id 指向不存在的任务）
SELECT t.id, t.title, t.parent_id
FROM public.tasks t
WHERE t.parent_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM public.tasks p 
  WHERE p.id = t.parent_id AND p.project_id = t.project_id
);

-- 检查是否有无效连接
SELECT c.*
FROM public.connections c
WHERE NOT EXISTS (SELECT 1 FROM public.tasks WHERE id = c.source_id)
   OR NOT EXISTS (SELECT 1 FROM public.tasks WHERE id = c.target_id);

-- ============================================
-- 5. 清理函数（可选，迁移完成后运行）
-- ============================================

-- 删除迁移函数
-- DROP FUNCTION IF EXISTS migrate_project_data_to_v2(UUID);
-- DROP FUNCTION IF EXISTS migrate_all_projects_to_v2();

-- 删除旧的 data 列（谨慎操作！确保迁移成功后再执行）
-- ALTER TABLE public.projects DROP COLUMN data;
-- ALTER TABLE public.projects DROP COLUMN migrated_to_v2;

-- ============================================
-- 完成！
-- ============================================
-- 迁移完成后：
-- 1. 检查上面的验证查询结果
-- 2. 确保没有孤儿任务和无效连接
-- 3. 更新前端代码使用新的 tasks/connections 表
-- 4. 测试所有功能正常
-- 5. 可选：清理旧的 data 列
