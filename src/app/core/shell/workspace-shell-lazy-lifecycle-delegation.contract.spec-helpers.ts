import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from 'vitest';

import {
  readCallOptionsFromSource,
  readWorkspaceShellBaseSurfacesSource,
  readWorkspaceShellInteractionSurfacesCallOptions,
  readWorkspaceShellLifecycleGraphCallOptions,
  readWorkspaceShellSessionRoutingSurfaceCallOptions,
  readWorkspaceShellStartupTemplateSurfacesCallOptions,
  readWorkspaceShellLifecycleSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

export {
  readWorkspaceShellBaseSurfacesSource,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellLifecycleGraphSource,
  readWorkspaceShellSessionRoutingSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

export function readLazyLifecycleGroupSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-lazy-lifecycle-group.controller.ts'),
    'utf8',
  );
}

export function readStartupEntryControllersFactorySource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-startup-entry-controllers.factory.ts'),
    'utf8',
  );
}

export function readChromeSurfaceSource(): string {
  return readFileSync(
    join(process.cwd(), 'src/app/core/shell/workspace-shell-chrome-surface.factory.ts'),
    'utf8',
  );
}

export function readWorkspaceShellSessionLifecycleSurfaceSource(): string {
  return readFileSync(
    join(
      process.cwd(),
      'src/app/core/shell/workspace-shell-session-lifecycle-surface.factory.ts',
    ),
    'utf8',
  );
}

function readSessionLifecycleSurfaceOptionsBlock(): string {
  return readWorkspaceShellLifecycleGraphCallOptions(
    'createWorkspaceShellSessionLifecycleSurface',
  );
}

export function readWorkspaceShellNgOnInitBody(): string {
  const source = readWorkspaceShellSource();
  const match = source.match(/\n\s+ngOnInit\(\) \{(?<body>[\s\S]*?)\n\s+\}\n\n\s+ngAfterViewInit/);
  expect(match?.groups?.body).toBeDefined();
  return match?.groups?.body ?? '';
}

export function readNgOnInitStartupOptionsBlock(): string {
  return readWorkspaceShellLifecycleGraphCallOptions(
    'createWorkspaceShellLifecycleSurface',
  );
}

export function readShellLifecycleDelegatesOptionsBlock(): string {
  return readWorkspaceShellLifecycleGraphCallOptions(
    'createWorkspaceShellLifecycleSurface',
  );
}

export function readDestroyControllerOptionsBlock(): string {
  return readWorkspaceShellLifecycleGraphCallOptions(
    'createWorkspaceShellLifecycleSurface',
  );
}

export function readInteractionLazyLoadOptionsBlock(): string {
  return readWorkspaceShellInteractionSurfacesCallOptions(
    'createWorkspaceShellInteractionBoundarySurface',
  );
}

export function readStartupEntryControllersOptionsBlock(): string {
  return readWorkspaceShellStartupTemplateSurfacesCallOptions(
    'createWorkspaceShellStartupEntrySurface',
  );
}

export function readBeforeUnloadOptionsBlock(): string {
  return readWorkspaceShellSessionRoutingSurfaceCallOptions(
    'createWorkspaceShellSessionExitSurface',
  );
}

export function readSidebarToggleOptionsBlock(): string {
  const source = readWorkspaceShellLifecycleSurfaceSource();
  const match = source.match(
    /create(?:WorkspaceShell)?SidebarToggleEventController\(\{(?<body>[\s\S]*?)\n\s+\}\);/,
  );
  expect(match?.groups?.body).toBeDefined();
  return match?.groups?.body ?? '';
}

export function readSignalEffectsOptionsBlock(): string {
  return readSessionLifecycleSurfaceOptionsBlock();
}

export function readRemoteCallbacksOptionsBlock(): string {
  return readSessionLifecycleSurfaceOptionsBlock();
}

export function readProjectSubscriptionOptionsBlock(): string {
  return readSessionLifecycleSurfaceOptionsBlock();
}

export function readSessionLaunchOptionsBlock(): string {
  return readSessionLifecycleSurfaceOptionsBlock();
}

export function readStorageEscapeOptionsBlock(): string {
  return readWorkspaceShellSessionRoutingSurfaceCallOptions(
    'createWorkspaceShellStorageEscapeDelegates',
  );
}

export function readFocusSyncOptionsBlock(): string {
  return readWorkspaceShellSessionRoutingSurfaceCallOptions(
    'createWorkspaceShellFocusSyncSurface',
  );
}

export function readFloatingNoticeChromeOptionsBlock(): string {
  const source = readChromeSurfaceSource();
  const match = source.match(
    /createWorkspaceShellFloatingNoticeChrome\(\{(?<body>[\s\S]*?)\n\s+\}\)[,;]/,
  );
  expect(match?.groups?.body).toBeDefined();
  return match?.groups?.body ?? '';
}

export function readToolControllersOptionsBlock(): string {
  return readCallOptionsFromSource(
    readWorkspaceShellBaseSurfacesSource(),
    'createWorkspaceShellToolSurface',
    'base surfaces',
  );
}

export function readCriticalFeatureFlagsOptionsBlock(): string {
  const source = readWorkspaceShellSource();
  const match = source.match(
    /createWorkspaceShellCriticalFeatureFlagsDelegates\(\{(?<body>[\s\S]*?)\n\s+\}\);/,
  );
  expect(match?.groups?.body).toBeDefined();
  return match?.groups?.body ?? '';
}
