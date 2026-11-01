import type { ProjectOperationServiceSpecContext } from './project-operation.test-harness';

export type ProjectOperationConflictResolutionSpecContext = Pick<
  ProjectOperationServiceSpecContext,
  | 'service'
  | 'projectConflict'
  | 'mockProjectState'
  | 'mockSyncCoordinator'
  | 'mockUserSession'
  | 'mockAuth'
  | 'mockConflictStorage'
  | 'mockProjectConflictDirectSync'
  | 'mockActionQueue'
  | 'mockRetryQueue'
  | 'mockChangeTracker'
  | 'mockToast'
>;
