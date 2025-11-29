import { Injectable, signal, computed } from '@angular/core';
import { UndoAction, Project, Task } from '../models';
import { UNDO_CONFIG } from '../config/constants';

/**
 * 撤销/重做服务
 * 实现应用级别的撤销重做功能
 */
@Injectable({
  providedIn: 'root'
})
export class UndoService {
  /** 撤销栈 */
  private undoStack = signal<UndoAction[]>([]);
  /** 重做栈 */
  private redoStack = signal<UndoAction[]>([]);
  
  /** 是否可以撤销 */
  readonly canUndo = computed(() => this.undoStack().length > 0);
  /** 是否可以撤销 */
  readonly canRedo = computed(() => this.redoStack().length > 0);
  
  /** 撤销栈大小 */
  readonly undoCount = computed(() => this.undoStack().length);
  /** 重做栈大小 */
  readonly redoCount = computed(() => this.redoStack().length);
  
  /** 是否正在执行撤销/重做操作（防止循环记录） */
  private isUndoRedoing = false;

  /**
   * 记录一个操作（用于后续撤销）
   */
  recordAction(action: Omit<UndoAction, 'timestamp'>): void {
    if (this.isUndoRedoing) return;
    
    const fullAction: UndoAction = {
      ...action,
      timestamp: Date.now()
    };
    
    this.undoStack.update(stack => {
      const newStack = [...stack, fullAction];
      // 限制栈大小
      if (newStack.length > UNDO_CONFIG.MAX_HISTORY_SIZE) {
        return newStack.slice(-UNDO_CONFIG.MAX_HISTORY_SIZE);
      }
      return newStack;
    });
    
    // 有新操作时清空重做栈
    this.redoStack.set([]);
  }

  /**
   * 执行撤销
   * @returns 需要应用的撤销数据，或 null（如果没有可撤销的操作）
   */
  undo(): UndoAction | null {
    const stack = this.undoStack();
    if (stack.length === 0) return null;
    
    this.isUndoRedoing = true;
    
    const action = stack[stack.length - 1];
    this.undoStack.update(s => s.slice(0, -1));
    this.redoStack.update(s => [...s, action]);
    
    this.isUndoRedoing = false;
    return action;
  }

  /**
   * 执行重做
   * @returns 需要应用的重做数据，或 null（如果没有可重做的操作）
   */
  redo(): UndoAction | null {
    const stack = this.redoStack();
    if (stack.length === 0) return null;
    
    this.isUndoRedoing = true;
    
    const action = stack[stack.length - 1];
    this.redoStack.update(s => s.slice(0, -1));
    this.undoStack.update(s => [...s, action]);
    
    this.isUndoRedoing = false;
    return action;
  }

  /**
   * 清空历史（切换项目时调用）
   */
  clearHistory(): void {
    this.undoStack.set([]);
    this.redoStack.set([]);
  }

  /**
   * 创建项目快照（用于记录操作前的状态）
   */
  createProjectSnapshot(project: Project): Partial<Project> {
    return {
      id: project.id,
      tasks: project.tasks.map(t => ({ ...t })),
      connections: project.connections.map(c => ({ ...c }))
    };
  }

  /**
   * 检查是否正在执行撤销/重做
   */
  get isProcessing(): boolean {
    return this.isUndoRedoing;
  }
}
