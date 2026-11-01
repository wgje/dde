import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ProjectShellComponent } from './project-shell.component';

describe('ProjectShellComponent controller delegation', () => {
  it('delegates startup and teardown to the lifecycle controller', () => {
    const source = readFileSync(
      join(__dirname, 'project-shell.component.ts'),
      'utf8',
    );

    expect(source).toContain('createProjectShellControllerGraph');
    expect(source).toContain(
      'this.shellGraph.controllers.lifecycle.initialize();',
    );
    expect(source).toContain(
      'this.shellGraph.controllers.lifecycle.destroy();',
    );
    expect(source).not.toContain('inject(LocalBackupService)');
    expect(source).not.toContain('takeUntilDestroyed');
    expect(source).not.toContain('NavigationEnd');
  });

  it('delegates new project modal loading without eager service injection', () => {
    const source = readFileSync(
      join(__dirname, 'project-shell.component.ts'),
      'utf8',
    );

    expect(source).toContain(
      'return this.shellGraph.controllers.newProjectModal.open();',
    );
    expect(source).not.toContain('inject(ModalLoaderService)');
    expect(source).not.toContain('inject(DynamicModalService)');
    expect(source).not.toContain('inject(AppProjectCoordinatorService)');
  });

  it('exposes filter state from the UI controller', () => {
    const source = readFileSync(
      join(__dirname, 'project-shell.component.ts'),
      'utf8',
    );

    expect(source).toContain(
      'readonly isFilterOpen = this.shellGraph.template.isFilterOpen;',
    );
    expect(source).toContain(
      'readonly currentFilterLabel = this.shellGraph.template.currentFilterLabel;',
    );
    expect(source).not.toContain('isFilterOpen = signal(');
    expect(source).not.toContain('resolveWorkspaceFilterLabel');
  });

  it('delegates Flow intent activation to its controller', () => {
    const activate = vi.fn();
    const context = {
      shellGraph: { controllers: { flowIntent: { activate } } },
    };

    ProjectShellComponent.prototype.activateFlowIntent.call(context, 'route');

    expect(activate).toHaveBeenCalledWith('route');
  });

  it('delegates Shell UI commands to its controller', () => {
    const uiActions = {
      toggleSidebar: vi.fn(),
      toggleDockFocusSession: vi.fn(),
      toggleTextColumn: vi.fn(),
      expandTextColumnToMin: vi.fn(),
    };
    const context = {
      shellGraph: { controllers: { uiActions } },
    };

    ProjectShellComponent.prototype.toggleSidebar.call(context);
    ProjectShellComponent.prototype.toggleDockFocusSession.call(context);
    ProjectShellComponent.prototype.toggleTextColumn.call(context);
    ProjectShellComponent.prototype.expandTextColumnToMin.call(context);

    expect(uiActions.toggleSidebar).toHaveBeenCalledOnce();
    expect(uiActions.toggleDockFocusSession).toHaveBeenCalledOnce();
    expect(uiActions.toggleTextColumn).toHaveBeenCalledOnce();
    expect(uiActions.expandTextColumnToMin).toHaveBeenCalledOnce();
  });

  it('delegates project view coordination to its controller', () => {
    const source = readFileSync(
      join(__dirname, 'project-shell.component.ts'),
      'utf8',
    );

    expect(source).toContain('createProjectShellControllerGraph');
    expect(source).toContain(
      'this.shellGraph.controllers.viewActions.switchToFlow();',
    );
    expect(source).toContain(
      'this.shellGraph.controllers.viewActions.switchToText();',
    );
    expect(source).toContain(
      'this.shellGraph.controllers.viewActions.focusFlowNode(taskId);',
    );
    expect(source).toContain(
      'this.shellGraph.controllers.viewActions.retryTextView();',
    );
    expect(source).toContain(
      'this.shellGraph.controllers.viewActions.retryFlowView();',
    );
    expect(source).not.toContain('this.flowCommand.centerOnNode(');
    expect(source).not.toContain('this.flowCommand.retryDiagram(');
    expect(source).not.toContain('this.routeController.setActiveView(');
  });

  it('keeps dependency injection and controller construction outside the component', () => {
    const source = readFileSync(
      join(__dirname, 'project-shell.component.ts'),
      'utf8',
    );

    expect(source).not.toContain('inject(');
    expect(source).not.toMatch(/new ProjectShell\w+Controller/);
    expect(source).not.toContain('TaskOperationAdapterService');
    expect(source).not.toContain('SyncCoordinatorService');
    expect(source).not.toContain('UserSessionService');
  });
});
