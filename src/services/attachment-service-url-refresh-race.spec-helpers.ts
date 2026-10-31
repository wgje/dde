import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../models';
import type { AttachmentService } from './attachment.service';

type RefreshedUrl = { url: string; thumbnailUrl?: string };
type UrlRefreshCallback = (urls: Map<string, RefreshedUrl & { signedAt?: string }>) => void;

interface MonitoredAttachmentEntry {
  userId: string;
  projectId: string;
  taskId: string;
  attachment: Attachment;
}

interface AttachmentUrlRefreshInternals {
  supabase: { isConfigured: boolean };
  monitoredAttachments: Map<string, MonitoredAttachmentEntry>;
  checkAndRefreshExpiredUrls: () => Promise<void>;
}

export interface AttachmentServiceUrlRefreshRaceSpecContext {
  service: () => AttachmentService;
  destroy: () => void;
  loggerWarn: ReturnType<typeof vi.fn>;
}

function createExpiredAttachment(id: string, url = `https://old.example/${id}`): Attachment {
  return {
    id,
    type: 'file',
    name: `${id}.txt`,
    url,
    createdAt: '2020-01-01T00:00:00.000Z',
    signedAt: '2020-01-01T00:00:00.000Z',
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => { resolve = resolver; });
  return { promise, resolve };
}

function getInternals(context: AttachmentServiceUrlRefreshRaceSpecContext): AttachmentUrlRefreshInternals {
  const internals = context.service() as unknown as AttachmentUrlRefreshInternals;
  internals.supabase.isConfigured = true;
  return internals;
}

function registerSingleFlightSpec(context: AttachmentServiceUrlRefreshRaceSpecContext): void {
  it('同一 owner generation 的并发刷新周期只执行一次 refreshUrl', async () => {
    const internals = getInternals(context);
    const deferred = createDeferred<RefreshedUrl | null>();
    const refreshUrl = vi.spyOn(context.service(), 'refreshUrl').mockReturnValue(deferred.promise);
    context.service().monitorAttachment('owner-a', 'project-a', 'task-a', createExpiredAttachment('attachment-a'));

    const firstCycle = internals.checkAndRefreshExpiredUrls();
    const secondCycle = internals.checkAndRefreshExpiredUrls();
    const callCountBeforeCompletion = refreshUrl.mock.calls.length;
    deferred.resolve({ url: 'https://new.example/attachment-a' });
    await Promise.all([firstCycle, secondCycle]);

    expect(callCountBeforeCompletion).toBe(1);
    expect(refreshUrl).toHaveBeenCalledTimes(1);
  });
}

function registerOwnerTransitionSpec(context: AttachmentServiceUrlRefreshRaceSpecContext): void {
  it('A 刷新未完成时 B owner 启动独立周期且 A 迟到结果无副作用', async () => {
    const internals = getInternals(context);
    const ownerAResult = createDeferred<RefreshedUrl | null>();
    const refreshUrl = vi.spyOn(context.service(), 'refreshUrl').mockImplementation(userId => (
      userId === 'owner-a'
        ? ownerAResult.promise
        : Promise.resolve({ url: 'https://new.example/owner-b' })
    ));
    const ownerACallback = vi.fn<UrlRefreshCallback>();
    const ownerBCallback = vi.fn<UrlRefreshCallback>();
    context.service().setUrlRefreshCallback(ownerACallback);
    context.service().monitorAttachment('owner-a', 'project-a', 'task-a', createExpiredAttachment('shared'));
    const ownerACycle = internals.checkAndRefreshExpiredUrls();

    context.service().setUrlRefreshCallback(ownerBCallback);
    context.service().monitorAttachment('owner-b', 'project-b', 'task-b', createExpiredAttachment('shared'));
    const ownerBCycle = internals.checkAndRefreshExpiredUrls();
    await ownerBCycle;
    ownerAResult.resolve({ url: 'https://late.example/owner-a' });
    await ownerACycle;

    expect(refreshUrl.mock.calls.map(call => call[0])).toEqual(['owner-a', 'owner-b']);
    expect(ownerACallback).not.toHaveBeenCalled();
    expect(ownerBCallback).toHaveBeenCalledTimes(1);
    expect(ownerBCallback.mock.calls[0]?.[0].get('shared')?.url).toBe('https://new.example/owner-b');
    expect(internals.monitoredAttachments.get('shared')?.userId).toBe('owner-b');
  });
}

function registerAttachmentIdentitySpec(context: AttachmentServiceUrlRefreshRaceSpecContext): void {
  it('同 owner 同 attachmentId 的旧结果不得覆盖重新监控的新记录', async () => {
    const internals = getInternals(context);
    const oldResult = createDeferred<RefreshedUrl | null>();
    vi.spyOn(context.service(), 'refreshUrl').mockReturnValue(oldResult.promise);
    const callback = vi.fn<UrlRefreshCallback>();
    context.service().setUrlRefreshCallback(callback);
    context.service().monitorAttachment('owner-a', 'project-a', 'task-a', createExpiredAttachment('shared', 'old'));
    const oldCycle = internals.checkAndRefreshExpiredUrls();

    context.service().monitorAttachment('owner-a', 'project-a', 'task-a', createExpiredAttachment('shared', 'current'));
    oldResult.resolve({ url: 'late-old-result' });
    await oldCycle;

    expect(internals.monitoredAttachments.get('shared')?.attachment.url).toBe('current');
    expect(callback).not.toHaveBeenCalled();
  });
}

function registerClearInvalidationSpec(context: AttachmentServiceUrlRefreshRaceSpecContext): void {
  it('clear 发生在 await 中时旧周期不继续刷新后续记录', async () => {
    const internals = getInternals(context);
    const firstResult = createDeferred<RefreshedUrl | null>();
    const refreshUrl = vi.spyOn(context.service(), 'refreshUrl').mockImplementation((_userId, _projectId, _taskId, attachment) => (
      attachment.id === 'first'
        ? firstResult.promise
        : Promise.resolve({ url: 'https://new.example/second' })
    ));
    const callback = vi.fn<UrlRefreshCallback>();
    context.service().setUrlRefreshCallback(callback);
    context.service().monitorAttachment('owner-a', 'project-a', 'task-a', createExpiredAttachment('first'));
    context.service().monitorAttachment('owner-a', 'project-a', 'task-a', createExpiredAttachment('second'));
    const cycle = internals.checkAndRefreshExpiredUrls();

    context.service().clearMonitoredAttachments();
    firstResult.resolve({ url: 'https://late.example/first' });
    await cycle;

    expect(refreshUrl.mock.calls.map(call => call[3]?.id)).toEqual(['first']);
    expect(internals.monitoredAttachments.size).toBe(0);
    expect(callback).not.toHaveBeenCalled();
  });
}

function registerDestroyInvalidationSpec(context: AttachmentServiceUrlRefreshRaceSpecContext): void {
  it('destroy 后迟到刷新结果不得恢复监控记录或调用回调', async () => {
    const internals = getInternals(context);
    const deferred = createDeferred<RefreshedUrl | null>();
    vi.spyOn(context.service(), 'refreshUrl').mockReturnValue(deferred.promise);
    const callback = vi.fn<UrlRefreshCallback>();
    context.service().setUrlRefreshCallback(callback);
    context.service().monitorAttachment('owner-a', 'project-a', 'task-a', createExpiredAttachment('attachment-a'));
    const cycle = internals.checkAndRefreshExpiredUrls();

    context.destroy();
    deferred.resolve({ url: 'https://late.example/attachment-a' });
    await cycle;

    expect(internals.monitoredAttachments.size).toBe(0);
    expect(callback).not.toHaveBeenCalled();
  });
}

function registerCallbackIsolationSpec(context: AttachmentServiceUrlRefreshRaceSpecContext): void {
  it('URL 刷新回调抛错时隔离异常并记录 warning', async () => {
    const internals = getInternals(context);
    const callbackError = new Error('callback failed');
    vi.spyOn(context.service(), 'refreshUrl').mockResolvedValue({ url: 'https://new.example/attachment-a' });
    context.service().setUrlRefreshCallback(() => { throw callbackError; });
    context.service().monitorAttachment('owner-a', 'project-a', 'task-a', createExpiredAttachment('attachment-a'));

    await expect(internals.checkAndRefreshExpiredUrls()).resolves.toBeUndefined();

    expect(context.loggerWarn).toHaveBeenCalledWith('附件 URL 刷新回调失败', { error: callbackError });
  });
}

export function registerAttachmentServiceUrlRefreshRaceSpecs(
  context: AttachmentServiceUrlRefreshRaceSpecContext,
): void {
  describe('URL refresh owner and generation isolation', () => {
    beforeEach(() => context.loggerWarn.mockClear());
    afterEach(() => context.destroy());
    registerSingleFlightSpec(context);
    registerOwnerTransitionSpec(context);
    registerAttachmentIdentitySpec(context);
    registerClearInvalidationSpec(context);
    registerDestroyInvalidationSpec(context);
    registerCallbackIsolationSpec(context);
  });
}
