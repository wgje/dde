import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { FlowViewLinkActionsController } from './flow-view-link-actions.controller';
import type { FlowLinkService } from '../services/flow-link.service';
import type { ConnectionEditorSessionIdentity } from './flow-connection-editor.helpers';

interface DeletedLinkResult {
  fromKey: string;
  toKey: string;
  isCrossTree: boolean;
}

const DEFAULT_SESSION: ConnectionEditorSessionIdentity = {
  key: 'source->target@0,0',
  generation: 1,
};
const SESSION_A: ConnectionEditorSessionIdentity = {
  key: 'source-a->target-a@0,0',
  generation: 2,
};
const SESSION_B: ConnectionEditorSessionIdentity = {
  key: 'source-b->target-b@0,0',
  generation: 3,
};

interface MockFlowLinkService {
  confirmParentChildLink: Mock<() => Promise<boolean>>;
  confirmCrossTreeLink: Mock<() => Promise<boolean>>;
  saveConnectionContent: Mock<(
    sourceId: string,
    targetId: string,
    title: string,
    description: string,
  ) => Promise<boolean>>;
  deleteCurrentConnection: Mock<() => Promise<boolean>>;
  confirmLinkDelete: Mock<() => Promise<DeletedLinkResult | null>>;
  openEditorFromActionMenu: Mock<() => void>;
  viewFromActionMenu: Mock<() => void>;
  deleteFromActionMenu: Mock<() => Promise<DeletedLinkResult | null>>;
}

function createLinkService(): MockFlowLinkService {
  return {
    confirmParentChildLink: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    confirmCrossTreeLink: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    saveConnectionContent: vi.fn<(
      sourceId: string,
      targetId: string,
      title: string,
      description: string,
    ) => Promise<boolean>>().mockResolvedValue(false),
    deleteCurrentConnection: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    confirmLinkDelete: vi.fn<() => Promise<DeletedLinkResult | null>>().mockResolvedValue(null),
    openEditorFromActionMenu: vi.fn<() => void>(),
    viewFromActionMenu: vi.fn<() => void>(),
    deleteFromActionMenu: vi.fn<() => Promise<DeletedLinkResult | null>>().mockResolvedValue(null),
  };
}

describe('FlowViewLinkActionsController', () => {
  let link: MockFlowLinkService;
  let logger: {
    debug: Mock<(message: string, context?: unknown) => void>;
    warn: Mock<(message: string, context?: unknown) => void>;
  };
  let refreshDiagram: Mock<() => void>;
  let closeConnectionEditor: Mock<() => void>;
  let restoreConnectionEditorAfterSaveFailure: Mock<() => void>;
  let currentSession: ConnectionEditorSessionIdentity | null;
  let controller: FlowViewLinkActionsController;

  beforeEach(() => {
    link = createLinkService();
    logger = {
      debug: vi.fn<(message: string, context?: unknown) => void>(),
      warn: vi.fn<(message: string, context?: unknown) => void>(),
    };
    refreshDiagram = vi.fn<() => void>();
    closeConnectionEditor = vi.fn<() => void>();
    restoreConnectionEditorAfterSaveFailure = vi.fn<() => void>();
    currentSession = DEFAULT_SESSION;
    controller = new FlowViewLinkActionsController({
      link: link as unknown as FlowLinkService,
      logger,
      refreshDiagram,
      getConnectionEditorSessionIdentity: () => currentSession,
      closeConnectionEditor,
      restoreConnectionEditorAfterSaveFailure,
    });
  });

  const creationCases: Array<[string, () => Mock<() => Promise<boolean>>, () => void]> = [
    ['parent-child link', () => link.confirmParentChildLink, () => controller.confirmParentChildLink()],
    ['cross-tree link', () => link.confirmCrossTreeLink, () => controller.confirmCrossTreeLink()],
  ];

  it.each(creationCases)('refreshes after successful %s creation', async (_label, getOperation, run) => {
    getOperation().mockResolvedValueOnce(true);

    run();
    await Promise.resolve();

    expect(refreshDiagram).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['parent-child link', () => controller.confirmParentChildLink()],
    ['cross-tree link', () => controller.confirmCrossTreeLink()],
  ])('does not refresh when %s creation is skipped', async (_label, run) => {
    run();
    await Promise.resolve();

    expect(refreshDiagram).not.toHaveBeenCalled();
  });

  it('refreshes only when connection description is saved', async () => {
    await expect(controller.saveConnectionDescription({
      sourceId: 'source',
      targetId: 'target',
      title: 'Title',
      description: 'Description',
    })).resolves.toBe(false);

    expect(refreshDiagram).not.toHaveBeenCalled();

    link.saveConnectionContent.mockResolvedValueOnce(true);
    await expect(controller.saveConnectionDescription({
      sourceId: 'source',
      targetId: 'target',
      title: 'Title',
      description: 'Description',
    })).resolves.toBe(true);

    expect(link.saveConnectionContent).toHaveBeenLastCalledWith('source', 'target', 'Title', 'Description');
    expect(refreshDiagram).toHaveBeenCalledTimes(1);
  });

  it('keeps the editor open and restores interaction when the latest save fails', async () => {
    const deferred = createDeferred<boolean>();
    link.saveConnectionContent.mockReturnValueOnce(deferred.promise);
    const saving = controller.saveConnectionDescription({
      sourceId: 'source',
      targetId: 'target',
      title: 'Title',
      description: 'Description',
    });

    const closing = controller.requestConnectionEditorClose();
    expect(closeConnectionEditor).not.toHaveBeenCalled();

    deferred.resolve(false);
    await expect(saving).resolves.toBe(false);
    await expect(closing).resolves.toBe(false);

    expect(closeConnectionEditor).not.toHaveBeenCalled();
    expect(restoreConnectionEditorAfterSaveFailure).toHaveBeenCalledTimes(1);
  });

  it('does not let a consumed failed save reject a later close with no new save', async () => {
    const deferred = createDeferred<boolean>();
    link.saveConnectionContent.mockReturnValueOnce(deferred.promise);
    const saving = controller.saveConnectionDescription({
      sourceId: 'source',
      targetId: 'target',
      title: 'Title',
      description: 'Description',
    });
    const failedClose = controller.requestConnectionEditorClose();

    deferred.resolve(false);
    await expect(saving).resolves.toBe(false);
    await expect(failedClose).resolves.toBe(false);

    await expect(controller.requestConnectionEditorClose()).resolves.toBe(true);
    expect(restoreConnectionEditorAfterSaveFailure).toHaveBeenCalledTimes(1);
    expect(closeConnectionEditor).toHaveBeenCalledTimes(1);
  });

  it('closes the editor only after the latest save succeeds', async () => {
    const deferred = createDeferred<boolean>();
    link.saveConnectionContent.mockReturnValueOnce(deferred.promise);
    const saving = controller.saveConnectionDescription({
      sourceId: 'source',
      targetId: 'target',
      title: 'Title',
      description: 'Description',
    });

    const closing = controller.requestConnectionEditorClose();
    deferred.resolve(true);

    await expect(saving).resolves.toBe(true);
    await expect(closing).resolves.toBe(true);
    expect(closeConnectionEditor).toHaveBeenCalledTimes(1);
    expect(restoreConnectionEditorAfterSaveFailure).not.toHaveBeenCalled();
  });

  it('does not let a pending close for connection A close connection B after B starts saving', async () => {
    const saveA = createDeferred<boolean>();
    const saveB = createDeferred<boolean>();
    link.saveConnectionContent
      .mockReturnValueOnce(saveA.promise)
      .mockReturnValueOnce(saveB.promise);

    currentSession = SESSION_A;
    const savingA = controller.saveConnectionDescription({
      sourceId: 'source-a',
      targetId: 'target-a',
      title: 'Connection A',
      description: 'Description A',
    });
    const closingA = controller.requestConnectionEditorClose();

    currentSession = SESSION_B;
    const savingB = controller.saveConnectionDescription({
      sourceId: 'source-b',
      targetId: 'target-b',
      title: 'Connection B',
      description: 'Description B',
    });

    saveA.resolve(true);
    await expect(savingA).resolves.toBe(true);
    await expect(closingA).resolves.toBe(false);
    expect(closeConnectionEditor).not.toHaveBeenCalled();

    saveB.resolve(true);
    await expect(savingB).resolves.toBe(true);

    expect(closeConnectionEditor).not.toHaveBeenCalled();
    expect(restoreConnectionEditorAfterSaveFailure).not.toHaveBeenCalled();
  });

  const deletedLink: DeletedLinkResult = {
    fromKey: 'source',
    toKey: 'target',
    isCrossTree: true,
  };

  const deleteCases: Array<[string, () => Promise<void>, () => void]> = [
    [
      'delete current connection',
      () => controller.deleteConnection(),
      () => link.deleteCurrentConnection.mockResolvedValueOnce(true),
    ],
    [
      'confirm link delete',
      () => controller.confirmLinkDelete(),
      () => link.confirmLinkDelete.mockResolvedValueOnce(deletedLink),
    ],
    [
      'delete from action menu',
      () => controller.handleLinkActionDelete(),
      () => link.deleteFromActionMenu.mockResolvedValueOnce(deletedLink),
    ],
  ];

  it.each(deleteCases)('refreshes only when %s succeeds', async (_label, run, setSuccess) => {
    await run();
    expect(refreshDiagram).not.toHaveBeenCalled();

    setSuccess();
    await run();

    expect(refreshDiagram).toHaveBeenCalledTimes(1);
  });

  it('delegates action menu edit and view commands', () => {
    controller.handleLinkActionEdit();
    controller.handleLinkActionView();

    expect(link.openEditorFromActionMenu).toHaveBeenCalledTimes(1);
    expect(link.viewFromActionMenu).toHaveBeenCalledTimes(1);
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
