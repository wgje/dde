export interface AttachmentCleanupJobInput {
  bucket: "attachments";
  objectPath: string;
  ownerId: string;
  projectId: string;
  taskId: string;
}

export interface ClaimTaskAttachmentCleanupRequest {
  taskId: string;
  projectId: string;
  expectedUpdatedAt: string;
  remainingAttachments: unknown[];
  jobs: AttachmentCleanupJobInput[];
}

export interface ClaimedAttachmentCleanupJob {
  bucket: string;
  objectPath: string;
  claimToken: string;
  attemptCount: number;
}

export interface AttachmentCleanupOutboxResult {
  claimedCount: number;
  deletedCount: number;
  errors: string[];
}

interface RpcError {
  message?: string;
}

interface RpcResult {
  data: unknown;
  error: RpcError | null;
}

export interface AttachmentCleanupOutboxClient {
  rpc(functionName: string, args: Record<string, unknown>): Promise<RpcResult>;
  storage: {
    from(bucket: string): {
      remove(paths: string[]): Promise<{
        data?: unknown;
        error: { message?: string } | null;
      }>;
    };
  };
}

export async function claimTaskAttachmentCleanup(
  client: AttachmentCleanupOutboxClient,
  request: ClaimTaskAttachmentCleanupRequest,
): Promise<{ claimed: boolean; error?: string }> {
  const { data, error } = await client.rpc("claim_task_attachment_cleanup", {
    p_task_id: request.taskId,
    p_project_id: request.projectId,
    p_expected_updated_at: request.expectedUpdatedAt,
    p_remaining_attachments: request.remainingAttachments,
    p_jobs: request.jobs.map((job) => ({
      bucket: job.bucket,
      object_path: job.objectPath,
      owner_id: job.ownerId,
      project_id: job.projectId,
      task_id: job.taskId,
    })),
  });

  if (error) {
    return {
      claimed: false,
      error: error.message ?? "task cleanup claim failed",
    };
  }

  return { claimed: data === true };
}

export async function drainAttachmentCleanupOutbox(
  client: AttachmentCleanupOutboxClient,
  maxJobs: number,
): Promise<AttachmentCleanupOutboxResult> {
  const claimResult = await client.rpc("claim_attachment_cleanup_jobs", {
    p_limit: normalizeJobLimit(maxJobs),
    p_lease_seconds: 300,
  });

  if (claimResult.error) {
    return {
      claimedCount: 0,
      deletedCount: 0,
      errors: [
        claimResult.error.message ?? "attachment cleanup job claim failed",
      ],
    };
  }

  let jobs: ClaimedAttachmentCleanupJob[];
  try {
    jobs = parseClaimedJobs(claimResult.data);
  } catch (error) {
    return {
      claimedCount: 0,
      deletedCount: 0,
      errors: [
        error instanceof Error
          ? error.message
          : "invalid attachment cleanup job payload",
      ],
    };
  }

  const errors: string[] = [];
  let deletedCount = 0;
  for (const job of jobs) {
    const deleteError = await deleteStorageObject(client, job);
    if (deleteError) {
      errors.push(deleteError);
      const retryError = await releaseFailedJob(client, job, deleteError);
      if (retryError) errors.push(retryError);
      continue;
    }

    const completionError = await completeJob(client, job);
    if (completionError) {
      errors.push(completionError);
      continue;
    }
    deletedCount++;
  }

  return { claimedCount: jobs.length, deletedCount, errors };
}

async function deleteStorageObject(
  client: AttachmentCleanupOutboxClient,
  job: ClaimedAttachmentCleanupJob,
): Promise<string | null> {
  try {
    const { error } = await client.storage.from(job.bucket).remove([
      job.objectPath,
    ]);
    return error
      ? `${job.objectPath}: ${error.message ?? "storage delete failed"}`
      : null;
  } catch (error) {
    return `${job.objectPath}: ${
      error instanceof Error ? error.message : "storage delete failed"
    }`;
  }
}

async function completeJob(
  client: AttachmentCleanupOutboxClient,
  job: ClaimedAttachmentCleanupJob,
): Promise<string | null> {
  const { data, error } = await client.rpc("complete_attachment_cleanup_job", {
    p_bucket: job.bucket,
    p_object_path: job.objectPath,
    p_claim_token: job.claimToken,
  });
  if (error || data !== true) {
    return `${job.objectPath}: ${
      error?.message ?? "cleanup completion claim was lost"
    }`;
  }
  return null;
}

async function releaseFailedJob(
  client: AttachmentCleanupOutboxClient,
  job: ClaimedAttachmentCleanupJob,
  deleteError: string,
): Promise<string | null> {
  const { data, error } = await client.rpc("fail_attachment_cleanup_job", {
    p_bucket: job.bucket,
    p_object_path: job.objectPath,
    p_claim_token: job.claimToken,
    p_error: deleteError,
  });
  if (error || data !== true) {
    return `${job.objectPath}: ${
      error?.message ?? "failed to persist cleanup retry"
    }`;
  }
  return null;
}

function parseClaimedJobs(data: unknown): ClaimedAttachmentCleanupJob[] {
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data)) {
    throw new Error("attachment cleanup claim returned a non-array payload");
  }

  return data.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("attachment cleanup claim returned an invalid row");
    }
    const row = candidate as Record<string, unknown>;
    if (
      typeof row["bucket"] !== "string" ||
      typeof row["object_path"] !== "string" ||
      typeof row["claim_token"] !== "string" ||
      typeof row["attempt_count"] !== "number" ||
      !Number.isInteger(row["attempt_count"])
    ) {
      throw new Error("attachment cleanup claim returned an invalid row");
    }
    return {
      bucket: row["bucket"],
      objectPath: row["object_path"],
      claimToken: row["claim_token"],
      attemptCount: row["attempt_count"],
    };
  });
}

function normalizeJobLimit(maxJobs: number): number {
  if (!Number.isFinite(maxJobs)) return 100;
  return Math.min(500, Math.max(1, Math.floor(maxJobs)));
}
