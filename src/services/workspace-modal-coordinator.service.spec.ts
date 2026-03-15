/**
 * WorkspaceModalCoordinatorService 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WorkspaceModalCoordinatorService } from './workspace-modal-coordinator.service';
import { ToastService } from './toast.service';
import { GlobalErrorHandler } from './global-error-handler.service';
import { DynamicModalService } from './dynamic-modal.service';
import { ModalLoaderService } from '../app/core/services/modal-loader.service';
import { ProjectStateService } from './project-state.service';
import { ProjectOperationService } from './project-operation.service';
import { AppAuthCoordinatorService } from '../app/core/services/app-auth-coordinator.service';
import { Router } from '@angular/router';

// ── Fake component for modal loading ─────────────────────────
class FakeComponent {}

// ── Mock factories ───────────────────────────────────────────

const mockToast = { error: vi.fn(), info: vi.fn() };
const mockRouter = { navigateByUrl: vi.fn() };
const mockErrorHandler = { dismissRecoveryDialog: vi.fn() };

const mockModalCloseRef = { close: vi.fn() };
const mockDynamicModal = {
  open: vi.fn(() => mockModalCloseRef),
  close: vi.fn(),
};

const mockModalLoader = {
  loadSettingsModal: vi.fn().mockResolvedValue(FakeComponent),
  loadDashboardModal: vi.fn().mockResolvedValue(FakeComponent),
  loadLoginModal: vi.fn().mockResolvedValue(FakeComponent),
  loadTrashModal: vi.fn().mockResolvedValue(FakeComponent),
  loadConfigHelpModal: vi.fn().mockResolvedValue(FakeComponent),
  loadNewProjectModal: vi.fn().mockResolvedValue(FakeComponent),
  loadMigrationModal: vi.fn().mockResolvedValue(FakeComponent),
  loadErrorRecoveryModal: vi.fn().mockResolvedValue(FakeComponent),
  loadConflictModal: vi.fn().mockResolvedValue(FakeComponent),
  loadStorageEscapeModal: vi.fn().mockResolvedValue(FakeComponent),
};

const mockProjectState = { projects: vi.fn(() => []) };
const mockProjectOps = { resolveConflict: vi.fn().mockResolvedValue(undefined) };
const mockAuthCoord = {
  sessionEmail: vi.fn(() => ''),
  authError: vi.fn(() => null),
  isAuthLoading: vi.fn(() => false),
  resetPasswordSent: vi.fn(() => false),
  isReloginMode: { set: vi.fn() },
};

describe('WorkspaceModalCoordinatorService', () => {
  let service: WorkspaceModalCoordinatorService;

  beforeEach(() => {
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        WorkspaceModalCoordinatorService,
        { provide: ToastService, useValue: mockToast },
        { provide: Router, useValue: mockRouter },
        { provide: GlobalErrorHandler, useValue: mockErrorHandler },
        { provide: DynamicModalService, useValue: mockDynamicModal },
        { provide: ModalLoaderService, useValue: mockModalLoader },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: ProjectOperationService, useValue: mockProjectOps },
        { provide: AppAuthCoordinatorService, useValue: mockAuthCoord },
      ],
    });

    service = TestBed.inject(WorkspaceModalCoordinatorService);
  });

  // ── Initial state ──────────────────────────────────────────

  it('should have empty modalLoading by default', () => {
    expect(service.modalLoading()).toEqual({});
  });

  it('should have null storageEscapeData by default', () => {
    expect(service.storageEscapeData()).toBeNull();
  });

  // ── isModalLoading ─────────────────────────────────────────

  it('should return false for unknown modal type', () => {
    expect(service.isModalLoading('unknown')).toBe(false);
  });

  // ── initCallbacks ──────────────────────────────────────────

  it('should store callbacks without error', () => {
    const callbacks = { signOut: vi.fn() };
    expect(() => service.initCallbacks(callbacks)).not.toThrow();
  });

  // ── openSettings ───────────────────────────────────────────

  it('should load component, open modal, and manage loading flag', async () => {
    await service.openSettings();

    expect(mockModalLoader.loadSettingsModal).toHaveBeenCalledOnce();
    expect(mockDynamicModal.open).toHaveBeenCalledOnce();
    // Loading flag should be cleared after completion
    expect(service.isModalLoading('settings')).toBe(false);
  });

  it('should show error toast when settings load fails', async () => {
    mockModalLoader.loadSettingsModal.mockRejectedValueOnce(new Error('fail'));

    await service.openSettings();

    expect(mockToast.error).toHaveBeenCalledOnce();
    expect(service.isModalLoading('settings')).toBe(false);
  });

  // ── closeSettings ──────────────────────────────────────────

  it('should close modal and reset reloginMode', () => {
    service.closeSettings();

    expect(mockDynamicModal.close).toHaveBeenCalledOnce();
    expect(mockAuthCoord.isReloginMode.set).toHaveBeenCalledWith(false);
  });

  // ── openLoginModal ─────────────────────────────────────────

  it('should open login modal with auth inputs', async () => {
    await service.openLoginModal();

    expect(mockModalLoader.loadLoginModal).toHaveBeenCalledOnce();
    expect(mockDynamicModal.open).toHaveBeenCalledOnce();

    const openCall = mockDynamicModal.open.mock.calls[0];
    const config = openCall[1];
    expect(config.inputs).toHaveProperty('authError');
    expect(config.inputs).toHaveProperty('isLoading');
    expect(config.inputs).toHaveProperty('resetPasswordSent');
    expect(config.closeOnBackdropClick).toBe(false);
    expect(config.closeOnEscape).toBe(false);
  });

  // ── closeLoginModal ────────────────────────────────────────

  it('should close login modal ref when it exists', async () => {
    await service.openLoginModal();
    service.closeLoginModal();
    expect(mockModalCloseRef.close).toHaveBeenCalledOnce();
  });

  it('should be no-op when no login modal ref', () => {
    // Should not throw
    expect(() => service.closeLoginModal()).not.toThrow();
  });

  // ── navigateAfterLogin ─────────────────────────────────────

  it('should navigate to return URL', () => {
    service.loginReturnUrl = '/dashboard';
    service.navigateAfterLogin();

    expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/dashboard');
    expect(service.loginReturnUrl).toBeNull();
  });

  it('should skip navigation for root URL', () => {
    service.loginReturnUrl = '/';
    service.navigateAfterLogin();

    expect(mockRouter.navigateByUrl).not.toHaveBeenCalled();
  });

  it('should skip navigation when no return URL', () => {
    service.loginReturnUrl = null;
    service.navigateAfterLogin();

    expect(mockRouter.navigateByUrl).not.toHaveBeenCalled();
  });

  // ── openTrashModal ─────────────────────────────────────────

  it('should load and open trash modal', async () => {
    await service.openTrashModal();

    expect(mockModalLoader.loadTrashModal).toHaveBeenCalledOnce();
    expect(mockDynamicModal.open).toHaveBeenCalledOnce();
    expect(service.isModalLoading('trash')).toBe(false);
  });

  // ── resolveConflictLocal ───────────────────────────────────

  it('should resolve conflict and close modal', async () => {
    // Set up pending conflict
    service.setPendingConflict({ projectId: 'p-1' } as any);
    // Open conflict modal to set the ref
    await service.openConflictModal({ projectId: 'p-1' } as any);

    await service.resolveConflictLocal();

    expect(mockProjectOps.resolveConflict).toHaveBeenCalledWith('p-1', 'local');
    expect(mockModalCloseRef.close).toHaveBeenCalledWith({ choice: 'local' });
  });

  // ── cancelConflictResolution ───────────────────────────────

  it('should close modal and show info toast', async () => {
    await service.openConflictModal({ projectId: 'p-1' } as any);

    service.cancelConflictResolution();

    expect(mockModalCloseRef.close).toHaveBeenCalledWith({ choice: 'cancel' });
    expect(mockToast.info).toHaveBeenCalled();
  });
});
