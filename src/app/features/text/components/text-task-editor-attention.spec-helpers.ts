import type { ComponentFixture } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';

import type { Task, TaskAttentionDraftItem } from '../../../../models';
import { createTask } from './text-task-editor.test-harness';
import { TextTaskEditorComponent } from './text-task-editor.component';

export interface TextTaskEditorAttentionSpecContext {
  getFixture(): ComponentFixture<TextTaskEditorComponent>;
  render(taskOverrides?: Partial<Task>): {
    setTask(nextTask: Task): void;
  };
  updateTaskAttentionItems: ReturnType<typeof vi.fn>;
}

export function registerTextTaskEditorAttentionSpecs(
  context: TextTaskEditorAttentionSpecContext,
): void {
  it('should persist editable attention lines through task adapter', () => {
    context.render({
      attentionMeta: {
        items: [
          {
            id: 'attention-1',
            text: 'Token 过期需刷新',
            level: 'warning',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:00:00.000Z',
          },
        ],
        updatedAt: '2026-06-05T00:00:00.000Z',
      },
    });
    const fixture = context.getFixture();
    const component = fixture.componentInstance;
    component.isPreview.set(false);
    fixture.detectChanges();

    let inputs = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="task-attention-input"]'),
    ) as HTMLInputElement[];
    expect(inputs[0]?.value).toBe('Token 过期需刷新');

    const addButton = fixture.nativeElement.querySelector(
      '[data-testid="task-attention-add"]',
    ) as HTMLButtonElement;
    addButton.click();
    fixture.detectChanges();

    inputs = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="task-attention-input"]'),
    ) as HTMLInputElement[];
    inputs[1]!.value = '接口字段未冻结';
    inputs[1]!.dispatchEvent(new Event('input'));

    expect(context.updateTaskAttentionItems).toHaveBeenLastCalledWith('task-1', [
      expect.objectContaining({
        id: 'attention-1',
        text: 'Token 过期需刷新',
        level: 'warning',
        done: false,
        createdAt: '2026-06-05T00:00:00.000Z',
      }),
      expect.objectContaining({
        text: '接口字段未冻结',
        level: 'info',
        done: false,
      }),
    ]);

    const removeButtons = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="task-attention-remove"]'),
    ) as HTMLButtonElement[];
    removeButtons[0]!.click();

    expect(context.updateTaskAttentionItems).toHaveBeenLastCalledWith('task-1', [
      expect.objectContaining({
        text: '接口字段未冻结',
        level: 'info',
        done: false,
      }),
    ]);
  });

  it('should keep the just-entered attention value on blur while the parent task input is still stale', () => {
    context.render({
      attentionMeta: {
        items: [
          {
            id: 'attention-1',
            text: 'Token 过期需刷新',
            level: 'warning',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:00:00.000Z',
          },
        ],
        updatedAt: '2026-06-05T00:00:00.000Z',
      },
    });
    const fixture = context.getFixture();
    const component = fixture.componentInstance as unknown as {
      isPreview: { set(value: boolean): void };
      localAttentionDraft: () => string;
      attentionDraftRows: () => Array<{ text: string }>;
    };
    component.isPreview.set(false);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="task-attention-input"]',
    ) as HTMLInputElement;
    input.dispatchEvent(new Event('focus'));
    input.value = 'Token 过期需刷新；先轮换密钥';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(context.updateTaskAttentionItems).toHaveBeenLastCalledWith('task-1', [
      expect.objectContaining({
        id: 'attention-1',
        text: 'Token 过期需刷新；先轮换密钥',
      }),
    ]);
    expect(component.localAttentionDraft()).toBe('Token 过期需刷新；先轮换密钥');
    expect(component.attentionDraftRows().map(row => row.text)).toEqual([
      'Token 过期需刷新；先轮换密钥',
    ]);
  });

  it('should persist trimmed attention rows when a line is cleared on blur', () => {
    context.render({
      attentionMeta: {
        items: [
          {
            id: 'attention-1',
            text: 'Token 过期需刷新',
            level: 'warning',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:00:00.000Z',
          },
          {
            id: 'attention-2',
            text: '确认回滚方案',
            level: 'info',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:00:00.000Z',
          },
        ],
        updatedAt: '2026-06-05T00:00:00.000Z',
      },
    });
    const fixture = context.getFixture();
    const component = fixture.componentInstance as unknown as {
      isPreview: { set(value: boolean): void };
      localAttentionDraft: () => string;
      attentionDraftRows: () => Array<{ text: string }>;
    };
    component.isPreview.set(false);
    fixture.detectChanges();

    const inputs = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="task-attention-input"]'),
    ) as HTMLInputElement[];
    inputs[0]!.dispatchEvent(new Event('focus'));
    inputs[0]!.value = '';
    inputs[0]!.dispatchEvent(new Event('input'));
    inputs[0]!.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(context.updateTaskAttentionItems).toHaveBeenLastCalledWith('task-1', [
      expect.objectContaining({
        id: 'attention-2',
        text: '确认回滚方案',
      }),
    ]);
    expect(component.localAttentionDraft()).toBe('确认回滚方案');
    expect(component.attentionDraftRows().map(row => row.text)).toEqual([
      '确认回滚方案',
    ]);
  });

  it('should persist the latest visible attention DOM value before destroy', () => {
    context.render({
      attentionMeta: {
        items: [
          {
            id: 'attention-1',
            text: 'Token 过期需刷新',
            level: 'warning',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:00:00.000Z',
          },
        ],
        updatedAt: '2026-06-05T00:00:00.000Z',
      },
    });
    const fixture = context.getFixture();
    const component = fixture.componentInstance;
    component.isPreview.set(false);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="task-attention-input"]',
    ) as HTMLInputElement;
    input.value = 'Token 过期需刷新；先轮换密钥';

    fixture.destroy();

    expect(context.updateTaskAttentionItems).toHaveBeenLastCalledWith('task-1', [
      expect.objectContaining({
        id: 'attention-1',
        text: 'Token 过期需刷新；先轮换密钥',
        level: 'warning',
        done: false,
        createdAt: '2026-06-05T00:00:00.000Z',
      }),
    ]);
  });

  it('should expose attention durable save failure without clearing the local draft', async () => {
    context.render({
      attentionMeta: {
        items: [
          {
            id: 'attention-1',
            text: 'Token 过期需刷新',
            level: 'warning',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:00:00.000Z',
          },
        ],
        updatedAt: '2026-06-05T00:00:00.000Z',
      },
    });
    context.updateTaskAttentionItems.mockResolvedValueOnce(false);
    const fixture = context.getFixture();
    const component = fixture.componentInstance as unknown as {
      isPreview: { set(value: boolean): void };
      attentionSaveState: () => 'idle' | 'saving' | 'failed';
      localAttentionDraft: () => string;
      attentionDraftRows: () => Array<{ text: string }>;
    };
    component.isPreview.set(false);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="task-attention-input"]',
    ) as HTMLInputElement;
    input.value = 'Token 过期需刷新；先轮换密钥';
    input.dispatchEvent(new Event('input'));
    await Promise.resolve();
    await Promise.resolve();

    expect(context.updateTaskAttentionItems).toHaveBeenLastCalledWith('task-1', [
      expect.objectContaining({
        id: 'attention-1',
        text: 'Token 过期需刷新；先轮换密钥',
      }),
    ]);
    expect(component.attentionSaveState()).toBe('failed');
    expect(component.localAttentionDraft()).toBe('Token 过期需刷新；先轮换密钥');
    expect(component.attentionDraftRows().map(row => row.text)).toEqual([
      'Token 过期需刷新；先轮换密钥',
    ]);
  });

  it('should not let an older attention save failure overwrite a newer successful save state', async () => {
    context.render({
      attentionMeta: {
        items: [
          {
            id: 'attention-1',
            text: 'Token 过期需刷新',
            level: 'warning',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:00:00.000Z',
          },
        ],
        updatedAt: '2026-06-05T00:00:00.000Z',
      },
    });
    let resolveFirstSave: (saved: boolean) => void = () => undefined;
    let resolveSecondSave: (saved: boolean) => void = () => undefined;
    const firstSave = new Promise<boolean>(resolve => {
      resolveFirstSave = resolve;
    });
    const secondSave = new Promise<boolean>(resolve => {
      resolveSecondSave = resolve;
    });
    context.updateTaskAttentionItems
      .mockReturnValueOnce(firstSave)
      .mockReturnValueOnce(secondSave);
    const fixture = context.getFixture();
    const component = fixture.componentInstance as unknown as {
      isPreview: { set(value: boolean): void };
      attentionSaveState: () => 'idle' | 'saving' | 'failed';
      localAttentionDraft: () => string;
    };
    component.isPreview.set(false);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="task-attention-input"]',
    ) as HTMLInputElement;
    input.value = '旧草稿';
    input.dispatchEvent(new Event('input'));
    input.value = '新草稿';
    input.dispatchEvent(new Event('input'));

    resolveSecondSave(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(component.attentionSaveState()).toBe('idle');

    resolveFirstSave(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(component.attentionSaveState()).toBe('idle');
    expect(component.localAttentionDraft()).toBe('新草稿');
  });

  it('should keep attention draft untouched while the sidecar editor is focused', () => {
    const { setTask } = context.render({
      attentionMeta: {
        items: [
          {
            id: 'attention-1',
            text: 'Token 过期需刷新',
            level: 'warning',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:00:00.000Z',
          },
        ],
        updatedAt: '2026-06-05T00:00:00.000Z',
      },
    });
    const fixture = context.getFixture();
    const component = fixture.componentInstance as unknown as {
      isPreview: { set(value: boolean): void };
      localAttentionDraft: () => string;
      attentionDraftRows: () => TaskAttentionDraftItem[];
    };
    component.isPreview.set(false);
    fixture.detectChanges();

    let input = fixture.nativeElement.querySelector(
      '[data-testid="task-attention-input"]',
    ) as HTMLInputElement;
    input.dispatchEvent(new Event('focus'));
    const addButton = fixture.nativeElement.querySelector(
      '[data-testid="task-attention-add"]',
    ) as HTMLButtonElement;
    addButton.click();
    fixture.detectChanges();

    setTask(createTask({
      updatedAt: '2026-06-05T00:01:00.000Z',
      attentionMeta: {
        items: [
          {
            id: 'attention-1',
            text: 'Token 过期需刷新',
            level: 'warning',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:01:00.000Z',
          },
        ],
        updatedAt: '2026-06-05T00:01:00.000Z',
      },
    }));
    fixture.detectChanges();

    expect(component.localAttentionDraft()).toBe('Token 过期需刷新\n');
    expect(component.attentionDraftRows().map(row => row.text)).toEqual([
      'Token 过期需刷新',
      '',
    ]);

    input = fixture.nativeElement.querySelector(
      '[data-testid="task-attention-input"]',
    ) as HTMLInputElement;
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(component.localAttentionDraft()).toBe('Token 过期需刷新');
    expect(component.attentionDraftRows().map(row => row.text)).toEqual([
      'Token 过期需刷新',
    ]);
  });
}
