-- ============================================
-- Migration: 添加 user_preferences 缺失列
-- 日期: 2026-02-17
-- 描述: 支持跨设备同步 colorMode、autoResolveConflicts、localBackup、focusPreferences
-- ============================================

-- 1. 颜色模式（明暗主题）
ALTER TABLE public.user_preferences 
ADD COLUMN IF NOT EXISTS color_mode VARCHAR(10) DEFAULT 'system'
CHECK (color_mode IS NULL OR color_mode IN ('light', 'dark', 'system'));

-- 2. 自动解决冲突开关
ALTER TABLE public.user_preferences 
ADD COLUMN IF NOT EXISTS auto_resolve_conflicts BOOLEAN DEFAULT true;

-- 3. 本地自动备份开关
ALTER TABLE public.user_preferences 
ADD COLUMN IF NOT EXISTS local_backup_enabled BOOLEAN DEFAULT false;

-- 4. 本地自动备份间隔（毫秒）
ALTER TABLE public.user_preferences 
ADD COLUMN IF NOT EXISTS local_backup_interval_ms INTEGER DEFAULT 3600000;

-- 5. 专注模式偏好（JSONB，支持嵌套结构）
ALTER TABLE public.user_preferences 
ADD COLUMN IF NOT EXISTS focus_preferences JSONB DEFAULT '{"gateEnabled":true,"spotlightEnabled":true,"strataEnabled":true,"blackBoxEnabled":true,"maxSnoozePerDay":3}'::jsonb;
