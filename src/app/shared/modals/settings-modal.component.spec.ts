import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { By } from '@angular/platform-browser';
import { SettingsModalComponent } from './settings-modal.component';
import { LoggerService } from '../../../services/logger.service';
import { UserSessionService } from '../../../services/user-session.service';
import { PreferenceService } from '../../../services/preference.service';
import { ExportService } from '../../../services/export.service';
import { ImportService } from '../../../services/import.service';
import { AttachmentExportService } from '../../../services/attachment-export.service';
import { AttachmentImportService } from '../../../services/attachment-import.service';
import { LocalBackupService } from '../../../services/local-backup.service';
import { ThemeService } from '../../../services/theme.service';
import { DockEngineService } from '../../../services/dock-engine.service';
import { FocusPreferenceService } from '../../../services/focus-preference.service';
import { GateService } from '../../../services/gate.service';
import { ExternalSourceCacheService } from '../../core/external-sources/external-source-cache.service';
import { SiyuanPreviewService } from '../../core/external-sources/siyuan/siyuan-preview.service';
import type { Project, Task } from '../../../models';
import type { AttachmentImportItem } from '../../../services/attachment-import.service';
import { DisasterBackupService } from '../../../services/disaster-backup.service';
import { BackupDataSafetyMetadataRestoreService } from '../../../services/backup-data-safety-metadata-restore.service';
import { SessionRuntimeResetRegistry } from '../../../services/session-runtime-reset.service';
import { LocalBackupUiRestoreStageService } from '../../../services/local-backup-ui-restore-stage.service';
import { LocalBackupUiRestoreTransactionService } from '../../../services/local-backup-ui-restore-transaction.service';
import {
  registerSettingsModalSiyuanOwnerGenerationSpecs,
} from './settings-modal-siyuan-owner-generation.spec-helpers';

describe('SettingsModalComponent', () => {
  let fixture: ComponentFixture<SettingsModalComponent>;
  let component: SettingsModalComponent;

  type MockFocusPreferences = {
    gateEnabled: boolean;
    blackBoxEnabled: boolean;
    strataEnabled: boolean;
    maxSnoozePerDay: number;
    routineResetHourLocal: number;
    restReminderHighLoadMinutes: number;
    restReminderLowLoadMinutes: number;
  };

  const currentUserId = signal<string | null>('user-1');
  const theme = signal<'default' | 'ocean' | 'forest' | 'sunset' | 'lavender'>('default');
  const autoResolveConflicts = signal(true);
  const colorMode = signal<'light' | 'dark' | 'system'>('system');
  const dailySlots = signal([
    {
      id: 'slot-1',
      title: '喝水',
      maxDailyCount: 1,
      todayCompletedCount: 0,
      isEnabled: true,
      createdAt: '2026-03-14T08:00:00.000Z',
    },
  ]);
  const focusPreferences = signal<MockFocusPreferences>({
    gateEnabled: true,
    blackBoxEnabled: true,
    strataEnabled: true,
    maxSnoozePerDay: 3,
    routineResetHourLocal: 0,
    restReminderHighLoadMinutes: 90,
    restReminderLowLoadMinutes: 30,
  });

  const mockLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    category: vi.fn(() => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    })),
  };

  const mockPreferenceService = {
    theme,
    autoResolveConflicts,
    setAutoResolveConflicts: vi.fn((enabled: boolean) => autoResolveConflicts.set(enabled)),
  };

  const mockThemeService = {
    colorMode,
    setColorMode: vi.fn((mode: 'light' | 'dark' | 'system') => colorMode.set(mode)),
  };

  const mockFocusPreferenceService = {
    preferences: focusPreferences,
    update: vi.fn((updates: Partial<MockFocusPreferences>) => {
      focusPreferences.update(current => ({ ...current, ...updates }));
    }),
    setRestReminderHighLoadMinutes: vi.fn((minutes: number) => {
      focusPreferences.update(current => ({ ...current, restReminderHighLoadMinutes: minutes }));
    }),
    setRestReminderLowLoadMinutes: vi.fn((minutes: number) => {
      focusPreferences.update(current => ({ ...current, restReminderLowLoadMinutes: minutes }));
    }),
  };

  const mockDockEngine = {
    dailySlots,
    dailySlotService: {
      addDailySlot: vi.fn(),
      completeDailySlot: vi.fn(),
      setDailySlotEnabled: vi.fn(),
      removeDailySlot: vi.fn(),
    },
  };

  const mockLocalBackupService = {
    setProjectsProvider: vi.fn(),
    isAvailable: signal(false),
    isAuthorized: signal(false),
    hasSavedHandle: signal(false),
    needsPermissionResume: signal(false),
    directoryName: signal<string | null>(null),
    autoBackupEnabled: signal(false),
    autoBackupIntervalMs: signal(30 * 60 * 1000),
    lastBackupTime: signal<string | null>(null),
    isBackingUp: signal(false),
    requestDirectoryAccess: vi.fn(),
    revokeDirectoryAccess: vi.fn(),
    resumePermission: vi.fn(),
    performBackup: vi.fn(),
    stopAutoBackup: vi.fn(),
    startAutoBackup: vi.fn(),
  };

  const mockDisasterBackupService = {
    buildLocalBlob: vi.fn(),
  };

  const mockMetadataRestoreService = {
    preview: vi.fn(),
    restore: vi.fn(),
  };

  const mockExportService = {
    isExporting: signal(false),
    exportAndDownload: vi.fn(),
  };

  const mockImportService = {
    isImporting: signal(false),
    validateFile: vi.fn(),
    generatePreview: vi.fn(),
    executeImport: vi.fn(),
  };

  const mockAttachmentExportService = {
    isExporting: signal(false),
    progress: signal({ percentage: 0, processedCount: 0, totalCount: 0 }),
    exportAndDownload: vi.fn(),
  };

  const mockAttachmentImportService = {
    isImporting: signal(false),
    progress: signal({ percentage: 0, completedItems: 0, failedItems: 0, skippedItems: 0, totalItems: 0 }),
    extractAttachmentsFromZip: vi.fn(),
    importAttachments: vi.fn(),
  };

  const mockUserSession = {
    currentUserId,
  };

  const mockGateService = {
    devForceShowGate: vi.fn(),
  };

  const mockSiyuanCache = {
    loadConfig: vi.fn().mockResolvedValue({
      runtimeMode: 'extension-relay',
      baseUrl: 'http://127.0.0.1:6806',
      token: undefined,
    }),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    clearPreviewCache: vi.fn().mockResolvedValue(undefined),
    forgetConfig: vi.fn().mockResolvedValue(undefined),
  };

  const mockSiyuanPreview = {
    diagnoseConnection: vi.fn().mockResolvedValue({ ok: true, mode: 'extension-relay' }),
    pushExtensionConfig: vi.fn().mockResolvedValue({ ok: true }),
    getExtensionConfigStatus: vi.fn().mockResolvedValue({ baseUrl: 'http://127.0.0.1:6806', hasToken: false }),
    probeExtensionConfigStatus: vi.fn().mockResolvedValue({
      kind: 'ok',
      status: { baseUrl: 'http://127.0.0.1:6806', hasToken: false },
    }),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    currentUserId.set('user-1');
    theme.set('default');
    autoResolveConflicts.set(true);
    colorMode.set('system');
    dailySlots.set([
      {
        id: 'slot-1',
        title: '喝水',
        maxDailyCount: 1,
        todayCompletedCount: 0,
        isEnabled: true,
        createdAt: '2026-03-14T08:00:00.000Z',
      },
    ]);
    focusPreferences.set({
      gateEnabled: true,
      blackBoxEnabled: true,
      strataEnabled: true,
      maxSnoozePerDay: 3,
      routineResetHourLocal: 0,
      restReminderHighLoadMinutes: 90,
      restReminderLowLoadMinutes: 30,
    });
    mockDockEngine.dailySlotService.addDailySlot.mockReturnValue('slot-new');
    mockDockEngine.dailySlotService.completeDailySlot.mockResolvedValue(true);
    mockDockEngine.dailySlotService.setDailySlotEnabled.mockResolvedValue(true);
    mockDockEngine.dailySlotService.removeDailySlot.mockResolvedValue(true);

    await TestBed.configureTestingModule({
      imports: [SettingsModalComponent],
      providers: [
        { provide: LoggerService, useValue: mockLogger },
        { provide: UserSessionService, useValue: mockUserSession },
        { provide: PreferenceService, useValue: mockPreferenceService },
        { provide: ExportService, useValue: mockExportService },
        { provide: ImportService, useValue: mockImportService },
        { provide: AttachmentExportService, useValue: mockAttachmentExportService },
        { provide: AttachmentImportService, useValue: mockAttachmentImportService },
        { provide: LocalBackupService, useValue: mockLocalBackupService },
        { provide: DisasterBackupService, useValue: mockDisasterBackupService },
        { provide: BackupDataSafetyMetadataRestoreService, useValue: mockMetadataRestoreService },
        {
          provide: LocalBackupUiRestoreStageService,
          useValue: { createOperations: vi.fn(), createRecoveryOperations: vi.fn() },
        },
        { provide: LocalBackupUiRestoreTransactionService, useValue: { prepare: vi.fn(), takeoverExpired: vi.fn() } },
        { provide: ThemeService, useValue: mockThemeService },
        { provide: DockEngineService, useValue: mockDockEngine },
        { provide: FocusPreferenceService, useValue: mockFocusPreferenceService },
        { provide: GateService, useValue: mockGateService },
        { provide: ExternalSourceCacheService, useValue: mockSiyuanCache },
        { provide: SiyuanPreviewService, useValue: mockSiyuanPreview },
        SessionRuntimeResetRegistry,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SettingsModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  registerSettingsModalSiyuanOwnerGenerationSpecs({
    component: () => component,
    currentUserId,
    destroyFixture: () => fixture.destroy(),
    mockSiyuanCache,
    sessionRuntimeReset: () => TestBed.inject(SessionRuntimeResetRegistry),
  });

  it('should remove the obsolete backup reminder setting from the UI', () => {
    expect(fixture.nativeElement.textContent).not.toContain('定期备份提醒');
  });

  it('should render the appearance subcomponent with theme and color mode controls', () => {
    expect(fixture.nativeElement.textContent).toContain('外观风格');
    expect(fixture.nativeElement.textContent).toContain('颜色模式');
    expect(fixture.nativeElement.textContent).toContain('薰衣草');
  });

  it('should emit themeChange when a theme tile is selected', () => {
    const themeSpy = vi.fn();
    component.themeChange.subscribe(themeSpy);

    findButtonByText('海洋').click();

    expect(themeSpy).toHaveBeenCalledWith('ocean');
  });

  it('should update color mode directly through ThemeService', () => {
    findButtonByText('深色').click();

    expect(mockThemeService.setColorMode).toHaveBeenCalledWith('dark');
    expect(colorMode()).toBe('dark');
  });

  it('should expose a stable settings modal test id', () => {
    expect(fixture.nativeElement.querySelector('[data-testid="settings-modal"]')).toBeTruthy();
  });

  it('should render pending local restore state in the backup preview', () => {
    mockLocalBackupService.isAvailable.set(true);
    mockLocalBackupService.hasSavedHandle.set(true);
    mockLocalBackupService.directoryName.set('NanoFlow Backups');
    component.localBackupUI.restoreStep.set('preview');
    component.localBackupUI.restorePreview.set({
      projects: 1,
      tasks: 2,
      connections: 1,
      attachmentUploads: 1,
      actionQueue: 2,
      retryQueue: 3,
      deadLetters: 1,
      conflicts: 1,
      projectCursors: 1,
      lastSyncTime: 1,
      replayLog: 2,
      lastWriteExplain: 1,
      taskTombstones: 1,
      connectionTombstones: 1,
    });
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('本机待恢复状态');
    expect(text).toContain('附件上传 1');
    expect(text).toContain('待同步 2');
    expect(text).toContain('待重试 3');
    expect(text).toContain('失败记录 1');
    expect(text).toContain('冲突副本 1');
    expect(text).toContain('项目游标 1');
    expect(text).toContain('写入审计 2');
    expect(text).toContain('最近写入解释 1');
    expect(text).toContain('任务删除标记 1');
    expect(text).toContain('连接删除标记 1');
  });

  it('should await safe restore without invoking the normal project import callback', async () => {
    const project = createProject('project-1', []);
    let releaseRestore!: () => void;
    const restoreCompletion = new Promise<void>(resolve => {
      releaseRestore = resolve;
    });
    const importProject = vi.fn();
    (component as unknown as { importProject: () => typeof importProject }).importProject =
      () => importProject;
    const confirmRestore = vi.spyOn(component.localBackupUI, 'confirmRestore')
      .mockReturnValue(restoreCompletion);
    let settled = false;

    const pending = component.confirmRestore().then(() => { settled = true; });
    await Promise.resolve();

    expect(confirmRestore).toHaveBeenCalledWith(component.projects());
    expect(importProject).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    releaseRestore();
    await pending;
    expect(settled).toBe(true);
  });

  it('should expose portable data-safety export and file restore without directory API support', async () => {
    const project = createProject('project-1', []);
    component.projects = signal([project]) as unknown as typeof component.projects;
    const download = vi.spyOn(component.localBackupUI, 'handleDownloadDataSafetyPackage')
      .mockResolvedValue(undefined);
    const loadFile = vi.spyOn(component.localBackupUI, 'loadRestorePreviewFromFile')
      .mockResolvedValue(undefined);
    fixture.detectChanges();

    const exportButton = fixture.nativeElement.querySelector(
      '[data-testid="settings-data-safety-export"]',
    ) as HTMLButtonElement | null;
    const restoreInput = fixture.nativeElement.querySelector(
      '[data-testid="settings-data-safety-restore-input"]',
    ) as HTMLInputElement | null;

    expect(exportButton).toBeTruthy();
    expect(restoreInput).toBeTruthy();
    exportButton!.click();
    expect(download).toHaveBeenCalledWith([project]);

    const file = new File(['{}'], 'nanoflow-backup.json', { type: 'application/json' });
    Object.defineProperty(restoreInput!, 'files', {
      configurable: true,
      value: [file],
    });
    restoreInput!.dispatchEvent(new Event('change'));

    expect(loadFile).toHaveBeenCalledWith(file, [project]);
  });

  it('should route a full BackupData file selected through ordinary import into safe restore', async () => {
    const project = createProject('project-1', []);
    component.projects = signal([project]) as unknown as typeof component.projects;
    const loadFile = vi.spyOn(component.localBackupUI, 'loadRestorePreviewFromFile')
      .mockResolvedValue(undefined);
    const file = new File([JSON.stringify({
      payloadVersion: '2.0.0',
      projects: [{ id: 'project-1', userId: 'user-1' }],
      tasks: [],
      connections: [],
      localState: {},
    })], 'nanoflow-backup.json', { type: 'application/json' });
    const event = {
      target: {
        files: [file],
        value: 'nanoflow-backup.json',
      },
    } as unknown as Event;

    await component.handleFileSelected(event);

    expect(loadFile).toHaveBeenCalledWith(file, [project]);
    expect(mockImportService.validateFile).not.toHaveBeenCalled();
    expect(mockImportService.executeImport).not.toHaveBeenCalled();
  });

  it('should keep the black box toggle visible and functional', () => {
    const toggle = fixture.debugElement.query(By.css('[data-testid="settings-blackbox-toggle"]'));

    expect(fixture.nativeElement.textContent).toContain('黑匣子');
    expect(toggle).toBeTruthy();

    (toggle.nativeElement as HTMLButtonElement).click();

    expect(mockFocusPreferenceService.update).toHaveBeenCalledWith({ blackBoxEnabled: false });
  });

  it('should toggle auto resolve conflicts via PreferenceService', () => {
    component.toggleAutoResolve();

    expect(mockPreferenceService.setAutoResolveConflicts).toHaveBeenCalledWith(false);
    expect(autoResolveConflicts()).toBe(false);
  });

  it('should forward rest reminder changes to FocusPreferenceService', () => {
    const highLoadSelect = fixture.debugElement.query(By.css('[data-testid="settings-rest-reminder-high"]')).nativeElement as HTMLSelectElement;
    const lowLoadSelect = fixture.debugElement.query(By.css('[data-testid="settings-rest-reminder-low"]')).nativeElement as HTMLSelectElement;

    highLoadSelect.value = '120';
    highLoadSelect.dispatchEvent(new Event('change'));
    lowLoadSelect.value = '15';
    lowLoadSelect.dispatchEvent(new Event('change'));

    expect(mockFocusPreferenceService.setRestReminderHighLoadMinutes).toHaveBeenCalledWith(120);
    expect(mockFocusPreferenceService.setRestReminderLowLoadMinutes).toHaveBeenCalledWith(15);
  });

  it('should return routine slot persistence promises from settings controls', async () => {
    let resolveComplete!: (saved: boolean) => void;
    mockDockEngine.dailySlotService.completeDailySlot.mockReturnValueOnce(new Promise<boolean>(resolve => {
      resolveComplete = resolve;
    }));

    const completion = component.completeRoutineSlot('slot-1') as unknown as Promise<void>;
    let completed = false;
    completion.then(() => {
      completed = true;
    });

    expect(mockDockEngine.dailySlotService.completeDailySlot).toHaveBeenCalledWith('slot-1');
    expect(typeof completion?.then).toBe('function');
    await Promise.resolve();
    expect(completed).toBe(false);

    resolveComplete(true);
    await completion;
    expect(completed).toBe(true);

    await component.toggleRoutineSlot('slot-1', false);
    await component.removeRoutineSlot('slot-1');
    expect(mockDockEngine.dailySlotService.setDailySlotEnabled).toHaveBeenCalledWith('slot-1', false);
    expect(mockDockEngine.dailySlotService.removeDailySlot).toHaveBeenCalledWith('slot-1');
  });

  it('should keep routine slot form values when add persistence fails', async () => {
    mockDockEngine.dailySlotService.addDailySlot.mockResolvedValueOnce('');
    component.newRoutineTitle = '喝水';
    component.newRoutineMaxCount = 2;

    await component.addRoutineSlot();

    expect(mockDockEngine.dailySlotService.addDailySlot).toHaveBeenCalledWith('喝水', 2);
    expect(component.newRoutineTitle).toBe('喝水');
    expect(component.newRoutineMaxCount).toBe(2);
  });

  it('should render SiYuan Knowledge Anchor local-only settings', () => {
    expect(fixture.nativeElement.textContent).toContain('思源知识锚点');
    expect(fixture.nativeElement.textContent).toContain('token 与预览缓存仅保存当前设备');
  });

  it('should persist SiYuan runtime mode changes locally', async () => {
    const siyuanSelect = fixture.nativeElement.querySelector('[data-testid="siyuan-runtime-mode-select"]') as HTMLSelectElement | null;
    expect(siyuanSelect).toBeTruthy();

    siyuanSelect!.value = 'cache-only';
    await component.updateSiyuanRuntimeMode({ target: siyuanSelect } as unknown as Event);

    expect(mockSiyuanCache.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ runtimeMode: 'cache-only' }));
    expect(component.siyuanRuntimeMode()).toBe('cache-only');
  });

  it('should clear SiYuan preview cache without forgetting config', async () => {
    await component.clearSiyuanCache();

    expect(mockSiyuanCache.clearPreviewCache).toHaveBeenCalledTimes(1);
    expect(mockSiyuanCache.forgetConfig).not.toHaveBeenCalled();
    expect(component.siyuanConnectionStatus()).toContain('已清除');
  });

  it('should surface SiYuan connection failures with safe messages', async () => {
    mockSiyuanPreview.diagnoseConnection.mockResolvedValueOnce({
      ok: false,
      mode: 'extension-relay',
      errorCode: 'extension-unavailable',
    });

    await component.testSiyuanConnection();

    expect(component.siyuanConnectionStatus()).toContain('扩展未安装或未注入当前页面');
  });

  it('should keep SiYuan diagnose failures local to settings status', async () => {
    mockSiyuanPreview.diagnoseConnection.mockRejectedValueOnce(new Error('network'));

    await component.testSiyuanConnection();

    expect(component.siyuanConnectionStatus()).toContain('检测失败，请稍后重试');
    expect(mockLogger.warn).toHaveBeenCalledWith('SettingsModal', '思源连接诊断失败', expect.objectContaining({ message: 'network' }));
  });

  it('should push SiYuan baseUrl/token to the extension when the explicit save button is clicked', async () => {
    // 模拟用户在 token 输入框输入一个值
    await component.updateSiyuanToken({ target: { value: 'secret-token-value' } } as unknown as Event);
    expect(component.siyuanTokenMask()).toBe('••••••••');
    // relay 模式下 token 不能写入 IndexedDB
    const tokenWrites = mockSiyuanCache.saveConfig.mock.calls.filter(
      (call: unknown[]) => Object.prototype.hasOwnProperty.call(call[0] as object, 'token') && (call[0] as { token?: string }).token,
    );
    expect(tokenWrites).toHaveLength(0);

    await component.saveSiyuanConfigToExtension();

    expect(mockSiyuanPreview.pushExtensionConfig).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://127.0.0.1:6806', token: 'secret-token-value' }),
    );
    expect(component.siyuanConnectionStatus()).toContain('已写入扩展');
    // token 在写入扩展后必须立即从 UI 清掉
    expect(component.siyuanTokenMask()).toBe('');
  });

  it('should map push-config failure codes to friendly messages', async () => {
    mockSiyuanPreview.pushExtensionConfig.mockResolvedValueOnce({ ok: false, errorCode: 'extension-unavailable' });

    await component.saveSiyuanConfigToExtension();

    expect(component.siyuanConnectionStatus()).toContain('扩展未安装或未启用');
  });

  it('should surface an "extension not supported" badge when config-status probing reports unsupported', async () => {
    mockSiyuanPreview.probeExtensionConfigStatus.mockResolvedValueOnce({ kind: 'unsupported' });

    await component.loadSiyuanConfig();
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('[data-testid="siyuan-extension-status"]') as HTMLElement | null;
    expect(badge).toBeTruthy();
    expect(badge!.textContent ?? '').toContain('当前扩展版本不支持页面配置读写');
    const saveBtn = fixture.nativeElement.querySelector('[data-testid="siyuan-save-to-extension"]') as HTMLButtonElement | null;
    expect(saveBtn).toBeTruthy();
    expect(saveBtn!.disabled).toBe(true);
  });

  it('should refresh a stale unsupported SiYuan extension badge after a successful relay connection test', async () => {
    component.siyuanRuntimeMode.set('extension-relay');
    component.siyuanExtensionStatus.set(null);
    mockSiyuanPreview.diagnoseConnection.mockResolvedValueOnce({ ok: true, mode: 'extension-relay' });
    mockSiyuanPreview.probeExtensionConfigStatus.mockResolvedValueOnce({
      kind: 'ok',
      status: {
        baseUrl: 'http://127.0.0.1:6806',
        hasToken: true,
      },
    });

    await component.testSiyuanConnection();
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('[data-testid="siyuan-extension-status"]') as HTMLElement | null;
    expect(badge).toBeTruthy();
    expect(badge!.textContent ?? '').toContain('扩展已配置');
    expect(badge!.textContent ?? '').not.toContain('扩展未安装或版本过旧');
    expect(component.siyuanConnectionStatus()).toContain('思源预览通道可用');
  });

  it('should distinguish a reachable SiYuan extension from an unsupported page config channel', async () => {
    component.siyuanRuntimeMode.set('extension-relay');
    component.siyuanExtensionStatus.set(null);
    mockSiyuanPreview.diagnoseConnection.mockResolvedValueOnce({ ok: true, mode: 'extension-relay' });
    mockSiyuanPreview.probeExtensionConfigStatus.mockResolvedValueOnce({ kind: 'unsupported' });

    await component.testSiyuanConnection();
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('[data-testid="siyuan-extension-status"]') as HTMLElement | null;
    const saveBtn = fixture.nativeElement.querySelector('[data-testid="siyuan-save-to-extension"]') as HTMLButtonElement | null;
    expect(badge).toBeTruthy();
    expect(badge!.textContent ?? '').toContain('扩展预览通道已连通');
    expect(badge!.textContent ?? '').toContain('当前配置由扩展 Options 管理');
    expect(badge!.textContent ?? '').not.toContain('扩展未安装或版本过旧');
    expect(badge!.textContent ?? '').not.toContain('缺少页面配置通道');
    expect(component.siyuanConnectionStatus()).toContain('思源预览通道可用');
    expect(saveBtn).toBeTruthy();
    expect(saveBtn!.disabled).toBe(true);
  });

  it('should keep the existing extension badge when config-status probing fails transiently', async () => {
    component.siyuanRuntimeMode.set('extension-relay');
    mockSiyuanPreview.diagnoseConnection.mockResolvedValueOnce({ ok: true, mode: 'extension-relay' });
    mockSiyuanPreview.probeExtensionConfigStatus.mockResolvedValueOnce({
      kind: 'error',
      errorCode: 'unknown',
    });

    await component.testSiyuanConnection();
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('[data-testid="siyuan-extension-status"]') as HTMLElement | null;
    const saveBtn = fixture.nativeElement.querySelector('[data-testid="siyuan-save-to-extension"]') as HTMLButtonElement | null;
    expect(badge).toBeTruthy();
    expect(badge!.textContent ?? '').toContain('读取配置状态失败');
    expect(badge!.textContent ?? '').not.toContain('缺少页面配置通道');
    expect(component.siyuanConnectionStatus()).toContain('读取扩展配置状态失败');
    expect(saveBtn).toBeTruthy();
    expect(saveBtn!.disabled).toBe(false);
  });

  it('should group attachment ZIP imports by project and summarize unmatched and failed items', async () => {
    const alertSpy = vi.spyOn(globalThis, 'alert').mockImplementation(() => undefined);
    const itemA = createAttachmentImportItem('task-a', 'task-a-file.txt');
    const itemB = createAttachmentImportItem('task-b', 'task-b-file.txt');
    const unmatchedItem = createAttachmentImportItem('missing-task', 'missing-file.txt');
    component.projects = signal([
      createProject('project-a', [createTask('task-a')]),
      createProject('project-b', [createTask('task-b')]),
    ]) as unknown as typeof component.projects;
    mockAttachmentImportService.extractAttachmentsFromZip.mockResolvedValueOnce([itemA, itemB, unmatchedItem]);
    mockAttachmentImportService.importAttachments
      .mockResolvedValueOnce({ success: true, imported: 1, failed: 0, skipped: 0, errors: [] })
      .mockResolvedValueOnce({
        success: false,
        imported: 0,
        failed: 1,
        skipped: 2,
        errors: [{ taskId: 'task-b', attachmentName: 'task-b-file.txt', error: 'upload failed' }],
      });

    await component.handleAttachmentImportFileSelected(createFileInputEvent('attachments.zip'));

    expect(mockAttachmentImportService.importAttachments).toHaveBeenNthCalledWith(1, 'project-a', [itemA]);
    expect(mockAttachmentImportService.importAttachments).toHaveBeenNthCalledWith(2, 'project-b', [itemB]);
    expect(alertSpy).toHaveBeenCalledWith(
      '附件导入部分失败。\n成功: 1\n失败: 1\n跳过: 3\n首个错误: task-b-file.txt: upload failed',
    );
    expect(mockLogger.warn).toHaveBeenCalledWith('SettingsModal', '部分附件未匹配到项目，已跳过: 1');
  });

  function findButtonByText(text: string): HTMLButtonElement {
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    const button = buttons.find(candidate => candidate.textContent?.includes(text));
    if (!button) {
      throw new Error(`Button not found: ${text}`);
    }
    return button;
  }

  function createProject(id: string, tasks: Task[]): Project {
    return {
      id,
      name: id,
      description: '',
      createdDate: '2026-01-01T00:00:00.000Z',
      tasks,
      connections: [],
    };
  }

  function createTask(id: string): Task {
    return {
      id,
      title: id,
      content: '',
      stage: null,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      createdDate: '2026-01-01T00:00:00.000Z',
      displayId: id,
    };
  }

  function createAttachmentImportItem(taskId: string, name: string): AttachmentImportItem {
    return {
      taskId,
      metadata: {
        id: `${taskId}-attachment`,
        name,
        size: 12,
        mimeType: 'text/plain',
      },
      data: new Blob(['attachment'], { type: 'text/plain' }),
    };
  }

  function createFileInputEvent(filename: string): Event {
    return {
      target: {
        files: [{
          name: filename,
          arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
        }],
        value: filename,
      },
    } as unknown as Event;
  }
});
