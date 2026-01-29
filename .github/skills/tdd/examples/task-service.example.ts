/**
 * TDD Example: TaskService
 * 
 * 这个文件展示了 TDD 循环的完整示例
 * 注意：这是纯示例文件，不会被编译
 */

// ========================================
// 第一步：写失败的测试（伪代码示例）
// ========================================

/*
describe('TaskService', () => {
  let service: TaskService;

  beforeEach(() => {
    service = new TaskService();
  });

  describe('create', () => {
    it('should create a task with generated UUID', () => {
      // Arrange
      const input = { title: 'My Task', content: '' };
      
      // Act
      const task = service.create(input);
      
      // Assert
      expect(task.id).toBeDefined();
      expect(task.id).toMatch(/^[a-f0-9-]{36}$/);
    });

    it('should set title from input', () => {
      const task = service.create({ title: 'Test Title', content: '' });
      expect(task.title).toBe('Test Title');
    });

    it('should set default status to active', () => {
      const task = service.create({ title: 'Test', content: '' });
      expect(task.status).toBe('active');
    });
  });

  describe('update', () => {
    it('should update task title', () => {
      // Arrange
      const task = service.create({ title: 'Old', content: '' });
      
      // Act
      const updated = service.update(task.id, { title: 'New' });
      
      // Assert
      expect(updated.title).toBe('New');
    });

    it('should throw if task not found', () => {
      expect(() => {
        service.update('non-existent-id', { title: 'New' });
      }).toThrow('Task not found');
    });
  });

  describe('delete', () => {
    it('should soft delete by setting deletedAt', () => {
      const task = service.create({ title: 'Test', content: '' });
      
      const deleted = service.delete(task.id);
      
      expect(deleted.deletedAt).toBeDefined();
    });
  });
});
*/

// ========================================
// 第二步：最小实现让测试通过
// ========================================

interface Task {
  id: string;
  title: string;
  content: string;
  status: 'active' | 'completed' | 'archived';
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface CreateTaskInput {
  title: string;
  content: string;
}

class TaskService {
  private tasks = new Map<string, Task>();

  create(input: CreateTaskInput): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: crypto.randomUUID(),
      title: input.title,
      content: input.content,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  update(id: string, changes: Partial<Pick<Task, 'title' | 'content' | 'status'>>): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Task not found');
    
    const updated: Task = {
      ...task,
      ...changes,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(id, updated);
    return updated;
  }

  delete(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Task not found');
    
    const deleted: Task = {
      ...task,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(id, deleted);
    return deleted;
  }

  getById(id: string, options?: { includeDeleted?: boolean }): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (!options?.includeDeleted && task.deletedAt) return undefined;
    return task;
  }
}

// ========================================
// 第三步：重构
// ========================================
// - 提取 now() 函数
// - 提取 Task 工厂函数
// - 添加类型守卫
// - 改进错误消息

// 导出避免 unused 警告
export { TaskService, Task, CreateTaskInput };
