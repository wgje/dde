import { BlackBoxSyncPullLayer } from './black-box-sync-pull.service';
import { Injectable } from '@angular/core';

export type { BlackBoxWidgetNotifyAction, LoadBlackBoxLocalOptions, PullChangesOptions, ScheduleBlackBoxSyncOptions } from './black-box-sync.types';

@Injectable({
  providedIn: 'root'
})
export class BlackBoxSyncService extends BlackBoxSyncPullLayer {
  constructor() {
    super();
    // 初始化 IndexedDB
    void this.initIndexedDB().catch(error => {
      this.logger.warn('Initial IndexedDB setup deferred', error instanceof Error ? error.message : String(error));
    });

    // 监听网络状态变化
    this.setupNetworkListener();

    this.setupAuthRecoveryEffect();
    this.setupSyncCursorScopeEffect();
    this.setupRealtimeSubscriptionEffect();
  }
}
