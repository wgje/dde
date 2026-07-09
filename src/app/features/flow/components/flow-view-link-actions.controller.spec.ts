import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { FlowViewLinkActionsController } from './flow-view-link-actions.controller';
import type { FlowLinkService } from '../services/flow-link.service';

interface DeletedLinkResult {
  fromKey: string;
  toKey: string;
  isCrossTree: boolean;
}

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
  let logger: { debug: Mock<(message: string, context?: unknown) => void> };
  let refreshDiagram: Mock<() => void>;
  let controller: FlowViewLinkActionsController;

  beforeEach(() => {
    link = createLinkService();
    logger = { debug: vi.fn<(message: string, context?: unknown) => void>() };
    refreshDiagram = vi.fn<() => void>();
    controller = new FlowViewLinkActionsController({
      link: link as unknown as FlowLinkService,
      logger,
      refreshDiagram,
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
    await controller.saveConnectionDescription({
      sourceId: 'source',
      targetId: 'target',
      title: 'Title',
      description: 'Description',
    });

    expect(refreshDiagram).not.toHaveBeenCalled();

    link.saveConnectionContent.mockResolvedValueOnce(true);
    await controller.saveConnectionDescription({
      sourceId: 'source',
      targetId: 'target',
      title: 'Title',
      description: 'Description',
    });

    expect(link.saveConnectionContent).toHaveBeenLastCalledWith('source', 'target', 'Title', 'Description');
    expect(refreshDiagram).toHaveBeenCalledTimes(1);
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
