import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readWorkspaceShellSource(): string {
  return readFileSync(join(process.cwd(), 'src/workspace-shell.component.ts'), 'utf8');
}

export function readWorkspaceShellLifecycleSurfaceSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-lifecycle-surface.factory.ts'),
    'utf8',
  );
}

export function readWorkspaceShellLifecycleGraphSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-lifecycle-graph.factory.ts'),
    'utf8',
  );
}

export function readWorkspaceShellBaseSurfacesSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-base-surfaces.factory.ts'),
    'utf8',
  );
}

export function readWorkspaceShellControllerGraphSource(): string {
  return readWorkspaceShellControllerGraphBuilderSource();
}

export function readWorkspaceShellControllerGraphBuilderSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-controller-graph-builder.factory.ts'),
    'utf8',
  );
}

export function readWorkspaceShellPublicControllerGraphSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-controller-graph.factory.ts'),
    'utf8',
  );
}

export function readWorkspaceShellInteractionSurfacesSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-interaction-surfaces.factory.ts'),
    'utf8',
  );
}

export function readWorkspaceShellInteractionSurfaceSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-interaction-surface.factory.ts'),
    'utf8',
  );
}

export function readWorkspaceShellSessionRoutingSurfaceSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-session-routing-surface.factory.ts'),
    'utf8',
  );
}

export function readWorkspaceShellSessionLifecycleSurfaceSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-session-lifecycle-surface.factory.ts'),
    'utf8',
  );
}

export function readWorkspaceShellStartupTemplateSurfacesSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-startup-template-surfaces.factory.ts'),
    'utf8',
  );
}

export function readWorkspaceShellTemplateSurfaceSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-template-surface.factory.ts'),
    'utf8',
  );
}

export function readWorkspaceShellChromeSurfaceSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-chrome-surface.factory.ts'),
    'utf8',
  );
}

export function readCallOptionsFromSource(
  source: string,
  callName: string,
  sourceLabel = 'source',
): string {
  const pattern = new RegExp(
    `${escapeRegExp(callName)}\\(\\{(?<body>[\\s\\S]*?)\\n\\s+\\}\\)[,;]`,
  );
  const match = source.match(pattern);
  if (!match?.groups?.body) {
    throw new Error(`Unable to find ${callName} options in ${sourceLabel}`);
  }
  return match.groups.body;
}

export function readWorkspaceShellControllerGraphCallOptions(
  callName: string,
): string {
  return readCallOptionsFromSource(
    readWorkspaceShellControllerGraphSource(),
    callName,
    'controller graph',
  );
}

export function readWorkspaceShellLifecycleGraphCallOptions(
  callName: string,
): string {
  return readCallOptionsFromSource(
    readWorkspaceShellLifecycleGraphSource(),
    callName,
    'lifecycle graph',
  );
}

export function readWorkspaceShellInteractionSurfacesCallOptions(
  callName: string,
): string {
  return readCallOptionsFromSource(
    readWorkspaceShellInteractionSurfacesSource(),
    callName,
    'interaction surfaces',
  );
}

export function readWorkspaceShellInteractionSurfaceCallOptions(
  callName: string,
): string {
  return readCallOptionsFromSource(
    readWorkspaceShellInteractionSurfaceSource(),
    callName,
    'interaction surface',
  );
}

export function readWorkspaceShellSessionRoutingSurfaceCallOptions(
  callName: string,
): string {
  return readCallOptionsFromSource(
    readWorkspaceShellSessionRoutingSurfaceSource(),
    callName,
    'session routing surface',
  );
}

export function readWorkspaceShellSessionLifecycleSurfaceCallOptions(
  callName: string,
): string {
  return readCallOptionsFromSource(
    readWorkspaceShellSessionLifecycleSurfaceSource(),
    callName,
    'session lifecycle surface',
  );
}

export function readWorkspaceShellStartupTemplateSurfacesCallOptions(
  callName: string,
): string {
  return readCallOptionsFromSource(
    readWorkspaceShellStartupTemplateSurfacesSource(),
    callName,
    'startup template surfaces',
  );
}

export function readWorkspaceShellTemplateSurfaceCallOptions(
  callName: string,
): string {
  return readCallOptionsFromSource(
    readWorkspaceShellTemplateSurfaceSource(),
    callName,
    'template surface',
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function readWorkspaceShellTemplate(): string {
  return readFileSync(join(process.cwd(), 'src/workspace-shell.component.html'), 'utf8');
}
