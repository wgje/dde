import { describe, expect, it } from 'vitest';
import type { ConnectionEditorData } from '../../../../models/flow-view-state';
import {
  buildConnectionEditorPayloadKey,
  buildConnectionEditorSessionKey,
  buildConnectionEditorSessionState,
  canRunDelayedConnectionEditorAction,
  clampConnectionEditorPosition,
  compressConnectionDisplayId,
  createConnectionEditorSaveContext,
  resolveConnectionEditorBlurAction,
  resolveConnectionEditorDocumentInteraction,
  resolveConnectionEditorComposingClickAction,
  resolveConnectionEditorSaveContext,
  resolveConnectionEditorSavePayload,
  shouldSkipConnectionEditorContentSync,
} from './flow-connection-editor.helpers';

function data(overrides: Partial<ConnectionEditorData> = {}): ConnectionEditorData {
  return {
    sourceId: overrides.sourceId ?? 'source-task',
    targetId: overrides.targetId ?? 'target-task',
    title: overrides.title ?? 'Link',
    description: overrides.description ?? 'Description',
    x: overrides.x ?? 160,
    y: overrides.y ?? 240,
    isCrossTree: overrides.isCrossTree ?? true,
    mode: overrides.mode ?? 'preview',
  };
}

describe('flow-connection-editor.helpers', () => {
  it('构建会话 key 时包含端点和坐标', () => {
    expect(buildConnectionEditorSessionKey(data())).toBe('source-task->target-task@160,240');
  });

  it('根据 data mode 与 readonly 状态构建会话状态', () => {
    expect(buildConnectionEditorSessionState({
      data: data({ mode: 'edit' }),
      readOnly: false,
      previousSessionKey: 'old-session',
      previousContext: null,
      currentIsEditMode: false,
    })).toEqual({
      data: data({ mode: 'edit' }),
      sessionKey: 'source-task->target-task@160,240',
      isNewSession: true,
      nextIsEditMode: true,
      currentIsEditMode: false,
      previousContext: null,
    });

    expect(buildConnectionEditorSessionState({
      data: data({ mode: 'edit' }),
      readOnly: true,
      previousSessionKey: 'source-task->target-task@160,240',
      previousContext: {
        sourceId: 'source-task',
        targetId: 'target-task',
        title: 'Link',
        description: 'Description',
      },
      currentIsEditMode: true,
    }).nextIsEditMode).toBe(false);
  });

  it('从编辑态切回预览或已有回流 payload 时跳过服务内容同步', () => {
    expect(shouldSkipConnectionEditorContentSync({
      modeChanged: true,
      currentIsEditMode: true,
      nextIsEditMode: false,
      hasLastEmittedPayload: false,
    })).toBe(true);

    expect(shouldSkipConnectionEditorContentSync({
      modeChanged: false,
      currentIsEditMode: false,
      nextIsEditMode: false,
      hasLastEmittedPayload: true,
    })).toBe(true);

    expect(shouldSkipConnectionEditorContentSync({
      modeChanged: false,
      currentIsEditMode: false,
      nextIsEditMode: false,
      hasLastEmittedPayload: false,
    })).toBe(false);
  });

  it('构建保存 payload key 并压缩过长 displayId', () => {
    expect(buildConnectionEditorPayloadKey('source', 'target', 'Title', 'Body')).toBe('source->target|Title|Body');
    expect(compressConnectionDisplayId(undefined)).toBe('');
    expect(compressConnectionDisplayId('ABCDEF')).toBe('ABCDEF');
    expect(compressConnectionDisplayId('ABCDEFG')).toBe('ABCDE..');
  });

  it('从连接数据创建稳定的保存上下文', () => {
    expect(createConnectionEditorSaveContext(data({
      sourceId: 'source',
      targetId: 'target',
      title: '',
      description: '',
    }))).toEqual({
      sourceId: 'source',
      targetId: 'target',
      title: '',
      description: '',
    });
  });

  it('解析保存 payload 时跳过无变化内容和重复 payload', () => {
    const context = {
      sourceId: 'source',
      targetId: 'target',
      title: 'Original',
      description: 'Body',
    };

    expect(resolveConnectionEditorSavePayload({
      context,
      draft: { title: 'Original', description: 'Body' },
      lastEmittedPayloadKey: null,
    })).toBeNull();

    expect(resolveConnectionEditorSavePayload({
      context,
      draft: { title: 'Updated', description: 'Body' },
      lastEmittedPayloadKey: 'source->target|Updated|Body',
    })).toBeNull();

    expect(resolveConnectionEditorSavePayload({
      context,
      draft: { title: 'Updated', description: 'Body' },
      lastEmittedPayloadKey: null,
    })).toEqual({
      sourceId: 'source',
      targetId: 'target',
      title: 'Updated',
      description: 'Body',
      payloadKey: 'source->target|Updated|Body',
    });
  });

  it('将编辑器位置限制在视口安全边界内', () => {
    expect(clampConnectionEditorPosition({
      position: { x: 400, y: 300 },
      viewport: { width: 1000, height: 800 },
      editor: { width: 208, height: 180 },
      padding: 12,
    })).toEqual({ x: 400, y: 300 });

    expect(clampConnectionEditorPosition({
      position: { x: -100, y: 900 },
      viewport: { width: 320, height: 240 },
      editor: { width: 208, height: 180 },
      padding: 12,
    })).toEqual({ x: 12, y: 48 });
  });

  it('解析文档交互上下文并在保护窗口内跳过外部点击', () => {
    const editorElement = document.createElement('div');
    const button = document.createElement('button');
    const outside = document.createElement('div');
    editorElement.append(button);
    document.body.append(editorElement, outside);

    try {
      expect(resolveConnectionEditorDocumentInteraction({
        target: button,
        editorElement,
        closeRequested: false,
        ignoreOutsideUntil: 0,
        isSelecting: false,
        now: 10,
      })).toEqual({
        clickedInside: true,
        isInteractiveElement: true,
      });

      expect(resolveConnectionEditorDocumentInteraction({
        target: outside,
        editorElement,
        closeRequested: false,
        ignoreOutsideUntil: 20,
        isSelecting: false,
        now: 10,
      })).toBeNull();
    } finally {
      editorElement.remove();
      outside.remove();
    }
  });

  it('解析保存上下文时优先使用 override 和活跃会话上下文', () => {
    const override = {
      sourceId: 'override-source',
      targetId: 'override-target',
      title: 'Override',
      description: 'Override description',
    };
    const activeSessionContext = {
      sourceId: 'active-source',
      targetId: 'active-target',
      title: 'Active',
      description: 'Active description',
    };

    expect(resolveConnectionEditorSaveContext({
      override,
      activeSessionContext,
      data: data({ sourceId: 'data-source' }),
    })).toBe(override);

    expect(resolveConnectionEditorSaveContext({
      activeSessionContext,
      data: data({ sourceId: 'data-source' }),
    })).toBe(activeSessionContext);

    expect(resolveConnectionEditorSaveContext({
      activeSessionContext: null,
      data: data({
        sourceId: 'data-source',
        targetId: 'data-target',
        title: '',
        description: '',
      }),
    })).toEqual({
      sourceId: 'data-source',
      targetId: 'data-target',
      title: '',
      description: '',
    });
  });

  it('只允许当前未关闭会话执行延迟动作', () => {
    expect(canRunDelayedConnectionEditorAction({
      isDestroyed: false,
      closeRequested: false,
      sessionKey: 'source->target@1,2',
      lastSessionKey: 'source->target@1,2',
    })).toBe(true);

    expect(canRunDelayedConnectionEditorAction({
      isDestroyed: true,
      closeRequested: false,
      sessionKey: 'source->target@1,2',
      lastSessionKey: 'source->target@1,2',
    })).toBe(false);

    expect(canRunDelayedConnectionEditorAction({
      isDestroyed: false,
      closeRequested: true,
      sessionKey: 'source->target@1,2',
      lastSessionKey: 'source->target@1,2',
    })).toBe(false);

    expect(canRunDelayedConnectionEditorAction({
      isDestroyed: false,
      closeRequested: false,
      sessionKey: 'old-session',
      lastSessionKey: 'source->target@1,2',
    })).toBe(false);
  });

  it('解析 IME 组合输入期间延迟点击动作', () => {
    expect(resolveConnectionEditorComposingClickAction({
      canRunDelayedAction: false,
      clickedInside: false,
      isEditMode: true,
    })).toBe('skip');

    expect(resolveConnectionEditorComposingClickAction({
      canRunDelayedAction: true,
      clickedInside: true,
      isEditMode: true,
    })).toBe('force-exit-edit');

    expect(resolveConnectionEditorComposingClickAction({
      canRunDelayedAction: true,
      clickedInside: false,
      isEditMode: true,
    })).toBe('save-and-close');
  });

  it('解析输入框 blur 延迟检查是否需要退出编辑模式', () => {
    const editorElement = document.createElement('div');
    const input = document.createElement('input');
    const outside = document.createElement('button');
    editorElement.append(input);

    expect(resolveConnectionEditorBlurAction({
      canRunDelayedAction: false,
      isEditMode: true,
      editorElement,
      activeElement: outside,
      relatedTarget: outside,
    })).toBe('skip');

    expect(resolveConnectionEditorBlurAction({
      canRunDelayedAction: true,
      isEditMode: false,
      editorElement,
      activeElement: outside,
      relatedTarget: outside,
    })).toBe('skip');

    expect(resolveConnectionEditorBlurAction({
      canRunDelayedAction: true,
      isEditMode: true,
      editorElement,
      activeElement: input,
      relatedTarget: outside,
    })).toBe('skip');

    expect(resolveConnectionEditorBlurAction({
      canRunDelayedAction: true,
      isEditMode: true,
      editorElement,
      activeElement: outside,
      relatedTarget: outside,
    })).toBe('exit-edit');
  });
});
