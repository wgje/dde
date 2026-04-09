import { Injector } from '@angular/core';
import * as go from 'gojs';
import { beforeEach, describe, expect, it } from 'vitest';
import { getFlowStyles } from '../../../../config/flow-styles';
import { LineageColorService } from '../../../../services/lineage-color.service';
import { ThemeService } from '../../../../services/theme.service';
import { Project, Task } from '../../../../models';
import { FlowDiagramConfigService } from './flow-diagram-config.service';

function createTask(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    title: overrides.title,
    content: overrides.content ?? '',
    stage: Object.prototype.hasOwnProperty.call(overrides, 'stage')
      ? (overrides.stage ?? null)
      : 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 100,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayId: overrides.displayId ?? '1',
    attachments: overrides.attachments ?? [],
    tags: overrides.tags ?? [],
  } as Task;
}

function createProject(tasks: Task[]): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-1',
    name: 'Test Project',
    description: '',
    createdDate: now,
    tasks,
    connections: [],
  };
}

describe('FlowDiagramConfigService', () => {
  let service: FlowDiagramConfigService;
  let lineageColorService: LineageColorService;

  beforeEach(() => {
    const injector = Injector.create({
      providers: [
        { provide: FlowDiagramConfigService, useClass: FlowDiagramConfigService },
        { provide: LineageColorService, useClass: LineageColorService },
        {
          provide: ThemeService,
          useValue: {
            theme: () => 'default',
            isDark: () => false,
          },
        },
      ],
    });

    service = injector.get(FlowDiagramConfigService);
    lineageColorService = injector.get(LineageColorService);
  });

  it('uses a darker family color for assigned displayId cues', () => {
    const task = createTask({ id: 'root-task', title: 'Root Task', stage: 1, displayId: '1' });
    const result = service.buildDiagramData(
      [task],
      createProject([task]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    const node = result.nodeDataArray[0];
    expect(node.displayIdColor).toBe(lineageColorService.getDarkerFamilyColor(node.familyColor!));
  });

  it('keeps the default displayId color for search matches and unassigned nodes', () => {
    const searchTask = createTask({ id: 'search-task', title: 'Alpha root', stage: 1, displayId: '1' });
    const unassignedTask = createTask({ id: 'floating-task', title: 'Floating', stage: null, displayId: '?' });
    const styles = getFlowStyles('default', 'light');
    const result = service.buildDiagramData(
      [searchTask, unassignedTask],
      createProject([searchTask, unassignedTask]),
      'alpha',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    const searchNode = result.nodeDataArray.find(node => node.key === 'search-task');
    const unassignedNode = result.nodeDataArray.find(node => node.key === 'floating-task');

    expect(searchNode?.isSearchMatch).toBe(true);
    expect(searchNode?.displayIdColor).toBe(styles.text.displayIdColor);
    expect(unassignedNode?.isUnassigned).toBe(true);
    expect(unassignedNode?.displayIdColor).toBe(styles.text.displayIdColor);
  });
});