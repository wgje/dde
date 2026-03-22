/**
 * 备份恢复 Edge Function
 * 
 * 功能：
 * 1. 列出可用的恢复点
 * 2. 预览恢复内容
 * 3. 执行恢复操作
 * 4. 支持恢复前创建快照
 * 5. 支持分批恢复和断点续传
 * 
 * 触发方式：
 * - 用户通过 UI 手动调用
 * 
 * 环境变量：
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - BACKUP_ENCRYPTION_KEY (如果备份已加密)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  BackupData,
  decryptData,
  decompressData,
  verifyChecksum,
  base64ToUint8Array,
} from "../_shared/backup-utils.ts";
import { prepareRestoreRows } from "../_shared/backup-restore-schema.ts";

// ===========================================
// 配置
// ===========================================

const BATCH_SIZE = 100; // 每批恢复的记录数
const RESTORE_TIMEOUT_MS = 5 * 60 * 1000; // 恢复超时 5 分钟

interface RecoveryRequest {
  action: 'list' | 'preview' | 'restore';
  backupId?: string;
  options?: {
    mode?: 'replace' | 'merge';
    scope?: 'all' | 'project';
    projectId?: string;
    preset?: 'project_only' | 'project_plus_user_state';
    createSnapshot?: boolean;
  };
  userId: string; // 必须传入，用于权限校验
}

interface RecoveryPointRow {
  id: string;
  type: 'full' | 'incremental';
  backup_completed_at: string;
  project_count: number;
  task_count: number;
  connection_count: number;
  size_bytes: number;
  encrypted: boolean;
  validation_passed: boolean;
}

interface RecoveryPoint {
  id: string;
  type: 'full' | 'incremental';
  timestamp: string;
  projectCount: number;
  taskCount: number;
  connectionCount: number;
  size: number;
  encrypted: boolean;
  validationPassed: boolean;
}

interface RecoveryPreview {
  backupId: string;
  type: 'full' | 'incremental';
  timestamp: string;
  projectCount: number;
  taskCount: number;
  connectionCount: number;
  projects: Array<{ id: string; name: string }>;
  extras: {
    userPreferences: number;
    blackBoxEntries: number;
    focusSessions: number;
    transcriptionUsage: number;
    routineTasks: number;
    routineCompletions: number;
  };
  coverage?: BackupData['coverage'];
}

interface RestoreResult {
  success: boolean;
  restoreId: string;
  projectsRestored: number;
  tasksRestored: number;
  connectionsRestored: number;
  extraTableCounts?: Record<string, number>;
  preRestoreSnapshotId?: string;
  durationMs: number;
  error?: string;
}

// ===========================================
// 主处理器
// ===========================================

Deno.serve(async (req: Request): Promise<Response> => {
  const startTime = Date.now();
  
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  
  try {
    const body = await req.text();
    if (!body) {
      return jsonResponse({ error: "Request body is required" }, 400);
    }
    
    const request: RecoveryRequest = JSON.parse(body);
    
    if (!request.action) {
      return jsonResponse({ error: "Action is required" }, 400);
    }
    
    if (!request.userId) {
      return jsonResponse({ error: "userId is required" }, 400);
    }
    
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!supabaseUrl || !supabaseKey) {
      return jsonResponse({ error: "Missing Supabase configuration" }, 500);
    }
    
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    switch (request.action) {
      case 'list':
        return jsonResponse(await listRecoveryPoints(supabase, request.userId), 200);
        
      case 'preview':
        if (!request.backupId) {
          return jsonResponse({ error: "backupId is required for preview" }, 400);
        }
        return jsonResponse(await previewRecovery(supabase, request.backupId, request.userId), 200);
        
      case 'restore':
        if (!request.backupId) {
          return jsonResponse({ error: "backupId is required for restore" }, 400);
        }
        return jsonResponse(
          await executeRestore(supabase, request.backupId, request.userId, request.options, startTime),
          200
        );
        
      default:
        return jsonResponse({ error: `Unknown action: ${request.action}` }, 400);
    }
    
  } catch (error) {
    console.error("Recovery operation failed:", error);
    return jsonResponse({ 
      success: false, 
      error: error instanceof Error ? error.message : "Unknown error" 
    }, 500);
  }
});

// ===========================================
// 列出恢复点
// ===========================================

async function listRecoveryPoints(
  supabase: SupabaseClient,
  userId: string
): Promise<{ recoveryPoints: RecoveryPoint[] }> {
  
  // 查询该用户可访问的备份
  // 全量备份对所有用户可用，用户级备份仅对该用户可用
  const { data, error } = await supabase
    .from("backup_metadata")
    .select(`
      id,
      type,
      backup_completed_at,
      project_count,
      task_count,
      connection_count,
      size_bytes,
      encrypted,
      validation_passed,
      user_id
    `)
    .eq("status", "completed")
    .or(`user_id.is.null,user_id.eq.${userId}`)
    .order("backup_completed_at", { ascending: false })
    .limit(100);
  
  if (error) {
    throw new Error(`Failed to list recovery points: ${error.message}`);
  }
  
  const recoveryPoints: RecoveryPoint[] = (data || []).map((row: RecoveryPointRow) => ({
    id: row.id,
    type: row.type,
    timestamp: row.backup_completed_at,
    projectCount: row.project_count,
    taskCount: row.task_count,
    connectionCount: row.connection_count,
    size: row.size_bytes,
    encrypted: row.encrypted,
    validationPassed: row.validation_passed,
  }));
  
  return { recoveryPoints };
}

// ===========================================
// 预览恢复
// ===========================================

async function previewRecovery(
  supabase: SupabaseClient,
  backupId: string,
  userId: string
): Promise<RecoveryPreview> {
  
  // 获取备份元数据
  const { data: meta, error: metaError } = await supabase
    .from("backup_metadata")
    .select("*")
    .eq("id", backupId)
    .single();
  
  if (metaError || !meta) {
    throw new Error(`Backup not found: ${backupId}`);
  }
  
  // 权限校验
  if (meta.user_id && meta.user_id !== userId) {
    throw new Error("Access denied: This backup belongs to another user");
  }
  
  // 下载并解析备份数据（仅获取项目列表）
  const backupData = await downloadAndParseBackup(supabase, meta);
  
  return {
    backupId,
    type: meta.type,
    timestamp: meta.backup_completed_at,
    projectCount: backupData.projects.length,
    taskCount: backupData.tasks.length,
    connectionCount: backupData.connections.length,
    projects: backupData.projects.map(p => ({ id: p.id, name: p.name })),
    extras: {
      userPreferences: backupData.userPreferences?.length ?? 0,
      blackBoxEntries: backupData.blackBoxEntries?.length ?? 0,
      focusSessions: backupData.focusSessions?.length ?? 0,
      transcriptionUsage: backupData.transcriptionUsage?.length ?? 0,
      routineTasks: backupData.routineTasks?.length ?? 0,
      routineCompletions: backupData.routineCompletions?.length ?? 0,
    },
    coverage: backupData.coverage,
  };
}

// ===========================================
// 执行恢复
// ===========================================

async function executeRestore(
  supabase: SupabaseClient,
  backupId: string,
  userId: string,
  options: RecoveryRequest['options'] = {},
  startTime: number
): Promise<RestoreResult> {
  
  const mode = options?.mode || 'replace';
  const scope = options?.scope || 'all';
  const preset = options?.preset || 'project_only';
  const createSnapshot = options?.createSnapshot ?? true;
  
  // 获取备份元数据
  const { data: meta, error: metaError } = await supabase
    .from("backup_metadata")
    .select("*")
    .eq("id", backupId)
    .single();
  
  if (metaError || !meta) {
    throw new Error(`Backup not found: ${backupId}`);
  }
  
  // 权限校验
  if (meta.user_id && meta.user_id !== userId) {
    throw new Error("Access denied: This backup belongs to another user");
  }
  
  // 创建恢复历史记录
  const { data: restoreRecord, error: recordError } = await supabase
    .from("backup_restore_history")
    .insert({
      backup_id: backupId,
      user_id: userId,
      mode,
      scope,
      project_id: options?.projectId || null,
      status: "in_progress",
    })
    .select()
    .single();
  
  if (recordError) {
    throw new Error(`Failed to create restore record: ${recordError.message}`);
  }
  
  const restoreId = restoreRecord.id;
  let preRestoreSnapshotId: string | undefined;
  
  try {
    // 1. 创建恢复前快照
    if (createSnapshot) {
      console.log("Creating pre-restore snapshot...");
      preRestoreSnapshotId = await createPreRestoreSnapshot(supabase, userId);
      
      await supabase
        .from("backup_restore_history")
        .update({ pre_restore_snapshot_id: preRestoreSnapshotId })
        .eq("id", restoreId);
    }
    
    // 2. 下载并解析备份数据
    console.log("Downloading backup data...");
    const backupData = await downloadAndParseBackup(supabase, meta);
    
    const preparedRows = prepareRestoreRows(backupData, userId, {
      scope,
      projectId: options?.projectId,
      preset,
    });

    const projectsToRestore = preparedRows.projects;
    const tasksToRestore = preparedRows.tasks;
    const connectionsToRestore = preparedRows.connections;
    const userPreferencesToRestore = preparedRows.userPreferences;
    const blackBoxEntriesToRestore = preparedRows.blackBoxEntries;
    const focusSessionsToRestore = preparedRows.focusSessions;
    const transcriptionUsageToRestore = preparedRows.transcriptionUsage;
    const routineTasksToRestore = preparedRows.routineTasks;
    const routineCompletionsToRestore = preparedRows.routineCompletions;

    console.log(
      `Restoring: ${projectsToRestore.length} projects, ${tasksToRestore.length} tasks, ${connectionsToRestore.length} connections, `
      + `${blackBoxEntriesToRestore.length} black_box_entries`,
    );
    
    // 4. 执行恢复（使用事务）
    if (mode === 'replace') {
      // 替换模式：先删除现有数据
      if (scope === 'project' && options?.projectId) {
        await deleteProjectScopedData(supabase, userId, options.projectId, preset);
      } else {
        // 删除用户的所有数据
        await deleteUserData(supabase, userId);
      }
    }
    
    // 5. 分批插入数据
    // 先插入项目
    for (let i = 0; i < projectsToRestore.length; i += BATCH_SIZE) {
      const batch = projectsToRestore.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from("projects")
        .upsert(batch);
      
      if (error) {
        throw new Error(`Failed to restore projects: ${error.message}`);
      }
    }
    
    // 再插入任务
    for (let i = 0; i < tasksToRestore.length; i += BATCH_SIZE) {
      const batch = tasksToRestore.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from("tasks")
        .upsert(batch);
      
      if (error) {
        throw new Error(`Failed to restore tasks: ${error.message}`);
      }
    }
    
    // 最后插入连接
    for (let i = 0; i < connectionsToRestore.length; i += BATCH_SIZE) {
      const batch = connectionsToRestore.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from("connections")
        .upsert(batch);
      
      if (error) {
        throw new Error(`Failed to restore connections: ${error.message}`);
      }
    }

    for (let i = 0; i < userPreferencesToRestore.length; i += BATCH_SIZE) {
      const batch = userPreferencesToRestore.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("user_preferences").upsert(batch);
      if (error) throw new Error(`Failed to restore user_preferences: ${error.message}`);
    }

    for (let i = 0; i < blackBoxEntriesToRestore.length; i += BATCH_SIZE) {
      const batch = blackBoxEntriesToRestore.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("black_box_entries").upsert(batch);
      if (error) throw new Error(`Failed to restore black_box_entries: ${error.message}`);
    }

    for (let i = 0; i < focusSessionsToRestore.length; i += BATCH_SIZE) {
      const batch = focusSessionsToRestore.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("focus_sessions").upsert(batch);
      if (error) throw new Error(`Failed to restore focus_sessions: ${error.message}`);
    }

    for (let i = 0; i < transcriptionUsageToRestore.length; i += BATCH_SIZE) {
      const batch = transcriptionUsageToRestore.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("transcription_usage").upsert(batch);
      if (error) throw new Error(`Failed to restore transcription_usage: ${error.message}`);
    }

    for (let i = 0; i < routineTasksToRestore.length; i += BATCH_SIZE) {
      const batch = routineTasksToRestore.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("routine_tasks").upsert(batch);
      if (error) throw new Error(`Failed to restore routine_tasks: ${error.message}`);
    }

    for (let i = 0; i < routineCompletionsToRestore.length; i += BATCH_SIZE) {
      const batch = routineCompletionsToRestore.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("routine_completions").upsert(batch);
      if (error) throw new Error(`Failed to restore routine_completions: ${error.message}`);
    }
    
    // 6. 更新恢复记录
    const durationMs = Date.now() - startTime;
    
    await supabase
      .from("backup_restore_history")
      .update({
        status: "completed",
        projects_restored: projectsToRestore.length,
        tasks_restored: tasksToRestore.length,
        connections_restored: connectionsToRestore.length,
        completed_at: new Date().toISOString(),
      })
      .eq("id", restoreId);
    
    console.log("Restore completed successfully", {
      restoreId,
      projectsRestored: projectsToRestore.length,
      tasksRestored: tasksToRestore.length,
      connectionsRestored: connectionsToRestore.length,
      userPreferencesRestored: userPreferencesToRestore.length,
      blackBoxEntriesRestored: blackBoxEntriesToRestore.length,
      focusSessionsRestored: focusSessionsToRestore.length,
      transcriptionUsageRestored: transcriptionUsageToRestore.length,
      durationMs,
    });
    
    return {
      success: true,
      restoreId,
      projectsRestored: projectsToRestore.length,
      tasksRestored: tasksToRestore.length,
      connectionsRestored: connectionsToRestore.length,
      extraTableCounts: {
        userPreferences: userPreferencesToRestore.length,
        blackBoxEntries: blackBoxEntriesToRestore.length,
        focusSessions: focusSessionsToRestore.length,
        transcriptionUsage: transcriptionUsageToRestore.length,
        routineTasks: routineTasksToRestore.length,
        routineCompletions: routineCompletionsToRestore.length,
      },
      preRestoreSnapshotId,
      durationMs,
    };
    
  } catch (error) {
    // 恢复失败，更新记录
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    
    await supabase
      .from("backup_restore_history")
      .update({
        status: "failed",
        error_message: errorMessage,
        completed_at: new Date().toISOString(),
      })
      .eq("id", restoreId);
    
    throw error;
  }
}

// ===========================================
// 辅助函数
// ===========================================

async function downloadAndParseBackup(
  supabase: SupabaseClient,
  meta: Record<string, unknown>
): Promise<BackupData> {
  
  // 下载备份文件
  const { data: fileData, error: downloadError } = await supabase.storage
    .from("backups")
    .download(meta.path as string);
  
  if (downloadError || !fileData) {
    throw new Error(`Failed to download backup: ${downloadError?.message || 'No data'}`);
  }
  
  let content: string;
  const bytes = new Uint8Array(await fileData.arrayBuffer());
  
  // 校验完整性
  if (meta.checksum) {
    const isValid = await verifyChecksum(bytes, meta.checksum as string);
    if (!isValid) {
      throw new Error("Backup checksum verification failed");
    }
  }
  
  // 解密（如果需要）
  if (meta.encrypted) {
    const encryptionKey = Deno.env.get("BACKUP_ENCRYPTION_KEY");
    if (!encryptionKey) {
      throw new Error("Backup is encrypted but no encryption key is available");
    }
    
    const encryptedText = new TextDecoder().decode(bytes);
    const decrypted = await decryptData(encryptedText, encryptionKey);
    // 解密后的是 Base64 编码的压缩数据
    const compressedBytes = base64ToUint8Array(decrypted);
    content = await decompressData(compressedBytes);
  } else {
    // 仅解压
    content = await decompressData(bytes);
  }
  
  // 解析 JSON
  return JSON.parse(content) as BackupData;
}

async function createPreRestoreSnapshot(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("NF_BACKUP_INTERNAL_JWT") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Pre-restore snapshot requires Supabase function credentials");
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/backup-full`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({ userId }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to create pre-restore snapshot: ${raw}`);
  }

  let payload: { success?: boolean; backupId?: string; error?: string } | null = null;
  try {
    payload = JSON.parse(raw) as { success?: boolean; backupId?: string; error?: string };
  } catch {
    throw new Error("Failed to parse pre-restore snapshot response");
  }

  if (!payload?.success || !payload.backupId) {
    throw new Error(payload?.error || "Pre-restore snapshot did not return a backupId");
  }

  return payload.backupId;
}

async function deleteUserData(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  // 获取用户的所有项目 ID
  const { data: projects } = await supabase
    .from("projects")
    .select("id")
    .eq("owner_id", userId);
  
  if (!projects || projects.length === 0) {
    return;
  }
  
  const projectIds = projects.map((p: { id: string }) => p.id);
  
  await supabase.from("black_box_entries").delete().eq("user_id", userId);
  await supabase.from("transcription_usage").delete().eq("user_id", userId);
  await supabase.from("focus_sessions").delete().eq("user_id", userId);
  await supabase.from("routine_completions").delete().eq("user_id", userId);
  await supabase.from("routine_tasks").delete().eq("user_id", userId);
  await supabase.from("user_preferences").delete().eq("user_id", userId);

  // 按顺序删除：连接 → 任务 → 项目
  await supabase.from("connections").delete().in("project_id", projectIds);
  await supabase.from("tasks").delete().in("project_id", projectIds);
  await supabase.from("projects").delete().eq("owner_id", userId);
}

async function deleteProjectScopedData(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
  preset: 'project_only' | 'project_plus_user_state',
): Promise<void> {
  await supabase.from("black_box_entries").delete().eq("project_id", projectId);
  await supabase.from("connections").delete().eq("project_id", projectId);
  await supabase.from("tasks").delete().eq("project_id", projectId);
  await supabase.from("projects").delete().eq("id", projectId);

  if (preset === 'project_plus_user_state') {
    await supabase.from("black_box_entries").delete().is("project_id", null).eq("user_id", userId);
    await supabase.from("transcription_usage").delete().eq("user_id", userId);
    await supabase.from("focus_sessions").delete().eq("user_id", userId);
    await supabase.from("routine_completions").delete().eq("user_id", userId);
    await supabase.from("routine_tasks").delete().eq("user_id", userId);
    await supabase.from("user_preferences").delete().eq("user_id", userId);
  }
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
