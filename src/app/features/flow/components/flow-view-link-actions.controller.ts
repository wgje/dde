import type { FlowLinkService } from '../services/flow-link.service';
import type { ConnectionEditorSavePayload } from './flow-connection-editor.component';

interface FlowViewLinkActionsLogger {
  debug(message: string, context?: unknown): void;
}

export interface FlowViewLinkActionsControllerOptions {
  link: FlowLinkService;
  logger: FlowViewLinkActionsLogger;
  refreshDiagram: () => void;
}

export class FlowViewLinkActionsController {
  constructor(private readonly options: FlowViewLinkActionsControllerOptions) {}

  confirmParentChildLink(): void {
    void this.options.link.confirmParentChildLink()
      .then(created => {
        if (created) {
          this.options.refreshDiagram();
        }
      });
  }

  confirmCrossTreeLink(): void {
    void this.options.link.confirmCrossTreeLink()
      .then(created => {
        if (created) {
          this.options.refreshDiagram();
        }
      });
  }

  async saveConnectionDescription(data: ConnectionEditorSavePayload): Promise<void> {
    const saved = await this.options.link.saveConnectionContent(
      data.sourceId,
      data.targetId,
      data.title,
      data.description,
    );

    if (saved) {
      this.options.refreshDiagram();
    }
  }

  async deleteConnection(): Promise<void> {
    this.options.logger.debug('deleteConnection 被调用');
    const result = await this.options.link.deleteCurrentConnection();
    this.options.logger.debug('删除结果:', result);
    if (result) {
      this.options.refreshDiagram();
    }
  }

  async confirmLinkDelete(): Promise<void> {
    this.options.logger.debug('confirmLinkDelete 被调用');
    const result = await this.options.link.confirmLinkDelete();
    this.options.logger.debug('删除连接线结果:', result);
    if (result) {
      this.options.refreshDiagram();
    }
  }

  handleLinkActionEdit(): void {
    this.options.logger.debug('handleLinkActionEdit 被调用');
    this.options.link.openEditorFromActionMenu();
  }

  handleLinkActionView(): void {
    this.options.logger.debug('handleLinkActionView 被调用');
    this.options.link.viewFromActionMenu();
  }

  async handleLinkActionDelete(): Promise<void> {
    this.options.logger.debug('handleLinkActionDelete 被调用');
    const result = await this.options.link.deleteFromActionMenu();
    this.options.logger.debug('从操作菜单删除连接结果:', result);
    if (result) {
      this.options.refreshDiagram();
    }
  }
}
