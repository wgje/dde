import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';
import { supabaseErrorToError } from '../utils/supabase-error';
import type { CategoryLogger } from './logger.service';

export interface BlackBoxPullErrorHandlingDeps {
  isBlackBoxScopedQueryUnavailable: (error: unknown) => boolean;
  isSessionExpiredError: (error: ReturnType<typeof supabaseErrorToError>) => boolean;
  loadFromLocal: () => Promise<unknown>;
  logger: Pick<CategoryLogger, 'debug' | 'error' | 'warn'>;
}

export async function handleBlackBoxPullErrorWithLocalFallback(
  error: unknown,
  deps: BlackBoxPullErrorHandlingDeps,
): Promise<boolean> {
  if (deps.isBlackBoxScopedQueryUnavailable(error)) {
    deps.logger.warn('BlackBox 远端拉取缺少用户作用域查询能力，保留本地快照并等待下次重试');
    await deps.loadFromLocal();
    return false;
  }

  const finalErr = supabaseErrorToError(error);
  if (isBrowserNetworkSuspendedError(finalErr) || isBrowserNetworkSuspendedWindow()) {
    deps.logger.debug('BlackBox 浏览器网络挂起，跳过增量拉取', { message: finalErr.message });
    await deps.loadFromLocal();
    return false;
  }

  if (deps.isSessionExpiredError(finalErr)) {
    deps.logger.warn('BlackBox 会话失效，已保留本地快照并等待重新认证', {
      code: finalErr.code,
      message: finalErr.message,
    });
    await deps.loadFromLocal();
    return true;
  }

  deps.logger.error('Failed to pull changes', finalErr.message);
  await deps.loadFromLocal();
  return true;
}
