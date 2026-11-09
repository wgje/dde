import { describe, expect, it } from 'vitest';

import {
  FULL_WIPE_INDEXED_DB_NAMES,
  FULL_WIPE_LOCAL_STORAGE_PREFIXES,
} from './user-session-base.types';

describe('登出全量清理清单', () => {
  it('必须覆盖 Widget 直推 outbox 的 IndexedDB 与 localStorage 兜底存储', () => {
    // 该 outbox 的记录不携带 owner：若登出不清空，下一个登录账号的连接恢复
    // flush 会用新账号 JWT 重放上一个账号的 focus/black-box 直推通知
    expect(FULL_WIPE_INDEXED_DB_NAMES).toContain('nanoflow-dock-direct-widget-notify-outbox');
    expect(FULL_WIPE_LOCAL_STORAGE_PREFIXES).toContain('nanoflow.dock-direct-widget-notify.');
  });

  it('必须覆盖偏好与附件 owner-scoped outbox 的 IndexedDB 和 localStorage 镜像', () => {
    expect(FULL_WIPE_INDEXED_DB_NAMES).toEqual(expect.arrayContaining([
      'nanoflow-user-preferences-sync',
      'nanoflow-pending-preference-outbox',
      'nanoflow-attachment-upload-outbox',
      'nanoflow-attachment-cleanup-outbox',
    ]));
    expect(FULL_WIPE_LOCAL_STORAGE_PREFIXES).toEqual(expect.arrayContaining([
      'nanoflow.userPreferencesBaseline.',
      'nanoflow.pendingPreferenceOutbox.',
      'nanoflow.attachment-upload-outbox.',
      'nanoflow.attachment-cleanup-outbox.',
    ]));
  });
});
