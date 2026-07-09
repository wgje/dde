import type {
  WorkspaceShellLazyLifecycleGroupMember,
} from './workspace-shell-lazy-lifecycle-hosts.factory';

export function createWorkspaceShellNoopLifecycleHost(): WorkspaceShellLazyLifecycleGroupMember {
  return {
    initialize: () => undefined,
    teardown: () => undefined,
  };
}
