import { Injector } from '@angular/core';
import * as go from 'gojs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFlowStyles } from '../../../../config/flow-styles';
import { LineageColorService } from '../../../../services/lineage-color.service';
import { LayoutService } from '../../../../services/layout.service';
import { LoggerService } from '../../../../services/logger.service';
import { ThemeService } from '../../../../services/theme.service';
import { ToastService } from '../../../../services/toast.service';
import { Connection, Project, Task } from '../../../../models';
import { ExternalSourceLinkService } from '../../../core/external-sources/external-source-link.service';
import type { ExternalSourceLink } from '../../../core/external-sources/external-source.model';
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
    priority: overrides.priority,
    dueDate: overrides.dueDate ?? null,
    expected_minutes: overrides.expected_minutes ?? null,
    wait_minutes: overrides.wait_minutes ?? null,
    cognitive_load: overrides.cognitive_load ?? null,
    parkingMeta: overrides.parkingMeta ?? null,
    attentionMeta: overrides.attentionMeta ?? null,
  } as Task;
}

function createProject(tasks: Task[], connections: Connection[] = []): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-1',
    name: 'Test Project',
    description: '',
    createdDate: now,
    tasks,
    connections,
  };
}

function expectEmbeddedCrossTreeLinks(linkDataArray: go.ObjectData[], expectedCount: number): void {
  const crossTreeLinks = linkDataArray.filter(link => link.isCrossTree);
  expect(crossTreeLinks).toHaveLength(expectedCount);
  expect(crossTreeLinks.every(link => link.labelSegmentOffsetY === 0)).toBe(true);

  const fractions = crossTreeLinks.map(link => link.labelSegmentFraction);
  expect(new Set(fractions).size).toBe(expectedCount);
  expect(fractions.every((fraction): fraction is number => typeof fraction === 'number' && fraction > 0 && fraction < 1)).toBe(true);
}

function createSiyuanLink(
  overrides: Pick<ExternalSourceLink, 'id' | 'taskId' | 'targetId' | 'createdAt'>
    & Partial<Omit<ExternalSourceLink, 'id' | 'taskId' | 'targetId' | 'createdAt'>>,
): ExternalSourceLink {
  return {
    id: overrides.id,
    taskId: overrides.taskId,
    sourceType: 'siyuan-block',
    targetId: overrides.targetId,
    uri: overrides.uri ?? `siyuan://blocks/${overrides.targetId}?focus=1`,
    label: overrides.label ?? `思源 ${overrides.targetId}`,
    role: overrides.role,
    sortOrder: overrides.sortOrder ?? 0,
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt ?? overrides.createdAt,
  };
}

describe('FlowDiagramConfigService', () => {
  let service: FlowDiagramConfigService;
  let lineageColorService: LineageColorService;
  let activeLinksByTask = new Map<string, ExternalSourceLink[]>();

  beforeEach(() => {
    activeLinksByTask = new Map<string, ExternalSourceLink[]>();
    const injector = Injector.create({
      providers: [
        { provide: FlowDiagramConfigService, useClass: FlowDiagramConfigService },
        { provide: LayoutService, useClass: LayoutService },
        { provide: LineageColorService, useClass: LineageColorService },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
          },
        },
        { provide: ToastService, useValue: { warning: vi.fn(), error: vi.fn() } },
        {
          provide: ExternalSourceLinkService,
          useValue: {
            activeLinksForTask: (taskId: string) => activeLinksByTask.get(taskId) ?? [],
            firstActiveLinkForTask: (taskId: string) => (activeLinksByTask.get(taskId) ?? [])[0] ?? null,
          },
        },
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

  it('renumbers assigned task blocks when displayId is missing', () => {
    const root = createTask({ id: 'missing-root-display-id', title: 'Missing Root Number', stage: 1, displayId: '' });
    const child = createTask({
      id: 'missing-child-display-id',
      title: 'Missing Child Number',
      stage: 2,
      parentId: root.id,
      rank: 200,
      displayId: '',
    });
    const result = service.buildDiagramData(
      [root, child],
      createProject([root, child]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );
    const rootNode = result.nodeDataArray.find(node => node.key === root.id);
    const childNode = result.nodeDataArray.find(node => node.key === child.id);

    expect(rootNode?.displayId).toBe('1');
    expect(childNode?.displayId).toBe('1,a');
    expect(rootNode?.parentId).toBeNull();
    expect(rootNode?.status).toBe('active');
  });

  it('renumbers assigned task blocks when displayId is still the placeholder', () => {
    const root = createTask({ id: 'placeholder-root-display-id', title: 'Placeholder Root Number', stage: 1, displayId: '?' });
    const child = createTask({
      id: 'placeholder-child-display-id',
      title: 'Placeholder Child Number',
      stage: 2,
      parentId: root.id,
      rank: 200,
      displayId: '?',
    });
    const result = service.buildDiagramData(
      [root, child],
      createProject([root, child]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expect(result.nodeDataArray.find(node => node.key === root.id)?.displayId).toBe('1');
    expect(result.nodeDataArray.find(node => node.key === child.id)?.displayId).toBe('1,a');
  });

  it('adds derived sidecar summaries to node data without adding annotation links', () => {
    const source = createTask({
      id: 'sidecar-source',
      title: 'Sidecar Source',
      content: '- [ ] 确认接口字段',
      priority: 'high',
      wait_minutes: 20,
      cognitive_load: 'high',
      tags: ['需联调'],
      displayId: '1',
    });
    const target = createTask({ id: 'sidecar-target', title: 'Sidecar Target', stage: 2, displayId: '2' });
    const child = createTask({
      id: 'sidecar-child',
      title: 'Sidecar Child',
      stage: 2,
      parentId: source.id,
      displayId: '1,a',
    });
    activeLinksByTask.set(source.id, [
      createSiyuanLink({
        id: 'sidecar-link',
        taskId: source.id,
        targetId: '20260605112233-sidecar',
        createdAt: '2026-06-05T00:00:00.000Z',
      }),
    ]);
    const connections: Connection[] = [
      { id: 'sidecar-cross', source: source.id, target: target.id, title: '跨树关联' },
    ];

    const result = service.buildDiagramData(
      [source, target, child],
      createProject([source, target, child], connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>([source.id]), focusedTaskId: null },
    );

    const sourceNode = result.nodeDataArray.find(node => node.key === source.id);
    expect(sourceNode?.sidecarBadgeText).toBe('风险1 · 等待20m · 高负荷 · 资料1');
    expect(sourceNode?.sidecarExpanded).toBe(false);
    expect(sourceNode?.sidecarTopVisible).toBe(false);
    expect(sourceNode?.sidecarRightVisible).toBe(false);
    expect(sourceNode?.sidecarBottomVisible).toBe(false);
    expect(sourceNode?.sidecarLeftVisible).toBe(false);
    expect(sourceNode?.sidecarBadgeItems?.map(item => item.label)).toEqual([
      '风险1',
      '等待20m',
      '高负荷',
      '资料1',
      '需联调',
    ]);
    expect(sourceNode?.sidecarTopBadgeItems?.map(item => item.label)).toEqual(['高负荷']);
    expect(sourceNode?.sidecarRightBadgeItems?.map(item => item.label)).toEqual(['风险1', '等待20m']);
    expect(sourceNode?.sidecarBottomBadgeItems?.map(item => item.label)).toEqual(['需联调']);
    expect(sourceNode?.sidecarLeftBadgeItems?.map(item => item.label)).toEqual(['资料1']);
    expect(sourceNode?.sidecarTooltipText).not.toContain('关联：1 个');
    expect(sourceNode?.sidecarTooltipText).toContain('资料：1 个');
    expect(result.linkDataArray).toHaveLength(2);
  });

  it('marks remembered sidecar tasks as expanded in node data', () => {
    const task = createTask({ id: 'expanded-sidecar-task', title: 'Expanded Sidecar', priority: 'high', displayId: '1' });

    const result = service.buildDiagramData(
      [task],
      createProject([task]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
      { relationDisplayMode: 'all', focusedTaskId: null },
      new Set<string>([task.id]),
    );

    expect(result.nodeDataArray[0]?.sidecarExpanded).toBe(true);
    expect(result.nodeDataArray[0]?.sidecarRightVisible).toBe(true);
  });

  it('can hide cross-tree relation links without adding relation sidecar badges', () => {
    const source = createTask({ id: 'noise-source', title: 'Noise Source', stage: 1, displayId: '1' });
    const target = createTask({ id: 'noise-target', title: 'Noise Target', stage: 2, displayId: '2' });
    const child = createTask({ id: 'noise-child', title: 'Noise Child', stage: 2, parentId: source.id, displayId: '1,a' });
    const connections: Connection[] = [
      { id: 'noise-cross', source: source.id, target: target.id, title: '跨树关联' },
    ];

    const result = service.buildDiagramData(
      [source, target, child],
      createProject([source, target, child], connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
      { relationDisplayMode: 'hidden', focusedTaskId: null },
    );

    expect(result.linkDataArray).toEqual([
      expect.objectContaining({ key: `${source.id}-${child.id}`, isCrossTree: false }),
    ]);
    expect(result.nodeDataArray.find(node => node.key === source.id)?.sidecarHasSignals).toBe(false);
    expect(result.nodeDataArray.find(node => node.key === target.id)?.sidecarHasSignals).toBe(false);
  });

  it('distributes all manual attention badges around the node with per-chip hover text', () => {
    const task = createTask({
      id: 'manual-attention-heavy',
      title: 'Manual Attention Heavy',
      displayId: '1',
      attentionMeta: {
        items: Array.from({ length: 5 }, (_, index) => ({
          id: `attention-${index + 1}`,
          text: `注意事项 ${index + 1}`,
          level: 'info' as const,
          done: false,
          createdAt: '2026-06-06T00:00:00.000Z',
          updatedAt: '2026-06-06T00:00:00.000Z',
        })),
        updatedAt: '2026-06-06T00:00:00.000Z',
      },
    });

    const result = service.buildDiagramData(
      [task],
      createProject([task]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    const node = result.nodeDataArray[0];
    expect(node?.sidecarBadgeItems?.map(item => item.label)).toEqual(['注意1', '注意2', '注意3', '注意4', '注意5']);
    expect(node?.sidecarBadgeItems?.map(item => item.cue)).toEqual(['1', '2', '3', '4', '5']);
    expect(node?.sidecarBadgeItems?.map(item => item.tooltipText)).toEqual([
      '注意事项 1',
      '注意事项 2',
      '注意事项 3',
      '注意事项 4',
      '注意事项 5',
    ]);
    expect(node?.sidecarTopBadgeItems?.map(item => item.label)).toEqual(['注意3']);
    expect(node?.sidecarRightBadgeItems?.map(item => item.label)).toEqual(['注意1', '注意2']);
    expect(node?.sidecarBottomBadgeItems?.map(item => item.label)).toEqual(['注意5']);
    expect(node?.sidecarLeftBadgeItems?.map(item => item.label)).toEqual(['注意4']);
  });

  it('can focus cross-tree relation links around the selected task', () => {
    const selected = createTask({ id: 'selected-task', title: 'Selected', stage: 1, displayId: '1' });
    const related = createTask({ id: 'related-task', title: 'Related', stage: 2, displayId: '2' });
    const unrelatedA = createTask({ id: 'unrelated-a', title: 'Unrelated A', stage: 2, displayId: '3' });
    const unrelatedB = createTask({ id: 'unrelated-b', title: 'Unrelated B', stage: 3, displayId: '4' });
    const tasks = [selected, related, unrelatedA, unrelatedB];
    const connections: Connection[] = [
      { id: 'selected-cross', source: selected.id, target: related.id, title: '相关' },
      { id: 'unrelated-cross', source: unrelatedA.id, target: unrelatedB.id, title: '不相关' },
    ];

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
      { relationDisplayMode: 'focused', focusedTaskId: selected.id },
    );

    const crossTreeLinks = result.linkDataArray.filter(link => link.isCrossTree);
    expect(crossTreeLinks).toEqual([
      expect.objectContaining({ key: `cross-${selected.id}-${related.id}` }),
    ]);
    expect(result.nodeDataArray.find(node => node.key === unrelatedA.id)?.sidecarHasSignals).toBe(false);
  });

  it('keeps cross-tree relation blocks embedded by staggering repeated stage-boundary links along the line', () => {
    const tasks = [
      createTask({ id: 'left-a', title: 'Left A', stage: 1, displayId: '1' }),
      createTask({ id: 'left-b', title: 'Left B', stage: 1, displayId: '2' }),
      createTask({ id: 'right-a', title: 'Right A', stage: 2, displayId: '3' }),
      createTask({ id: 'right-b', title: 'Right B', stage: 2, displayId: '4' }),
    ];
    const connections: Connection[] = [
      { id: 'conn-a', source: 'left-a', target: 'right-a', title: 'A->A' },
      { id: 'conn-b', source: 'left-b', target: 'right-b', title: 'B->B' },
    ];

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expectEmbeddedCrossTreeLinks(result.linkDataArray, 2);
    const fractions = result.linkDataArray
      .filter(link => link.isCrossTree)
      .map(link => link.labelSegmentFraction as number);
    expect(fractions.every(fraction => fraction > 0.5)).toBe(true);
  });

  it('places a single cross-tree relation block near the target-side third of the line', () => {
    const tasks = [
      createTask({ id: 'source-task', title: 'Source', stage: 1, displayId: '1' }),
      createTask({ id: 'target-task', title: 'Target', stage: 2, displayId: '2' }),
    ];
    const connections: Connection[] = [
      { id: 'target-side-conn', source: 'source-task', target: 'target-task', title: 'Near Target' },
    ];

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    const crossTreeLink = result.linkDataArray.find(link => link.isCrossTree);
    expect(crossTreeLink?.labelSegmentFraction).toBeCloseTo(2 / 3, 6);
    expect(crossTreeLink?.labelSegmentOffsetY).toBe(0);
  });

  it('keeps reverse cross-tree relation blocks near the target side instead of the stage midpoint', () => {
    const tasks = [
      createTask({ id: 'late-source', title: 'Late Source', stage: 3, displayId: '1' }),
      createTask({ id: 'early-target', title: 'Early Target', stage: 1, displayId: '2' }),
    ];
    const connections: Connection[] = [
      { id: 'reverse-conn', source: 'late-source', target: 'early-target', title: 'Reverse' },
    ];

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    const crossTreeLink = result.linkDataArray.find(link => link.isCrossTree);
    expect(crossTreeLink?.labelSegmentFraction).toBeCloseTo(2 / 3, 6);
  });

  it('keeps same-stage cross-tree relation blocks embedded by spreading them along the link instead of lifting them away', () => {
    const tasks = [
      createTask({ id: 'same-a', title: 'Same A', stage: 2, displayId: '1' }),
      createTask({ id: 'same-b', title: 'Same B', stage: 2, displayId: '2' }),
      createTask({ id: 'same-c', title: 'Same C', stage: 2, displayId: '3' }),
      createTask({ id: 'same-d', title: 'Same D', stage: 2, displayId: '4' }),
    ];
    const connections: Connection[] = [
      { id: 'same-conn-a', source: 'same-a', target: 'same-c', title: 'A->C' },
      { id: 'same-conn-b', source: 'same-b', target: 'same-d', title: 'B->D' },
    ];

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expectEmbeddedCrossTreeLinks(result.linkDataArray, 2);
  });

  it('keeps dense stage-boundary relation blocks unique without lifting them away from the link', () => {
    const tasks = Array.from({ length: 8 }, (_, index) => [
      createTask({ id: `left-${index}`, title: `Left ${index}`, stage: 1, displayId: `${index + 1}` }),
      createTask({ id: `right-${index}`, title: `Right ${index}`, stage: 2, displayId: `${index + 9}` }),
    ]).flat();
    const connections: Connection[] = Array.from({ length: 8 }, (_, index) => ({
      id: `dense-boundary-${index}`,
      source: `left-${index}`,
      target: `right-${index}`,
      title: `Dense ${index}`,
    }));

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expectEmbeddedCrossTreeLinks(result.linkDataArray, 8);
  });

  it('keeps dense same-stage relation blocks unique without lifting them away from the link', () => {
    const tasks = Array.from({ length: 6 }, (_, index) => [
      createTask({ id: `same-source-${index}`, title: `Same Source ${index}`, stage: 2, displayId: `${index + 1}` }),
      createTask({ id: `same-target-${index}`, title: `Same Target ${index}`, stage: 2, displayId: `${index + 7}` }),
    ]).flat();
    const connections: Connection[] = Array.from({ length: 6 }, (_, index) => ({
      id: `dense-same-${index}`,
      source: `same-source-${index}`,
      target: `same-target-${index}`,
      title: `Same ${index}`,
    }));

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expectEmbeddedCrossTreeLinks(result.linkDataArray, 6);
  });

  it('keeps link route inputs stable when task and connection arrays are rehydrated in a different order', () => {
    const tasks = [
      createTask({ id: 'root-a', title: 'Root A', stage: 1, rank: 10, displayId: '1' }),
      createTask({ id: 'child-a', title: 'Child A', stage: 2, parentId: 'root-a', rank: 20, displayId: '1,1' }),
      createTask({ id: 'root-b', title: 'Root B', stage: 1, rank: 30, displayId: '2' }),
      createTask({ id: 'child-b', title: 'Child B', stage: 2, parentId: 'root-b', rank: 40, displayId: '2,1' }),
    ];
    const connections: Connection[] = [
      { id: 'conn-b', source: 'root-b', target: 'child-a', title: 'B to A' },
      { id: 'conn-a', source: 'root-a', target: 'child-b', title: 'A to B' },
    ];

    const first = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );
    const second = service.buildDiagramData(
      [...tasks].reverse(),
      createProject([...tasks].reverse(), [...connections].reverse()),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    const toRouteInputs = (links: typeof first.linkDataArray) => links.map(link => ({
      key: link.key,
      from: link.from,
      to: link.to,
      isCrossTree: link.isCrossTree,
      curviness: link.curviness,
      labelSegmentFraction: link.labelSegmentFraction,
    }));

    expect(toRouteInputs(second.linkDataArray)).toEqual(toRouteInputs(first.linkDataArray));
    expect(first.linkDataArray.every(link => typeof link.curviness === 'number')).toBe(true);
  });

  it('keeps long-span edge-boundary relation blocks unique without lifting them away from the link', () => {
    const tasks = Array.from({ length: 2 }, (_, index) => [
      createTask({ id: `far-left-${index}`, title: `Far Left ${index}`, stage: 1, displayId: `${index + 1}` }),
      createTask({ id: `far-right-${index}`, title: `Far Right ${index}`, stage: 11, displayId: `${index + 3}` }),
    ]).flat();
    const connections: Connection[] = Array.from({ length: 2 }, (_, index) => ({
      id: `far-span-${index}`,
      source: `far-left-${index}`,
      target: `far-right-${index}`,
      title: `Far ${index}`,
    }));

    const result = service.buildDiagramData(
      tasks,
      createProject(tasks, connections),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expectEmbeddedCrossTreeLinks(result.linkDataArray, 2);
  });

  it('uses the project-level SiYuan link order for badges across tasks', () => {
    const firstTask = createTask({ id: 'first-task-with-siyuan', title: 'First Knowledge Task', stage: 1, displayId: '1' });
    const secondTask = createTask({ id: 'second-task-with-siyuan', title: 'Second Knowledge Task', stage: 1, displayId: '2' });
    activeLinksByTask.set(firstTask.id, [
      createSiyuanLink({
        id: 'project-link-first',
        taskId: firstTask.id,
        targetId: '20260426123456-abc1234',
        createdAt: '2026-05-28T12:00:00.000Z',
      }),
    ]);
    activeLinksByTask.set(secondTask.id, [
      createSiyuanLink({
        id: 'project-link-second',
        taskId: secondTask.id,
        targetId: '20260426123456-def5678',
        createdAt: '2026-05-28T12:01:00.000Z',
      }),
    ]);

    const result = service.buildDiagramData(
      [secondTask, firstTask],
      createProject([secondTask, firstTask]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expect(result.nodeDataArray.find(node => node.key === firstTask.id)?.siyuanLinkBadgeIndex).toBe(1);
    expect(result.nodeDataArray.find(node => node.key === secondTask.id)?.siyuanLinkBadgeIndex).toBe(2);
  });

  it('numbers only flow-visible SiYuan badges so hidden task links do not create gaps', () => {
    const firstTask = createTask({ id: 'task-with-two-siyuan-links', title: 'Two Links', stage: 1, displayId: '1' });
    const secondTask = createTask({ id: 'task-with-visible-second-badge', title: 'Second Badge', stage: 1, displayId: '2' });
    activeLinksByTask.set(firstTask.id, [
      createSiyuanLink({
        id: 'visible-link-first-task',
        taskId: firstTask.id,
        targetId: '20260426123456-abc1234',
        createdAt: '2026-05-28T12:00:00.000Z',
      }),
      createSiyuanLink({
        id: 'hidden-link-first-task',
        taskId: firstTask.id,
        targetId: '20260426123456-def5678',
        sortOrder: 1,
        createdAt: '2026-05-28T12:01:00.000Z',
      }),
    ]);
    activeLinksByTask.set(secondTask.id, [
      createSiyuanLink({
        id: 'visible-link-second-task',
        taskId: secondTask.id,
        targetId: '20260426123456-ghi9012',
        createdAt: '2026-05-28T12:02:00.000Z',
      }),
    ]);

    const result = service.buildDiagramData(
      [firstTask, secondTask],
      createProject([firstTask, secondTask]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expect(result.nodeDataArray.find(node => node.key === firstTask.id)?.siyuanLinkBadgeIndex).toBe(1);
    expect(result.nodeDataArray.find(node => node.key === secondTask.id)?.siyuanLinkBadgeIndex).toBe(2);
  });

  it('normalizes linked-at timestamps before assigning project-level SiYuan badge order', () => {
    const firstTask = createTask({ id: 'timezone-first-task', title: 'Timezone First', stage: 1, displayId: '1' });
    const secondTask = createTask({ id: 'timezone-second-task', title: 'Timezone Second', stage: 1, displayId: '2' });
    activeLinksByTask.set(firstTask.id, [
      createSiyuanLink({
        id: 'timezone-link-first',
        taskId: firstTask.id,
        targetId: '20260426123456-abc1234',
        createdAt: '2026-05-28T12:00:00.000+08:00',
      }),
    ]);
    activeLinksByTask.set(secondTask.id, [
      createSiyuanLink({
        id: 'timezone-link-second',
        taskId: secondTask.id,
        targetId: '20260426123456-def5678',
        createdAt: '2026-05-28T05:00:00.000Z',
      }),
    ]);

    const result = service.buildDiagramData(
      [secondTask, firstTask],
      createProject([secondTask, firstTask]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expect(result.nodeDataArray.find(node => node.key === firstTask.id)?.siyuanLinkBadgeIndex).toBe(1);
    expect(result.nodeDataArray.find(node => node.key === secondTask.id)?.siyuanLinkBadgeIndex).toBe(2);
  });

  it('keeps equal-time SiYuan badge order stable across task input order changes', () => {
    const alphaTask = createTask({ id: 'task-alpha-with-siyuan', title: 'Alpha Knowledge', stage: 1, displayId: '1' });
    const betaTask = createTask({ id: 'task-beta-with-siyuan', title: 'Beta Knowledge', stage: 1, displayId: '2' });
    const createdAt = '2026-05-28T12:00:00.000Z';
    activeLinksByTask.set(alphaTask.id, [
      createSiyuanLink({
        id: 'equal-time-alpha-link',
        taskId: alphaTask.id,
        targetId: '20260426123456-abc1234',
        createdAt,
      }),
    ]);
    activeLinksByTask.set(betaTask.id, [
      createSiyuanLink({
        id: 'equal-time-beta-link',
        taskId: betaTask.id,
        targetId: '20260426123456-def5678',
        createdAt,
      }),
    ]);

    const firstBuild = service.buildDiagramData(
      [betaTask, alphaTask],
      createProject([betaTask, alphaTask]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );
    const secondBuild = service.buildDiagramData(
      [alphaTask, betaTask],
      createProject([alphaTask, betaTask]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expect(firstBuild.nodeDataArray.find(node => node.key === alphaTask.id)?.siyuanLinkBadgeIndex).toBe(1);
    expect(firstBuild.nodeDataArray.find(node => node.key === betaTask.id)?.siyuanLinkBadgeIndex).toBe(2);
    expect(secondBuild.nodeDataArray.find(node => node.key === alphaTask.id)?.siyuanLinkBadgeIndex).toBe(1);
    expect(secondBuild.nodeDataArray.find(node => node.key === betaTask.id)?.siyuanLinkBadgeIndex).toBe(2);
  });

  it('uses the visible project active-link index for the SiYuan badge instead of raw sortOrder', () => {
    const task = createTask({ id: 'task-with-siyuan', title: 'Knowledge Task', stage: 1, displayId: '1' });
    activeLinksByTask.set(task.id, [
      createSiyuanLink({
        id: 'link-remaining',
        taskId: task.id,
        targetId: '20260426123456-abc1234',
        sortOrder: 3,
        createdAt: '2026-05-28T12:00:00.000Z',
      }),
    ]);

    const result = service.buildDiagramData(
      [task],
      createProject([task]),
      '',
      new Map<string, go.ObjectData>(),
      { dockedTaskIds: new Set<string>(), focusedTaskId: null },
    );

    expect(result.nodeDataArray[0]?.siyuanLinkBadgeIndex).toBe(1);
  });
});
