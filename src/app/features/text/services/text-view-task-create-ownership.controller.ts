import type {
  ActiveProjectOwner,
  BeforeActiveProjectChangeListener,
  ProjectStateService,
} from '../../../../services/project-state.service';

type ProjectOwnershipSource = Pick<
  ProjectStateService,
  | 'captureActiveProjectOwner'
  | 'isActiveProjectOwnerCurrent'
  | 'registerBeforeActiveProjectChange'
  | 'tasks'
>;

export type TextViewTaskCreateOwner = Readonly<{
  key: string;
  project: ActiveProjectOwner;
  token: number;
}>;

export class TextViewTaskCreateOwnershipController {
  private readonly operations = new Map<string, TextViewTaskCreateOwner>();
  private readonly unregisterProjectChange: () => void;
  private nextToken = 0;
  private destroyed = false;

  constructor(private readonly projectState: ProjectOwnershipSource) {
    const retire: BeforeActiveProjectChangeListener = () => this.operations.clear();
    this.unregisterProjectChange = projectState.registerBeforeActiveProjectChange(retire);
  }

  async run(
    key: string,
    operation: (owner: TextViewTaskCreateOwner) => Promise<void>,
    sourceTaskId?: string,
  ): Promise<void> {
    const owner = this.begin(key, sourceTaskId);
    if (!owner) return;

    try {
      await operation(owner);
    } finally {
      if (this.operations.get(key) === owner) this.operations.delete(key);
    }
  }

  canPublish(owner: TextViewTaskCreateOwner): boolean {
    return !this.destroyed
      && this.operations.get(owner.key) === owner
      && this.projectState.isActiveProjectOwnerCurrent(owner.project);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.operations.clear();
    this.unregisterProjectChange();
  }

  private begin(key: string, sourceTaskId?: string): TextViewTaskCreateOwner | null {
    if (this.destroyed || this.operations.has(key)) return null;
    const project = this.projectState.captureActiveProjectOwner();
    if (!project.projectId) return null;
    if (sourceTaskId && !this.projectState.tasks().some(task => task.id === sourceTaskId)) return null;

    const owner = { key, project, token: ++this.nextToken } as const;
    this.operations.set(key, owner);
    return owner;
  }
}
