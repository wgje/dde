// 附件清理 Edge Function
// 定期清理超过保留期的软删除附件
// 建议通过 Supabase Cron Job 每天调用一次

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.2";

// 配置常量 - 与前端附件清理策略保持一致
const RETENTION_DAYS = 30; // 软删除附件保留天数
const BATCH_SIZE = 100; // 每批处理的文件数
const MAX_TASKS_PER_RUN = 500; // 每次执行最多处理的任务数（防止超时）
const MAINTENANCE_SECRET = Deno.env.get("CLEANUP_ATTACHMENTS_SECRET")
  ?? Deno.env.get("MAINTENANCE_CRON_SECRET")
  ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SERVICE_ROLE_CLIENT_OPTIONS = {
  auth: { autoRefreshToken: false, persistSession: false },
} as const;

interface AttachmentToDelete {
  taskId: string;
  projectId: string;
  ownerId: string;
  attachmentId: string;
  fileName: string;
  deletedAt: string;
}

interface TaskCleanupState {
  projectId: string;
  updatedAt: string | null;
  remainingAttachments: TaskAttachment[];
}

interface TaskAttachment {
  id: string;
  name: string;
  deletedAt?: string;
}

interface ProjectOwnerRelation {
  owner_id?: unknown;
}

interface CleanupResult {
  success: boolean;
  message: string;
  deletedCount: number;
  storageDeletedCount: number;
  dbUpdatedCount?: number;
  storageErrors?: string[];
  dbErrors?: string[];
  error?: string;
  /** 是否有更多数据需要处理（下次运行） */
  hasMore?: boolean;
  /** 处理的任务数 */
  tasksProcessed?: number;
  /** 下一次扫描从该任务 ID 之后继续 */
  nextCursor?: string | null;
  /** 本次是否已从表尾回绕到表头 */
  scanWrapped?: boolean;
}

interface CleanupLogClient {
  from(table: string): {
    select(columns: string): {
      limit(count: number): Promise<{ error: unknown }>;
    };
    insert(values: Record<string, unknown>): Promise<unknown>;
  };
}

interface CleanupCursorLogRow {
  details?: unknown;
}

interface CleanupCursorClient {
  from(table: "cleanup_logs"): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        order(column: string, options: { ascending: boolean }): {
          limit(count: number): Promise<{
            data: CleanupCursorLogRow[] | null;
            error: { message?: string } | null;
          }>;
        };
      };
    };
  };
}

interface CleanupTaskRow {
  id: string;
  project_id: string;
  updated_at: string | null;
  attachments: unknown;
  projects: unknown;
}

interface CleanupTaskQueryBuilder {
  gt(column: string, value: unknown): CleanupTaskQueryBuilder;
  order(column: string, options: { ascending: boolean }): {
    limit(count: number): Promise<{
      data: CleanupTaskRow[] | null;
      error: { message?: string } | null;
    }>;
  };
}

interface CleanupTaskClient {
  from(table: "tasks"): {
    select(columns: string): {
      not(column: string, operator: string, value: unknown): CleanupTaskQueryBuilder;
    };
  };
}

interface CleanupTaskFetchResult {
  tasks: CleanupTaskRow[];
  hasMore: boolean;
  nextCursor: string | null;
  scanWrapped: boolean;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyMaintenanceBearer(req: Request): Promise<'ok' | 'missing-secret' | 'unauthorized'> {
  if (!MAINTENANCE_SECRET) {
    return 'missing-secret';
  }

  const match = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) {
    return 'unauthorized';
  }

  const [actualHash, expectedHash] = await Promise.all([
    sha256Hex(token),
    sha256Hex(MAINTENANCE_SECRET),
  ]);
  return actualHash === expectedHash ? 'ok' : 'unauthorized';
}

function redactCleanupError(error: string): string {
  return error
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[uuid]')
    .replace(/([A-Za-z0-9_-]+\/){3,}[A-Za-z0-9_.-]+/g, '[storage-path]');
}

function summarizeCleanupErrors(errors: string[]): string[] | undefined {
  if (errors.length === 0) return undefined;
  return errors.slice(0, 10).map(redactCleanupError);
}

function sanitizePathSegment(segment: string): string {
  return segment
    .replace(/\.\.+/g, "")
    .replace(/[\/\\]/g, "")
    .replace(/[<>:"|?*\x00-\x1f]/g, "")
    .trim();
}

function isUuidLike(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isTaskAttachment(value: unknown): value is TaskAttachment {
  return typeof value === "object"
    && value !== null
    && typeof (value as TaskAttachment).id === "string"
    && typeof (value as TaskAttachment).name === "string";
}

function resolveProjectOwnerId(projects: unknown): string | null {
  const relation = Array.isArray(projects) ? projects[0] : projects;
  if (typeof relation !== "object" || relation === null) {
    return null;
  }

  const ownerId = (relation as ProjectOwnerRelation).owner_id;
  return typeof ownerId === "string" ? ownerId : null;
}

async function readAttachmentCleanupCursor(supabase: CleanupCursorClient): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("cleanup_logs")
      .select("details")
      .eq("type", "attachment_cleanup")
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      console.warn("Failed to read attachment cleanup cursor", error.message ?? "unknown");
      return null;
    }

    const details = data?.[0]?.details;
    if (typeof details !== "object" || details === null) return null;
    const nextCursor = (details as Record<string, unknown>)["nextCursor"];
    return isUuidLike(nextCursor) ? nextCursor : null;
  } catch {
    return null;
  }
}

async function fetchCleanupTaskPage(
  supabase: CleanupTaskClient,
  afterTaskId: string | null,
): Promise<{
  tasks: CleanupTaskRow[];
  hasMore: boolean;
}> {
  let query = supabase
    .from("tasks")
    .select(`
        id,
        project_id,
        updated_at,
        attachments,
        projects!inner(owner_id)
      `)
    .not("attachments", "is", null);

  if (afterTaskId) {
    query = query.gt("id", afterTaskId);
  }

  const { data, error } = await query
    .order("id", { ascending: true })
    .limit(MAX_TASKS_PER_RUN);

  if (error) {
    throw new Error(`Failed to fetch tasks: ${error.message ?? "unknown"}`);
  }

  const tasks = data ?? [];
  return {
    tasks,
    hasMore: tasks.length >= MAX_TASKS_PER_RUN,
  };
}

async function fetchCleanupTasks(
  supabase: CleanupTaskClient,
  afterTaskId: string | null,
): Promise<CleanupTaskFetchResult> {
  const page = await fetchCleanupTaskPage(supabase, afterTaskId);
  if (afterTaskId && page.tasks.length === 0) {
    const wrappedPage = await fetchCleanupTaskPage(supabase, null);
    return {
      tasks: wrappedPage.tasks,
      hasMore: wrappedPage.hasMore,
      nextCursor: wrappedPage.tasks.at(-1)?.id ?? null,
      scanWrapped: true,
    };
  }

  return {
    tasks: page.tasks,
    hasMore: page.hasMore,
    nextCursor: page.tasks.at(-1)?.id ?? null,
    scanWrapped: false,
  };
}

/**
 * 记录清理日志到数据库
 * 如果 cleanup_logs 表不存在，静默失败
 */
async function logCleanup(
  supabase: CleanupLogClient,
  type: string,
  details: Record<string, unknown>
): Promise<void> {
  try {
    // 先检查表是否存在
    const { error: checkError } = await supabase
      .from("cleanup_logs")
      .select("id")
      .limit(1);
    
    // 如果表存在，插入日志
    if (!checkError) {
      await supabase.from("cleanup_logs").insert({
        type,
        details,
        created_at: new Date().toISOString(),
      });
    }
  } catch {
    // 静默失败，日志记录不应影响主要清理流程
    console.warn("Failed to log cleanup, cleanup_logs table may not exist");
  }
}

Deno.serve(async (req: Request) => {
  // 验证请求方法
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 验证授权 - 仅允许专用维护 secret 调用，禁止普通用户 JWT 或 service-role key 作为请求凭据。
  const authStatus = await verifyMaintenanceBearer(req);
  if (authStatus === 'missing-secret') {
    return new Response(JSON.stringify({ error: "Maintenance secret is not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (authStatus !== 'ok') {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "Supabase service configuration is not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // 创建 Supabase 客户端（使用 service_role）
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SERVICE_ROLE_CLIENT_OPTIONS);

    // 计算截止日期
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
    const cutoffISOString = cutoffDate.toISOString();

    // 按 id 游标轮转扫描，避免固定 limit 永远卡在前 MAX_TASKS_PER_RUN 个任务。
    const cleanupCursor = await readAttachmentCleanupCursor(supabase as unknown as CleanupCursorClient);
    const taskFetch = await fetchCleanupTasks(supabase as unknown as CleanupTaskClient, cleanupCursor);
    let tasks = taskFetch.tasks;
    const hasMore = taskFetch.hasMore;
    const nextCursor = taskFetch.nextCursor;
    const scanWrapped = taskFetch.scanWrapped;

    const attachmentsToDelete: AttachmentToDelete[] = [];
    const taskUpdates: Map<string, TaskCleanupState> = new Map();

    // 遍历任务，找出过期的软删除附件
    for (const task of tasks || []) {
      const attachments = task.attachments as unknown;
      if (!Array.isArray(attachments) || attachments.length === 0) continue;

      const ownerId = resolveProjectOwnerId(task.projects);
      if (!ownerId) continue;
      if (!isUuidLike(task.id)
        || !isUuidLike(task.project_id)
        || !isUuidLike(ownerId)) {
        console.warn("Skipping attachment cleanup row with invalid identifiers");
        continue;
      }

      const expiredAttachments: AttachmentToDelete[] = [];
      const remainingAttachments: TaskAttachment[] = [];

      for (const rawAttachment of attachments) {
        if (!isTaskAttachment(rawAttachment)) {
          console.warn("Skipping malformed attachment cleanup entry");
          continue;
        }

        const attachment = rawAttachment;
        if (attachment.deletedAt && attachment.deletedAt < cutoffISOString) {
          if (!isUuidLike(attachment.id)) {
            console.warn("Skipping attachment cleanup row with invalid attachment id");
            remainingAttachments.push(attachment);
            continue;
          }

          // 过期的软删除附件
          const fileExt = sanitizePathSegment(attachment.name.split(".").pop() || "bin");
          expiredAttachments.push({
            taskId: task.id,
            projectId: task.project_id,
            ownerId,
            attachmentId: attachment.id,
            fileName: `${attachment.id}.${fileExt}`,
            deletedAt: attachment.deletedAt,
          });
        } else {
          // 保留的附件（未删除或未过期）
          remainingAttachments.push(attachment);
        }
      }

      if (expiredAttachments.length > 0) {
        attachmentsToDelete.push(...expiredAttachments);
        taskUpdates.set(task.id, {
          projectId: task.project_id,
          updatedAt: typeof task.updated_at === 'string' ? task.updated_at : null,
          remainingAttachments,
        });
      }
    }

    // 如果没有需要清理的附件
    if (attachmentsToDelete.length === 0) {
      await logCleanup(supabase as unknown as CleanupLogClient, "attachment_cleanup", {
        cutoffDate: cutoffISOString,
        attachmentsToDelete: 0,
        claimedAttachmentsToDelete: 0,
        storageDeletedCount: 0,
        dbUpdatedCount: 0,
        storageErrorCount: 0,
        dbErrorCount: 0,
        hasMore,
        tasksProcessed: tasks.length,
        nextCursor,
        scanWrapped,
      });

      return new Response(
        JSON.stringify({
          success: true,
          message: "No expired attachments to clean up",
          deletedCount: 0,
          storageDeletedCount: 0,
          hasMore,
          tasksProcessed: tasks.length,
          nextCursor,
          scanWrapped,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // 先通过 updated_at CAS 从 DB 中移除过期附件，再删除 Storage 对象。
    // 如果反过来先删 Storage，用户在清理窗口内恢复附件时会出现“DB 仍引用但文件已丢”的硬损坏。
    // 当前顺序的最坏结果是 Storage 遗留无引用对象，后续可通过维护日志/对象生命周期继续清理。
    let dbUpdatedCount = 0;
    const dbErrors: string[] = [];
    const claimedAttachmentsToDelete: AttachmentToDelete[] = [];

    for (const [taskId, taskState] of taskUpdates) {
      const taskDeletedAttachments = attachmentsToDelete.filter(a => a.taskId === taskId);

      try {
        let updateQuery = supabase
          .from("tasks")
          .update({
            attachments:
              taskState.remainingAttachments.length > 0 ? taskState.remainingAttachments : null,
          })
          .eq("id", taskId)
          .eq("project_id", taskState.projectId);

        if (taskState.updatedAt) {
          updateQuery = updateQuery.eq("updated_at", taskState.updatedAt);
        }

        const { data: updatedRows, error: updateError } = await updateQuery.select("id");

        if (updateError) {
          dbErrors.push(`Task ${taskId}: ${updateError.message}`);
        } else if (!updatedRows || updatedRows.length === 0) {
          dbErrors.push(`Task ${taskId}: Skipped DB update - task changed during cleanup`);
        } else {
          dbUpdatedCount++;
          claimedAttachmentsToDelete.push(...taskDeletedAttachments);
        }
      } catch (e) {
        // 捕获单个任务更新的意外错误，继续处理下一个
        const errorMsg = e instanceof Error ? e.message : String(e);
        dbErrors.push(`Task ${taskId}: ${errorMsg}`);
        console.warn('Failed to update task during attachment cleanup', redactCleanupError(`Task ${taskId}: ${errorMsg}`));
      }
    }

    const storagePaths = claimedAttachmentsToDelete.map(
      (a) => `${a.ownerId}/${a.projectId}/${a.taskId}/${a.fileName}`
    );

    let storageDeletedCount = 0;
    const storageErrors: string[] = [];

    for (let i = 0; i < storagePaths.length; i += BATCH_SIZE) {
      const batch = storagePaths.slice(i, i + BATCH_SIZE);

      // 逐个文件尝试删除，确保单个失败不影响整批
      for (const path of batch) {
        try {
          const { error: storageError } = await supabase.storage
            .from("attachments")
            .remove([path]);

          if (storageError) {
            storageErrors.push(`${path}: ${storageError.message}`);
          } else {
            storageDeletedCount++;
          }
        } catch (e) {
          // 捕获单个文件删除的意外错误，继续处理下一个
          const errorMsg = e instanceof Error ? e.message : String(e);
          storageErrors.push(`${path}: ${errorMsg}`);
          console.warn('Failed to delete expired attachment', redactCleanupError(`${path}: ${errorMsg}`));
        }
      }
    }

    // 记录清理日志
    await logCleanup(supabase as unknown as CleanupLogClient, "attachment_cleanup", {
      cutoffDate: cutoffISOString,
      attachmentsToDelete: attachmentsToDelete.length,
      claimedAttachmentsToDelete: claimedAttachmentsToDelete.length,
      storageDeletedCount,
      dbUpdatedCount,
      storageErrorCount: storageErrors.length,
      dbErrorCount: dbErrors.length,
      storageErrors: summarizeCleanupErrors(storageErrors),
      dbErrors: summarizeCleanupErrors(dbErrors),
      hasMore,
      tasksProcessed: tasks?.length ?? 0,
      nextCursor,
      scanWrapped,
    });

    const result: CleanupResult = {
      success: storageErrors.length === 0 && dbErrors.length === 0,
      message: `Cleaned up ${storageDeletedCount} files from storage, updated ${dbUpdatedCount} tasks`,
      deletedCount: attachmentsToDelete.length,
      storageDeletedCount,
      dbUpdatedCount,
      storageErrors: summarizeCleanupErrors(storageErrors),
      dbErrors: summarizeCleanupErrors(dbErrors),
      hasMore,
      tasksProcessed: tasks?.length ?? 0,
      nextCursor,
      scanWrapped,
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Cleanup error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Cleanup failed",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
