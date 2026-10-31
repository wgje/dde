import { describe, expect, it, vi } from 'vitest';

import {
  claimTaskAttachmentCleanup,
  drainAttachmentCleanupOutbox,
  type AttachmentCleanupOutboxClient,
} from '../../../supabase/functions/cleanup-attachments/cleanup-outbox';

type AttachmentCleanupRpc = AttachmentCleanupOutboxClient['rpc'];
type AttachmentCleanupRemove = ReturnType<AttachmentCleanupOutboxClient['storage']['from']>['remove'];

describe('cleanup attachment cloud outbox', () => {
  it('atomically claims task metadata and maps cleanup jobs to RPC payloads', async () => {
    const rpc = vi.fn<AttachmentCleanupRpc>().mockResolvedValue({ data: true, error: null });
    const client = createClient(rpc);

    const result = await claimTaskAttachmentCleanup(client, {
      taskId: 'task-1',
      projectId: 'project-1',
      expectedUpdatedAt: '2026-07-15T00:00:00.000Z',
      remainingAttachments: [],
      jobs: [{
        bucket: 'attachments',
        objectPath: 'owner-1/project-1/task-1/attachment-1.bin',
        ownerId: 'owner-1',
        projectId: 'project-1',
        taskId: 'task-1',
      }],
    });

    expect(result).toEqual({ claimed: true });
    expect(rpc).toHaveBeenCalledWith('claim_task_attachment_cleanup', {
      p_task_id: 'task-1',
      p_project_id: 'project-1',
      p_expected_updated_at: '2026-07-15T00:00:00.000Z',
      p_remaining_attachments: [],
      p_jobs: [{
        bucket: 'attachments',
        object_path: 'owner-1/project-1/task-1/attachment-1.bin',
        owner_id: 'owner-1',
        project_id: 'project-1',
        task_id: 'task-1',
      }],
    });
  });

  it('completes successful deletes and persists failed jobs for retry', async () => {
    const rpc = vi.fn<AttachmentCleanupRpc>(async (name) => {
      if (name === 'claim_attachment_cleanup_jobs') {
        return {
          data: [
            { bucket: 'attachments', object_path: 'owner/a', claim_token: 'token-a', attempt_count: 0 },
            { bucket: 'attachments', object_path: 'owner/b', claim_token: 'token-b', attempt_count: 2 },
          ],
          error: null,
        };
      }
      return { data: true, error: null };
    });
    const remove = vi.fn<AttachmentCleanupRemove>(async (paths) => ({
      data: null,
      error: paths[0] === 'owner/b' ? { message: 'storage unavailable' } : null,
    }));
    const client = createClient(rpc, remove);

    const result = await drainAttachmentCleanupOutbox(client, 50);

    expect(result).toEqual({
      claimedCount: 2,
      deletedCount: 1,
      errors: ['owner/b: storage unavailable'],
    });
    expect(rpc).toHaveBeenCalledWith('complete_attachment_cleanup_job', {
      p_bucket: 'attachments',
      p_object_path: 'owner/a',
      p_claim_token: 'token-a',
    });
    expect(rpc).toHaveBeenCalledWith('fail_attachment_cleanup_job', {
      p_bucket: 'attachments',
      p_object_path: 'owner/b',
      p_claim_token: 'token-b',
      p_error: 'owner/b: storage unavailable',
    });
  });

  it('keeps a successfully deleted job leased when completion acknowledgement fails', async () => {
    const rpc = vi.fn<AttachmentCleanupRpc>(async (name) => {
      if (name === 'claim_attachment_cleanup_jobs') {
        return {
          data: [{
            bucket: 'attachments',
            object_path: 'owner/a',
            claim_token: 'token-a',
            attempt_count: 0,
          }],
          error: null,
        };
      }
      if (name === 'complete_attachment_cleanup_job') {
        return { data: false, error: null };
      }
      return { data: true, error: null };
    });
    const client = createClient(rpc);

    const result = await drainAttachmentCleanupOutbox(client, 10);

    expect(result.deletedCount).toBe(0);
    expect(result.errors).toEqual([
      'owner/a: cleanup completion claim was lost',
    ]);
    expect(rpc).not.toHaveBeenCalledWith(
      'fail_attachment_cleanup_job',
      expect.anything(),
    );
  });
});

function createClient(
  rpc: AttachmentCleanupRpc,
  remove: AttachmentCleanupRemove = vi.fn<AttachmentCleanupRemove>()
    .mockResolvedValue({ data: null, error: null }),
): AttachmentCleanupOutboxClient {
  return {
    rpc,
    storage: {
      from: () => ({ remove }),
    },
  };
}
