import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { MigrationRecoveryComponent } from './migration-recovery.component';
import { WriteGuardService } from '../../../services/write-guard.service';
import { LoggerService } from '../../../services/logger.service';
import { environment } from '../../../environments/environment';

const mockLoggerCategory = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const mockLogger = { category: () => mockLoggerCategory } as unknown as LoggerService;

interface MutableEnv {
  readOnlyPreview: boolean;
  originGateMode: string;
  deploymentTarget: string;
  canonicalOrigin: string;
}

function configure(mode: 'writable' | 'read-only' | 'export-only'): void {
  const env = environment as unknown as MutableEnv;
  env.readOnlyPreview = false;
  env.originGateMode = 'off';
  env.deploymentTarget = 'local';
  if (mode === 'read-only') env.readOnlyPreview = true;
  if (mode === 'export-only') env.originGateMode = 'export-only';

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [MigrationRecoveryComponent],
    providers: [
      WriteGuardService,
      { provide: LoggerService, useValue: mockLogger },
    ],
  });
}

describe('MigrationRecoveryComponent', () => {
  let originalEnv: MutableEnv;

  beforeEach(() => {
    mockLoggerCategory.info.mockReset();
    if (typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.removeItem('nanoflow.migration-recovery-dismissed');
        sessionStorage.removeItem('__NANOFLOW_WRITE_GUARD__');
      } catch { /* noop */ }
    }
    const env = environment as unknown as MutableEnv;
    originalEnv = {
      readOnlyPreview: env.readOnlyPreview,
      originGateMode: env.originGateMode,
      deploymentTarget: env.deploymentTarget,
      canonicalOrigin: env.canonicalOrigin,
    };
  });

  afterEach(() => {
    const env = environment as unknown as MutableEnv;
    env.readOnlyPreview = originalEnv.readOnlyPreview;
    env.originGateMode = originalEnv.originGateMode;
    env.deploymentTarget = originalEnv.deploymentTarget;
    env.canonicalOrigin = originalEnv.canonicalOrigin;
  });

  it('writable 模式下不显示 banner', () => {
    configure('writable');
    const fixture = TestBed.createComponent(MigrationRecoveryComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.showBanner()).toBe(false);
  });

  it('read-only 模式显示橙色 banner，无导出链接', () => {
    configure('read-only');
    const fixture = TestBed.createComponent(MigrationRecoveryComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    expect(cmp.showBanner()).toBe(true);
    expect(cmp.bannerMode()).toBe('read-only');
    expect(cmp.showExportLink()).toBe(false);
    expect(cmp.bannerTitle()).toContain('只读');
  });

  it('export-only 模式显示红色 banner，含导出链接', () => {
    configure('export-only');
    const fixture = TestBed.createComponent(MigrationRecoveryComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    expect(cmp.showBanner()).toBe(true);
    expect(cmp.bannerMode()).toBe('export-only');
    expect(cmp.showExportLink()).toBe(true);
    expect(cmp.bannerTitle()).toContain('停止');
  });

  it('canonicalOrigin 与当前 origin 不同时返回拼接 URL', () => {
    configure('export-only');
    const env = environment as unknown as MutableEnv;
    env.canonicalOrigin = 'https://app.example.com';

    const fixture = TestBed.createComponent(MigrationRecoveryComponent);
    fixture.detectChanges();
    const url = fixture.componentInstance.canonicalOriginUrl();
    expect(url).toBeTruthy();
    expect(url!).toContain('https://app.example.com');
  });

  it('canonicalOrigin 与当前 origin 相同时返回 null（不显示迁移链接）', () => {
    configure('export-only');
    const env = environment as unknown as MutableEnv;
    env.canonicalOrigin = location.origin;

    const fixture = TestBed.createComponent(MigrationRecoveryComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.canonicalOriginUrl()).toBeNull();
  });

  it('dismissForSession 隐藏 banner 并写入 sessionStorage', () => {
    configure('read-only');
    const fixture = TestBed.createComponent(MigrationRecoveryComponent);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    expect(cmp.showBanner()).toBe(true);

    cmp.dismissForSession();
    expect(cmp.showBanner()).toBe(false);
    expect(sessionStorage.getItem('nanoflow.migration-recovery-dismissed')).toBe('1');
  });

  it('onExportClick 派发 nanoflow:request-data-export 事件并记录 logger.info', () => {
    configure('export-only');
    const fixture = TestBed.createComponent(MigrationRecoveryComponent);
    fixture.detectChanges();

    const dispatched: Event[] = [];
    const handler = (e: Event) => dispatched.push(e);
    window.addEventListener('nanoflow:request-data-export', handler);
    try {
      fixture.componentInstance.onExportClick();
      expect(dispatched).toHaveLength(1);
      const detail = (dispatched[0] as CustomEvent).detail;
      expect(detail.source).toBe('migration-recovery-banner');
      expect(mockLoggerCategory.info).toHaveBeenCalledWith('migration_recovery_export_requested');
    } finally {
      window.removeEventListener('nanoflow:request-data-export', handler);
    }
  });
});
