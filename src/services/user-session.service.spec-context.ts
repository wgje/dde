import { vi } from 'vitest';
import type { WritableSignal } from '@angular/core';

import type { UserSessionService } from './user-session.service';
import type { Project, Task } from '../models';

type TestMock = ReturnType<typeof vi.fn>;

export interface UserSessionServiceSpecContext {
  service: UserSessionService;
  destroyCallbacks: Array<() => void>;
  mockAuthService: Record<string, unknown>;
  mockProjectState: Record<string, unknown>;
  mockSyncCoordinator: Record<string, unknown>;
  mockStorePersistence: Record<string, unknown>;
  mockChangeTracker: Record<string, unknown>;
  mockUndoService: Record<string, unknown>;
  mockUiState: Record<string, unknown>;
  mockActionQueue: Record<string, unknown>;
  mockRetryQueue: Record<string, unknown>;
  mockConflictStorage: Record<string, unknown>;
  mockDockSnapshotPersistence: Record<string, unknown>;
  mockStartupPlaceholderState: {
    isHintOnlyActive: TestMock;
    activate: TestMock;
    clear: TestMock;
  };
  mockAttachmentService: Record<string, unknown>;
  mockLayoutService: Record<string, unknown>;
  mockToastService: Record<string, unknown>;
  mockLoggerCategory: {
    info: TestMock;
    warn: TestMock;
    error: TestMock;
    debug: TestMock;
  };
  mockSupabaseClientService: {
    isConfigured: boolean;
    isOfflineMode: TestMock;
    client: TestMock;
    clientAsync: TestMock;
    getClient: TestMock;
    getSession: TestMock;
    getStorageKey: TestMock;
    signOut: TestMock;
  };
  userIdSignal: WritableSignal<string | null>;
  blackBoxEntriesMap: WritableSignal<Map<string, unknown>>;
  gateSnoozeCount: WritableSignal<number>;
  gateState: WritableSignal<string>;
  createTask: (overrides?: Partial<Task>) => Task;
  createSnapshotPreviewTask: (overrides?: Partial<Task>) => Task;
  createProject: (overrides?: Partial<Project>) => Project;
  saveGuestDraftProjects: (projects: Project[]) => void;
  createAttachment: (id?: `${string}-${string}-${string}-${string}-${string}`) => {
    id: string;
    type: 'file';
    name: string;
    url: string;
    createdAt: string;
    signedAt: string;
  };
  flushAsyncWork: () => Promise<void>;
}
