import { NgZone, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import { LoggerService } from '../../../../services/logger.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { FlowEventService } from './flow-event.service';
import { flowTemplateEventHandlers } from './flow-template-events';

describe('FlowEventService', () => {
  let service: FlowEventService;
  let listeners: Map<string, Array<(event: go.DiagramEvent) => void>>;
  let isMobile: WritableSignal<boolean>;

  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
  };

  beforeEach(() => {
    listeners = new Map();
    isMobile = signal(false);

    TestBed.configureTestingModule({
      providers: [
        FlowEventService,
        { provide: LoggerService, useValue: { category: () => logger } },
        { provide: ProjectStateService, useValue: { activeProjectId: signal('project-1') } },
        { provide: UiStateService, useValue: { isMobile } },
        { provide: NgZone, useValue: new NgZone({ enableLongStackTrace: false }) },
      ],
    });

    service = TestBed.inject(FlowEventService);
  });

  afterEach(() => {
    service.dispose();
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function createDiagram(): go.Diagram {
    return {
      addDiagramListener: vi.fn((name: string, handler: (event: go.DiagramEvent) => void) => {
        const handlers = listeners.get(name) ?? [];
        handlers.push(handler);
        listeners.set(name, handlers);
      }),
      removeDiagramListener: vi.fn((name: string, handler: (event: go.DiagramEvent) => void) => {
        const handlers = listeners.get(name) ?? [];
        listeners.set(name, handlers.filter(candidate => candidate !== handler));
      }),
    } as unknown as go.Diagram;
  }

  function emitDiagramEvent(name: string): void {
    const event = {} as go.DiagramEvent;
    for (const handler of listeners.get(name) ?? []) {
      handler(event);
    }
  }

  function emitSelectionMoved(node: go.Node): void {
    const event = {
      subject: {
        each: (callback: (part: go.Part) => void) => callback(node),
      },
    } as go.DiagramEvent;

    for (const handler of listeners.get('SelectionMoved') ?? []) {
      handler(event);
    }
  }

  function emitObjectClick(name: 'ObjectSingleClicked' | 'ObjectDoubleClicked', part: go.Part): void {
    const event = {
      subject: {
        part,
      },
    } as go.DiagramEvent;

    for (const handler of listeners.get(name) ?? []) {
      handler(event);
    }
  }

  function createLinkPart(diagram: go.Diagram): go.Link {
    const link = new go.Link();
    link.data = { from: 'old-a', to: 'old-b', isCrossTree: true };
    Object.defineProperty(link, 'diagram', {
      configurable: true,
      value: diagram,
    });
    return link;
  }

  function getTimerInternals(): {
    positionSaveTimer: ReturnType<typeof setTimeout> | null;
  } {
    return service as unknown as {
      positionSaveTimer: ReturnType<typeof setTimeout> | null;
    };
  }

  it('keeps the delete key handler alive across diagram teardown and hard-recovery re-init', () => {
    const deleteKey = vi.fn();
    service.onDeleteKey(deleteKey);

    // 首次挂载
    service.setDiagram(createDiagram());
    expect(flowTemplateEventHandlers.onDeleteKeyPressed).toBeTypeOf('function');
    flowTemplateEventHandlers.onDeleteKeyPressed?.();
    expect(deleteKey).toHaveBeenCalledTimes(1);

    // 硬恢复：teardownDiagramForRecovery → setDiagram(null) 清空全局模板处理器
    service.setDiagram(null);
    expect(flowTemplateEventHandlers.onDeleteKeyPressed).toBeUndefined();

    // 原地重建后 setDiagram(newDiagram) 必须重接 Delete 键回调，否则删除键静默失效
    service.setDiagram(createDiagram());
    expect(flowTemplateEventHandlers.onDeleteKeyPressed).toBeTypeOf('function');
    flowTemplateEventHandlers.onDeleteKeyPressed?.();
    expect(deleteKey).toHaveBeenCalledTimes(2);
  });

  it('isolates delete key callback failures from the GoJS key interception path', () => {
    const deleteKey = vi.fn(() => {
      throw new Error('delete handler failed');
    });
    service.onDeleteKey(deleteKey);
    service.setDiagram(createDiagram());

    expect(() => flowTemplateEventHandlers.onDeleteKeyPressed?.()).not.toThrow();
    expect(deleteKey).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not register duplicate diagram listeners when the same diagram is set again', () => {
    const diagram = createDiagram();
    const backgroundClick = vi.fn();

    service.onBackgroundClick(backgroundClick);
    service.setDiagram(diagram);
    service.setDiagram(diagram);
    emitDiagramEvent('BackgroundSingleClicked');

    expect(backgroundClick).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending selection move when the diagram instance changes', () => {
    vi.useFakeTimers();
    const firstDiagram = createDiagram();
    const nextDiagram = createDiagram();
    const selectionMoved = vi.fn();
    const movedNode = new go.Node();

    movedNode.data = { key: 'task-1', stage: 0 };
    movedNode.location = new go.Point(12, 34);

    service.onSelectionMoved(selectionMoved);
    service.setDiagram(firstDiagram);

    emitSelectionMoved(movedNode);
    service.setDiagram(nextDiagram);
    vi.runAllTimers();

    expect(selectionMoved).not.toHaveBeenCalled();
  });

  it('clears a pending selection move timer with handle 0 when the diagram changes', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const firstDiagram = createDiagram();
    const nextDiagram = createDiagram();
    const internal = getTimerInternals();

    service.setDiagram(firstDiagram);
    internal.positionSaveTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    service.setDiagram(nextDiagram);

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(internal.positionSaveTimer).toBeNull();
  });

  it('clears a pending selection move timer with handle 0 before rescheduling', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const diagram = createDiagram();
    const movedNode = new go.Node();
    const internal = getTimerInternals();

    movedNode.data = { key: 'task-1', stage: 0 };
    movedNode.location = new go.Point(12, 34);

    service.setDiagram(diagram);
    internal.positionSaveTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    emitSelectionMoved(movedNode);

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(internal.positionSaveTimer).not.toBe(0);
    expect(internal.positionSaveTimer).not.toBeNull();
  });

  it('clears a pending selection move timer with handle 0 on dispose', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const internal = getTimerInternals();

    internal.positionSaveTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    service.dispose();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(internal.positionSaveTimer).toBeNull();
  });

  it('ignores template node clicks from a stale diagram after the active diagram changes', () => {
    const activeDiagram = createDiagram();
    const staleDiagram = createDiagram();
    const nodeClick = vi.fn();
    const staleNode = {
      data: { key: 'stale-task' },
      diagram: staleDiagram,
    } as unknown as go.Node;

    service.onNodeClick(nodeClick);
    service.setDiagram(activeDiagram);

    flowTemplateEventHandlers.onNodeClick?.(staleNode);

    expect(nodeClick).not.toHaveBeenCalled();
  });

  it('ignores template link clicks from a stale diagram after the active diagram changes', () => {
    const activeDiagram = {
      ...createDiagram(),
      lastInput: { viewPoint: new go.Point(99, 88) },
    } as unknown as go.Diagram;
    const staleDiagram = createDiagram();
    const linkClick = vi.fn();
    const staleLink = {
      data: { from: 'old-a', to: 'old-b' },
      diagram: staleDiagram,
    } as unknown as go.Link;

    service.onLinkClick(linkClick);
    service.setDiagram(activeDiagram);

    flowTemplateEventHandlers.onLinkClick?.(staleLink);

    expect(linkClick).not.toHaveBeenCalled();
  });

  it('ignores template node double clicks from a stale diagram after the active diagram changes', () => {
    const activeDiagram = createDiagram();
    const staleDiagram = createDiagram();
    const nodeClick = vi.fn();
    const staleNode = {
      data: { key: 'stale-task' },
      diagram: staleDiagram,
    } as unknown as go.Node;

    service.onNodeClick(nodeClick);
    service.setDiagram(activeDiagram);

    flowTemplateEventHandlers.onNodeDoubleClick?.(staleNode);

    expect(nodeClick).not.toHaveBeenCalled();
  });

  it('ignores template link delete requests from a stale diagram after the active diagram changes', () => {
    const activeDiagram = createDiagram();
    const staleDiagram = createDiagram();
    const linkDelete = vi.fn();
    const staleLink = {
      data: { from: 'old-a', to: 'old-b' },
      diagram: staleDiagram,
    } as unknown as go.Link;

    service.onLinkDelete(linkDelete);
    service.setDiagram(activeDiagram);

    flowTemplateEventHandlers.onLinkDeleteRequest?.(staleLink);

    expect(linkDelete).not.toHaveBeenCalled();
  });

  it('ignores cross-tree label clicks from a stale diagram after the active diagram changes', () => {
    const activeDiagram = createDiagram();
    const staleDiagram = createDiagram();
    const linkClick = vi.fn();
    const staleLink = {
      data: { from: 'old-a', to: 'old-b', isCrossTree: true },
      diagram: staleDiagram,
    } as unknown as go.Link;

    service.onLinkClick(linkClick);
    service.setDiagram(activeDiagram);

    flowTemplateEventHandlers.onCrossTreeLabelClick?.(staleLink, 12, 34);

    expect(linkClick).not.toHaveBeenCalled();
  });

  it('ignores sidecar toggles from a stale diagram after the active diagram changes', () => {
    const activeDiagram = createDiagram();
    const staleDiagram = createDiagram();
    const sidecarToggle = vi.fn();
    const staleNode = {
      data: { key: 'stale-task' },
      diagram: staleDiagram,
    } as unknown as go.Node;

    service.onSidecarToggle(sidecarToggle);
    service.setDiagram(activeDiagram);

    flowTemplateEventHandlers.onSidecarToggle?.('stale-task', staleNode);

    expect(sidecarToggle).not.toHaveBeenCalled();
  });

  it('ignores mobile object single clicks from a stale diagram after the active diagram changes', () => {
    const activeDiagram = createDiagram();
    const staleDiagram = createDiagram();
    const linkClick = vi.fn();
    const staleLink = createLinkPart(staleDiagram);

    isMobile.set(true);
    service.onLinkClick(linkClick);
    service.setDiagram(activeDiagram);

    emitObjectClick('ObjectSingleClicked', staleLink);

    expect(linkClick).not.toHaveBeenCalled();
  });

  it('ignores mobile object double clicks from a stale diagram after the active diagram changes', () => {
    const activeDiagram = createDiagram();
    const staleDiagram = createDiagram();
    const linkClick = vi.fn();
    const staleLink = createLinkPart(staleDiagram);

    isMobile.set(true);
    service.onLinkClick(linkClick);
    service.setDiagram(activeDiagram);

    emitObjectClick('ObjectDoubleClicked', staleLink);

    expect(linkClick).not.toHaveBeenCalled();
  });

  function createRelinkDiagram(isForwards: boolean): go.Diagram {
    const diagram = createDiagram() as unknown as {
      toolManager?: { relinkingTool?: { isForwards: boolean } };
    };
    diagram.toolManager = { relinkingTool: { isForwards } };
    return diagram as unknown as go.Diagram;
  }

  function createRelinkLink(diagram: go.Diagram, fromKey: string, toKey: string): go.Link {
    const link = new go.Link();
    link.data = { from: fromKey, to: toKey, isCrossTree: false };
    Object.defineProperty(link, 'diagram', { configurable: true, value: diagram });
    Object.defineProperty(link, 'fromNode', { configurable: true, value: { data: { key: fromKey } } });
    Object.defineProperty(link, 'toNode', { configurable: true, value: { data: { key: toKey } } });
    Object.defineProperty(link, 'midPoint', { configurable: true, value: undefined });
    return link;
  }

  function emitLinkRelinked(link: go.Link, disconnectedKey: string): void {
    const event = {
      subject: link,
      parameter: { part: { data: { key: disconnectedKey } } },
    } as unknown as go.DiagramEvent;

    for (const handler of listeners.get('LinkRelinked') ?? []) {
      handler(event);
    }
  }

  it('removes an unresolvable drawn link from the model and warns instead of leaving a ghost edge', () => {
    const removeLinkData = vi.fn();
    const startTransaction = vi.fn();
    const commitTransaction = vi.fn();
    const diagram = createDiagram() as unknown as {
      toolManager?: { linkingTool?: { isActive: boolean } };
      model?: { removeLinkData: typeof removeLinkData; setDataProperty: ReturnType<typeof vi.fn> };
      startTransaction?: typeof startTransaction;
      commitTransaction?: typeof commitTransaction;
    };
    diagram.toolManager = { linkingTool: { isActive: false } };
    diagram.model = { removeLinkData, setDataProperty: vi.fn() };
    diagram.startTransaction = startTransaction;
    diagram.commitTransaction = commitTransaction;
    const linkGesture = vi.fn();
    const ghostLink = new go.Link();
    ghostLink.data = { temp: true };
    Object.defineProperty(ghostLink, 'invalidateRoute', { configurable: true, value: vi.fn() });
    // 端点节点存在但 data.key 缺失 -> 端点 key 无法解析（gojs mock 会为未定义属性自动造 stub，必须显式置空）
    Object.defineProperty(ghostLink, 'fromNode', { configurable: true, value: { data: {} } });
    Object.defineProperty(ghostLink, 'toNode', { configurable: true, value: { data: {} } });

    service.onLinkGesture(linkGesture);
    service.setDiagram(diagram as unknown as go.Diagram, {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    } as unknown as HTMLDivElement);

    for (const handler of listeners.get('LinkDrawn') ?? []) {
      handler({ subject: ghostLink } as unknown as go.DiagramEvent);
    }

    expect(linkGesture).not.toHaveBeenCalled();
    expect(removeLinkData).toHaveBeenCalledWith({ temp: true });
    expect(logger.warn).toHaveBeenCalledWith(
      'LinkDrawn 端点无法解析，已移除未持久化的连接线',
      { linkData: { temp: true } },
    );
  });

  it('warns and skips the store mutation when a relinked link cannot be parsed', () => {
    const diagram = createRelinkDiagram(true);
    const linkRelink = vi.fn();
    const link = createRelinkLink(diagram, 'task-a', 'task-b');

    service.onLinkRelink(linkRelink);
    service.setDiagram(diagram, {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    } as unknown as HTMLDivElement);

    // disconnected part 缺少 key -> relink 上下文无法解析
    const event = {
      subject: link,
      parameter: { part: { data: {} } },
    } as unknown as go.DiagramEvent;
    for (const handler of listeners.get('LinkRelinked') ?? []) {
      handler(event);
    }

    expect(linkRelink).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'LinkRelinked 端点无法解析，跳过 store 变更（画布将在下次刷新时与 store 对齐）',
      { linkData: { from: 'task-a', to: 'task-b', isCrossTree: false } },
    );
  });

  it('classifies a from-end same-port drop-back by relinking tool direction, not endpoint identity', () => {
    // 场景：父子连接 A→B，用户拖起 from 端手柄又放回 A（改主意手势）。
    // disconnected(A) === newFromId(A) 不能被倒推成"to 端变更"，
    // 否则会派发 handleParentChildRelinkToEnd(A, A, B) 并弹出虚假错误 toast
    const diagram = createRelinkDiagram(false);
    const linkRelink = vi.fn();

    service.onLinkRelink(linkRelink);
    service.setDiagram(diagram, {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    } as unknown as HTMLDivElement);

    emitLinkRelinked(createRelinkLink(diagram, 'task-a', 'task-b'), 'task-a');

    expect(linkRelink).toHaveBeenCalledTimes(1);
    expect(linkRelink).toHaveBeenCalledWith(
      'parent-child',
      expect.objectContaining({
        changedEnd: 'from',
        oldFromId: 'task-a',
        oldToId: 'task-b',
        newFromId: 'task-a',
        newToId: 'task-b',
      }),
      expect.any(Number),
      expect.any(Number),
      expect.any(go.Link),
    );
  });

  it('classifies a to-end same-port drop-back by relinking tool direction, not endpoint identity', () => {
    // 场景：拖起 to 端手柄又放回 B。disconnected(B) === newToId(B) 不能被倒推成"from 端变更"，
    // 否则会以错误的 oldFromId=B 派发子树迁移并弹出虚假"任务迁移成功" toast
    const diagram = createRelinkDiagram(true);
    const linkRelink = vi.fn();

    service.onLinkRelink(linkRelink);
    service.setDiagram(diagram, {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    } as unknown as HTMLDivElement);

    emitLinkRelinked(createRelinkLink(diagram, 'task-a', 'task-b'), 'task-b');

    expect(linkRelink).toHaveBeenCalledTimes(1);
    expect(linkRelink).toHaveBeenCalledWith(
      'parent-child',
      expect.objectContaining({
        changedEnd: 'to',
        oldFromId: 'task-a',
        oldToId: 'task-b',
        newFromId: 'task-a',
        newToId: 'task-b',
      }),
      expect.any(Number),
      expect.any(Number),
      expect.any(go.Link),
    );
  });

  it('classifies a genuine to-end relink correctly when the target actually changed', () => {
    // 场景：A→B 的 to 端拖到 C：changedEnd='to'，oldTo=B(disconnected)、newTo=C
    const diagram = createRelinkDiagram(true);
    const linkRelink = vi.fn();

    service.onLinkRelink(linkRelink);
    service.setDiagram(diagram, {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    } as unknown as HTMLDivElement);

    emitLinkRelinked(createRelinkLink(diagram, 'task-a', 'task-c'), 'task-b');

    expect(linkRelink).toHaveBeenCalledWith(
      'parent-child',
      expect.objectContaining({
        changedEnd: 'to',
        oldFromId: 'task-a',
        oldToId: 'task-b',
        newFromId: 'task-a',
        newToId: 'task-c',
      }),
      expect.any(Number),
      expect.any(Number),
      expect.any(go.Link),
    );
  });

  it('classifies a genuine from-end relink correctly when the parent actually changed', () => {
    // 场景：A→B 的 from 端拖到 C：changedEnd='from'，oldFrom=A(disconnected)、newFrom=C
    const diagram = createRelinkDiagram(false);
    const linkRelink = vi.fn();

    service.onLinkRelink(linkRelink);
    service.setDiagram(diagram, {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    } as unknown as HTMLDivElement);

    emitLinkRelinked(createRelinkLink(diagram, 'task-c', 'task-b'), 'task-a');

    expect(linkRelink).toHaveBeenCalledWith(
      'parent-child',
      expect.objectContaining({
        changedEnd: 'from',
        oldFromId: 'task-a',
        oldToId: 'task-b',
        newFromId: 'task-c',
        newToId: 'task-b',
      }),
      expect.any(Number),
      expect.any(Number),
      expect.any(go.Link),
    );
  });

  it('isolates synchronous business callback failures from Flow event dispatch', () => {
    const dispatchError = new Error('background handler failed');
    service.onBackgroundClick(() => {
      throw dispatchError;
    });

    expect(() => service.emitBackgroundClick()).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      'Flow 事件回调执行失败',
      { eventName: 'backgroundClick', error: dispatchError },
    );
  });

  it('logs asynchronous business callback rejections without leaving an unhandled Flow event failure', async () => {
    const dispatchError = new Error('relink handler failed');
    const gojsLink = new go.Link();
    service.onLinkRelink(async () => {
      throw dispatchError;
    });

    service.emitLinkRelink(
      'cross-tree',
      {
        changedEnd: 'to',
        oldFromId: 'old-source',
        oldToId: 'old-target',
        newFromId: 'new-source',
        newToId: 'new-target',
      },
      10,
      20,
      gojsLink,
    );
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      'Flow 事件回调执行失败',
      { eventName: 'linkRelink', error: dispatchError },
    );
  });
});
