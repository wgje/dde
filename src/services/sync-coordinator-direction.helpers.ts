import type { SyncDirection } from './sync-mode.service';

interface SyncDirectionHandlers {
  getCurrentUserId: () => string | null | undefined;
  upload: () => Promise<void>;
  download: (userId: string) => Promise<void>;
}

export async function executeSyncByDirection(
  direction: SyncDirection,
  handlers: SyncDirectionHandlers,
): Promise<void> {
  const userId = handlers.getCurrentUserId();
  if (!userId) return;

  switch (direction) {
    case 'upload':
      await handlers.upload();
      break;
    case 'download':
      await handlers.download(userId);
      break;
    case 'both':
      await handlers.upload();
      await handlers.download(userId);
      break;
  }
}
