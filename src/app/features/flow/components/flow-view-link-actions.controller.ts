import type { FlowLinkService } from '../services/flow-link.service';
import type {
  ConnectionEditorSavePayload,
  ConnectionEditorSessionIdentity,
} from './flow-connection-editor.component';

interface FlowViewLinkActionsLogger {
  debug(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
}

export interface FlowViewLinkActionsControllerOptions {
  link: FlowLinkService;
  logger: FlowViewLinkActionsLogger;
  refreshDiagram: () => void;
  getConnectionEditorSessionIdentity: () => ConnectionEditorSessionIdentity | null;
  closeConnectionEditor: () => void;
  restoreConnectionEditorAfterSaveFailure: () => void;
}

interface PendingConnectionSave {
  readonly session: ConnectionEditorSessionIdentity;
  readonly promise: Promise<boolean>;
}

export class FlowViewLinkActionsController {
  private latestConnectionSave: PendingConnectionSave | null = null;

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

  async saveConnectionDescription(data: ConnectionEditorSavePayload): Promise<boolean> {
    const save = Promise.resolve().then(() => this.options.link.saveConnectionContent(
        data.sourceId,
        data.targetId,
        data.title,
        data.description,
      ))
      .catch(error => {
        this.options.logger.warn('保存连接描述失败', {
          sourceId: data.sourceId,
          targetId: data.targetId,
          error,
        });
        return false;
      });
    const session = this.options.getConnectionEditorSessionIdentity();
    this.latestConnectionSave = session ? { session, promise: save } : null;
    const saved = await save;

    if (saved) {
      this.options.refreshDiagram();
    }
    return saved;
  }

  async requestConnectionEditorClose(): Promise<boolean> {
    const closingSession = this.options.getConnectionEditorSessionIdentity();
    if (!closingSession) {
      return false;
    }

    let observedSave: PendingConnectionSave | null = null;
    while (
      this.latestConnectionSave &&
      isSameConnectionEditorSession(this.latestConnectionSave.session, closingSession) &&
      this.latestConnectionSave !== observedSave
    ) {
      observedSave = this.latestConnectionSave;
      const saved = await observedSave.promise;
      if (!this.isConnectionEditorSessionActive(closingSession)) {
        return false;
      }
      if (observedSave !== this.latestConnectionSave) {
        if (
          this.latestConnectionSave &&
          isSameConnectionEditorSession(this.latestConnectionSave.session, closingSession)
        ) {
          continue;
        }
        return false;
      }
      this.latestConnectionSave = null;
      if (!saved) {
        this.options.restoreConnectionEditorAfterSaveFailure();
        return false;
      }
    }

    if (!this.isConnectionEditorSessionActive(closingSession)) {
      return false;
    }
    this.options.closeConnectionEditor();
    return true;
  }

  private isConnectionEditorSessionActive(session: ConnectionEditorSessionIdentity): boolean {
    return isSameConnectionEditorSession(
      this.options.getConnectionEditorSessionIdentity(),
      session,
    );
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

function isSameConnectionEditorSession(
  left: ConnectionEditorSessionIdentity | null,
  right: ConnectionEditorSessionIdentity | null,
): boolean {
  return !!left && !!right && left.key === right.key && left.generation === right.generation;
}
