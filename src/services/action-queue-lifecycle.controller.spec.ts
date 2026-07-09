import { describe, expect, it, vi } from 'vitest';
import { ActionQueueLifecycleController } from './action-queue-lifecycle.controller';

describe('ActionQueueLifecycleController', () => {
  it('重叠处理循环只在首个 token 开始和最后一个 token 结束时通知', () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const lifecycle = new ActionQueueLifecycleController();
    lifecycle.setCallbacks(onStart, onEnd);

    const first = lifecycle.begin();
    const second = lifecycle.begin();

    expect(onStart).toHaveBeenCalledTimes(1);
    lifecycle.end(first);
    expect(onEnd).not.toHaveBeenCalled();

    lifecycle.end(second);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('未知 token 结束时不触发 end 回调', () => {
    const onEnd = vi.fn();
    const lifecycle = new ActionQueueLifecycleController();
    lifecycle.setCallbacks(vi.fn(), onEnd);

    lifecycle.end(999);

    expect(onEnd).not.toHaveBeenCalled();
  });

  it('releaseAll 仅在存在活动 token 时强制通知结束', () => {
    const onEnd = vi.fn();
    const lifecycle = new ActionQueueLifecycleController();
    lifecycle.setCallbacks(vi.fn(), onEnd);

    expect(lifecycle.releaseAll()).toBe(false);
    lifecycle.begin();
    lifecycle.begin();

    expect(lifecycle.releaseAll()).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(lifecycle.releaseAll()).toBe(false);
  });

  it('转发 settled 汇总并允许清空回调', () => {
    const onSettled = vi.fn();
    const lifecycle = new ActionQueueLifecycleController();
    lifecycle.setCallbacks(vi.fn(), vi.fn(), onSettled);

    lifecycle.notifySettled({
      processed: 1,
      failed: 2,
      movedToDeadLetter: 3,
      remaining: 4,
      remoteSuccessCount: 5,
      resolvedNoOpCount: 6,
    });

    expect(onSettled).toHaveBeenCalledWith({
      processed: 1,
      failed: 2,
      movedToDeadLetter: 3,
      remaining: 4,
      remoteSuccessCount: 5,
      resolvedNoOpCount: 6,
    });

    lifecycle.clearCallbacks();
    lifecycle.notifySettled({
      processed: 7,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 0,
      resolvedNoOpCount: 0,
    });

    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('按处理 token 统计远端成功和本地 no-op action', () => {
    const lifecycle = new ActionQueueLifecycleController();
    const first = lifecycle.begin();
    const second = lifecycle.begin();

    lifecycle.trackAction(first, 'remote-action');
    lifecycle.trackAction(first, 'noop-action');
    lifecycle.trackAction(second, 'other-action');

    expect(lifecycle.markActionSyncedRemotely('remote-action')).toBe(true);
    expect(lifecycle.markActionResolvedWithoutRemote('noop-action')).toBe(true);
    expect(lifecycle.markActionSyncedRemotely('missing-action')).toBe(false);

    expect(lifecycle.getActionOutcomeCounts(first)).toEqual({
      remoteSuccessCount: 1,
      resolvedNoOpCount: 1,
    });
    expect(lifecycle.getActionOutcomeCounts(second)).toEqual({
      remoteSuccessCount: 0,
      resolvedNoOpCount: 0,
    });
  });

  it('结束 action 和清理 token 后不再保留 action tracking 状态', () => {
    const lifecycle = new ActionQueueLifecycleController();
    const token = lifecycle.begin();
    lifecycle.trackAction(token, 'action-1');
    lifecycle.untrackAction('action-1');

    expect(lifecycle.markActionSyncedRemotely('action-1')).toBe(false);

    lifecycle.trackAction(token, 'action-2');
    expect(lifecycle.markActionSyncedRemotely('action-2')).toBe(true);
    lifecycle.clearActionOutcomes(token);

    expect(lifecycle.getActionOutcomeCounts(token)).toEqual({
      remoteSuccessCount: 0,
      resolvedNoOpCount: 0,
    });
    expect(lifecycle.markActionResolvedWithoutRemote('action-2')).toBe(false);
  });

  it('隔离 lifecycle 回调异常，避免处理 token 卡在活动状态', () => {
    const lifecycle = new ActionQueueLifecycleController();
    let token = 0;
    lifecycle.setCallbacks(
      () => {
        throw new Error('start callback failed');
      },
      () => {
        throw new Error('end callback failed');
      },
      () => {
        throw new Error('settled callback failed');
      },
    );

    expect(() => {
      token = lifecycle.begin();
    }).not.toThrow();
    expect(token).toBe(1);

    expect(() => lifecycle.notifySettled({
      processed: 1,
      failed: 0,
      movedToDeadLetter: 0,
      remaining: 0,
      remoteSuccessCount: 0,
      resolvedNoOpCount: 0,
    })).not.toThrow();

    expect(() => lifecycle.end(token)).not.toThrow();
    expect(lifecycle.releaseAll()).toBe(false);
  });
});
