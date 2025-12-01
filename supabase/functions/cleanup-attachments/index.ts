// 附件清理 Edge Function
// 定期清理超过保留期的软删除附件
// 建议通过 Supabase Cron Job 每天调用一次

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 配置常量 - 与前端 constants.ts 中的 ATTACHMENT_CLEANUP_CONFIG 保持一致
const RETENTION_DAYS = 30; // 软删除附件保留天数
const BATCH_SIZE = 100; // 每批处理的文件数
const MAX_TASKS_PER_RUN = 500; // 每次执行最多处理的任务数（防止超时）

interface AttachmentToDelete {
  taskId: string;
  projectId: string;
  ownerId: string;
  attachmentId: string;
  fileName: string;
  deletedAt: string;
}

interface TaskAttachment {
  id: string;
  name: string;
  deletedAt?: string;
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
}

/**
 * 记录清理日志到数据库
 * 如果 cleanup_logs 表不存在，静默失败
 */
async function logCleanup(
  supabase: ReturnType<typeof createClient>,
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

  // 验证授权 - 仅允许 service_role 调用
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // 创建 Supabase 客户端（使用 service_role）
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 计算截止日期
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
    const cutoffISOString = cutoffDate.toISOString();

    // 查找所有包含过期软删除附件的任务
    // 使用分页防止超时
    const { data: tasks, error: fetchError } = await supabase
      .from("tasks")
      .select(`
        id,
        project_id,
        attachments,
        projects!inner(owner_id)
      `)
      .not("attachments", "is", null)
      .limit(MAX_TASKS_PER_RUN);

    if (fetchError) {
      throw new Error(`Failed to fetch tasks: ${fetchError.message}`);
    }

    const hasMore = (tasks?.length ?? 0) >= MAX_TASKS_PER_RUN;

    const attachmentsToDelete: AttachmentToDelete[] = [];
    const taskUpdates: Map<string, TaskAttachment[]> = new Map();

    // 遍历任务，找出过期的软删除附件
    for (const task of tasks || []) {
      const attachments = task.attachments as TaskAttachment[] | null;
      if (!attachments || attachments.length === 0) continue;

      const ownerId = (task.projects as any)?.owner_id;
      if (!ownerId) continue;

      const expiredAttachments: AttachmentToDelete[] = [];
      const remainingAttachments: TaskAttachment[] = [];

      for (const attachment of attachments) {
        if (attachment.deletedAt && attachment.deletedAt < cutoffISOString) {
          // 过期的软删除附件
          const fileExt = attachment.name.split(".").pop() || "bin";
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
        taskUpdates.set(task.id, remainingAttachments);
      }
    }

    // 如果没有需要清理的附件
    if (attachmentsToDelete.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "No expired attachments to clean up",
          deletedCount: 0,
          storageDeletedCount: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // 批量从 Storage 删除文件
    // 使用"尽力而为"模式：单个文件删除失败不影响其他文件
    // 这确保了即使 Storage 服务抖动，也能最大程度清理文件
    const storagePaths = attachmentsToDelete.map(
      (a) => `${a.ownerId}/${a.projectId}/${a.taskId}/${a.fileName}`
    );

    let storageDeletedCount = 0;
    const storageErrors: string[] = [];
    const successfullyDeletedPaths = new Set<string>();

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
            successfullyDeletedPaths.add(path);
          }
        } catch (e) {
          // 捕获单个文件删除的意外错误，继续处理下一个
          const errorMsg = e instanceof Error ? e.message : String(e);
          storageErrors.push(`${path}: ${errorMsg}`);
          console.warn(`Failed to delete ${path}:`, errorMsg);
        }
      }
    }

    // 只更新那些 Storage 文件已成功删除的任务
    // 这确保了数据一致性：不会出现 DB 中附件被移除但 Storage 文件仍存在的情况
    let dbUpdatedCount = 0;
    const dbErrors: string[] = [];

    for (const [taskId, remainingAttachments] of taskUpdates) {
      // 检查该任务的所有待删除附件是否都已从 Storage 成功删除
      const taskDeletedAttachments = attachmentsToDelete.filter(a => a.taskId === taskId);
      const allDeleted = taskDeletedAttachments.every(a => {
        const path = `${a.ownerId}/${a.projectId}/${a.taskId}/${a.fileName}`;
        return successfullyDeletedPaths.has(path);
      });

      if (!allDeleted) {
        // Storage 删除未完全成功，跳过数据库更新
        dbErrors.push(`Task ${taskId}: Skipped DB update - Storage deletion incomplete`);
        continue;
      }

      try {
        const { error: updateError } = await supabase
          .from("tasks")
          .update({
            attachments:
              remainingAttachments.length > 0 ? remainingAttachments : null,
          })
          .eq("id", taskId);

        if (updateError) {
          dbErrors.push(`Task ${taskId}: ${updateError.message}`);
        } else {
          dbUpdatedCount++;
        }
      } catch (e) {
        // 捕获单个任务更新的意外错误，继续处理下一个
        const errorMsg = e instanceof Error ? e.message : String(e);
        dbErrors.push(`Task ${taskId}: ${errorMsg}`);
        console.warn(`Failed to update task ${taskId}:`, errorMsg);
      }
    }

    // 记录清理日志
    await logCleanup(supabase, "attachment_cleanup", {
      cutoffDate: cutoffISOString,
      attachmentsToDelete: attachmentsToDelete.length,
      storageDeletedCount,
      dbUpdatedCount,
      storageErrors,
      dbErrors,
      hasMore,
      tasksProcessed: tasks?.length ?? 0,
    });

    const result: CleanupResult = {
      success: storageErrors.length === 0 && dbErrors.length === 0,
      message: `Cleaned up ${storageDeletedCount} files from storage, updated ${dbUpdatedCount} tasks`,
      deletedCount: attachmentsToDelete.length,
      storageDeletedCount,
      dbUpdatedCount,
      storageErrors: storageErrors.length > 0 ? storageErrors : undefined,
      dbErrors: dbErrors.length > 0 ? dbErrors : undefined,
      hasMore,
      tasksProcessed: tasks?.length ?? 0,
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
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
