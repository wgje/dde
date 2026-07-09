import type { ProjectOperationConflictService } from './project-operation-conflict.service';
import type { ProjectOperationService } from './project-operation.service';
import type { MockFn } from './project-operation.test-harness';

export interface ProjectOperationConflictResolutionSpecContext {
  service: ProjectOperationService;
  projectConflict: ProjectOperationConflictService;
  mockProjectState: {
    updateProjects: MockFn;
    getProject: MockFn;
  };
  mockSyncCoordinator: {
    conflictData: MockFn;
    resolveConflict: MockFn;
    resolveConflictWithPlan: MockFn;
    captureConflict: MockFn;
    clearActiveConflict: MockFn;
    loadSingleProjectFromCloud: MockFn;
    core: {
      saveProjectSmart: MockFn;
      deleteTask: MockFn;
      saveOfflineSnapshotAndWait?: MockFn;
    };
  };
  mockUserSession: {
    currentUserId: MockFn;
    isSessionContextCurrent: MockFn;
  };
  mockConflictStorage: {
    getConflict: MockFn;
    deleteConflict: MockFn;
  };
  mockActionQueue: {
    enqueue: MockFn;
    enqueueDurably: MockFn;
    enqueueForOwner: MockFn;
    discardActions: MockFn;
  };
  mockRetryQueue: {
    removeByProjectIdForOwner: MockFn;
  };
  mockChangeTracker: {
    clearProjectFieldLocks: MockFn;
    clearProjectChanges: MockFn;
  };
  mockToast: {
    error: MockFn;
    warning: MockFn;
  };
}
