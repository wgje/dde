export interface WorkspaceShellRouteNodeLike {
  snapshot: {
    params: Record<string, unknown>;
  };
  firstChild?: WorkspaceShellRouteNodeLike | null;
}

export function readWorkspaceShellRouteProjectId(
  route: WorkspaceShellRouteNodeLike,
): string | null {
  let currentRoute = route;
  let routeProjectId = readRouteNodeProjectId(currentRoute);

  while (currentRoute.firstChild) {
    currentRoute = currentRoute.firstChild;
    routeProjectId = readRouteNodeProjectId(currentRoute) ?? routeProjectId;
  }

  return routeProjectId;
}

function readRouteNodeProjectId(route: WorkspaceShellRouteNodeLike): string | null {
  const projectId = route.snapshot.params['projectId'];
  return typeof projectId === 'string' && projectId.length > 0 ? projectId : null;
}
