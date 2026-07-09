import {
  WorkspaceShellLazyServiceRefsController,
  type WorkspaceShellLazyServiceRefsControllerOptions,
} from './workspace-shell-lazy-service-refs.controller';

export function createWorkspaceShellLazyServiceRefs(
  options: WorkspaceShellLazyServiceRefsControllerOptions,
): WorkspaceShellLazyServiceRefsController {
  return new WorkspaceShellLazyServiceRefsController(options);
}
