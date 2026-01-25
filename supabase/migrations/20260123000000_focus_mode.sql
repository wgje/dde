-- ============================================
-- 专注模式数据库迁移
-- 创建黑匣子条目表和转写使用量表
-- ============================================

-- ============================================
-- 1. 黑匣子条目表 (black_box_entries)
-- ============================================

CREATE TABLE IF NOT EXISTS black_box_entries (
  -- 主键：由客户端 crypto.randomUUID() 生成
  id UUID PRIMARY KEY,
  
  -- 外键关联
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- 内容
  content TEXT NOT NULL,
  
  -- 时间字段
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- 状态字段
  is_read BOOLEAN DEFAULT FALSE,
  is_completed BOOLEAN DEFAULT FALSE,
  is_archived BOOLEAN DEFAULT FALSE,
  
  -- 跳过/稍后提醒
  snooze_until DATE DEFAULT NULL,
  snooze_count INTEGER DEFAULT 0,
  
  -- 软删除
  deleted_at TIMESTAMPTZ DEFAULT NULL
);

-- 添加表注释
COMMENT ON TABLE black_box_entries IS '黑匣子条目表 - 语音转写记录，用于紧急捕捉想法';
COMMENT ON COLUMN black_box_entries.id IS '由客户端 crypto.randomUUID() 生成';
COMMENT ON COLUMN black_box_entries.content IS '语音转写后的文本内容';
COMMENT ON COLUMN black_box_entries.date IS 'YYYY-MM-DD 格式，用于按日分组';
COMMENT ON COLUMN black_box_entries.is_read IS '是否已读，已读条目不会在大门中出现';
COMMENT ON COLUMN black_box_entries.is_completed IS '是否已完成，计入地质层';
COMMENT ON COLUMN black_box_entries.is_archived IS '是否已归档，不显示在主列表';
COMMENT ON COLUMN black_box_entries.snooze_until IS '跳过至该日期，在此之前不会在大门中出现';
COMMENT ON COLUMN black_box_entries.snooze_count IS '已跳过次数';

-- ============================================
-- 2. 索引
-- ============================================

-- 用户日期索引（按日查询）
CREATE INDEX IF NOT EXISTS idx_black_box_user_date 
  ON black_box_entries(user_id, date);

-- 项目索引（未删除条目）
CREATE INDEX IF NOT EXISTS idx_black_box_project 
  ON black_box_entries(project_id) 
  WHERE deleted_at IS NULL;

-- 待处理条目索引（大门查询优化）
CREATE INDEX IF NOT EXISTS idx_black_box_pending 
  ON black_box_entries(user_id, is_read, is_completed) 
  WHERE deleted_at IS NULL AND is_archived = FALSE;

-- 增量同步索引（与现有架构一致）
CREATE INDEX IF NOT EXISTS idx_black_box_updated_at 
  ON black_box_entries(updated_at);

-- ============================================
-- 3. updated_at 自动更新触发器
-- ============================================

-- 前提：update_updated_at_column() 函数已在 init-supabase.sql 中定义
-- 如果不存在，创建触发器函数
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 创建触发器
DROP TRIGGER IF EXISTS update_black_box_entries_updated_at ON black_box_entries;
CREATE TRIGGER update_black_box_entries_updated_at
  BEFORE UPDATE ON black_box_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 4. RLS 策略
-- ============================================

ALTER TABLE black_box_entries ENABLE ROW LEVEL SECURITY;

-- SELECT：用户只能查看自己的条目，或所属项目的条目
CREATE POLICY "black_box_select_policy" ON black_box_entries 
  FOR SELECT USING (
    auth.uid() = user_id OR
    project_id IN (
      SELECT id FROM projects WHERE owner_id = auth.uid()
      UNION
      SELECT project_id FROM project_members WHERE user_id = auth.uid()
    )
  );

-- INSERT：用户只能创建自己的条目
CREATE POLICY "black_box_insert_policy" ON black_box_entries
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- UPDATE：用户只能更新自己的条目
CREATE POLICY "black_box_update_policy" ON black_box_entries
  FOR UPDATE USING (auth.uid() = user_id);

-- DELETE：用户只能删除自己的条目
CREATE POLICY "black_box_delete_policy" ON black_box_entries
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- 5. 转写使用量表 (transcription_usage)
-- ============================================

CREATE TABLE IF NOT EXISTS transcription_usage (
  -- 主键：由 Edge Function 使用 crypto.randomUUID() 生成
  id UUID PRIMARY KEY,
  
  -- 外键关联
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- 使用量数据
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  audio_seconds INTEGER DEFAULT 0,
  
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 添加表注释
COMMENT ON TABLE transcription_usage IS '转写 API 使用量追踪表 - 用于配额控制';
COMMENT ON COLUMN transcription_usage.audio_seconds IS '估算的音频秒数';

-- 用户日期索引（配额查询）
CREATE INDEX IF NOT EXISTS idx_transcription_usage_user_date 
  ON transcription_usage(user_id, date);

-- ============================================
-- 6. 转写使用量 RLS
-- ============================================

ALTER TABLE transcription_usage ENABLE ROW LEVEL SECURITY;

-- SELECT：用户只能读取自己的使用量（用于前端显示剩余配额）
CREATE POLICY "transcription_usage_select_policy" ON transcription_usage 
  FOR SELECT USING (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE 由 Edge Function 使用 service_role 执行，无需用户策略
-- Edge Function 使用 SUPABASE_SERVICE_ROLE_KEY 可以绕过 RLS

-- ============================================
-- 7. 用户偏好表扩展（如果 user_preferences 表已存在）
-- ============================================

-- 注意：专注模式偏好存储在 user_preferences.data JSONB 中
-- 结构：{ focus: { gateEnabled, spotlightEnabled, blackBoxEnabled, maxSnoozePerDay } }
-- 无需额外 DDL，现有 JSONB 字段足够

-- ============================================
-- 8. 授权说明
-- ============================================

-- Edge Function 需要 service_role 权限来：
-- 1. 查询配额（绕过 RLS）
-- 2. 记录使用量（绕过 RLS）
-- 
-- 普通用户通过 RLS 策略：
-- 1. 只能访问自己的黑匣子条目
-- 2. 只能读取自己的使用量
