import { describe, expect, it, beforeEach } from 'vitest';
import {
  getCompatibleTaskSelectFields,
  getCompatibleTaskWriteRow,
  markTaskAttentionMetaColumnUnavailable,
  markTaskCompletedAtColumnUnavailable,
  resetTaskSchemaCompatibilityForTests,
} from './task-schema-compat';

describe('task schema compatibility', () => {
  beforeEach(() => {
    resetTaskSchemaCompatibilityForTests();
  });

  it('strips completed_at after old-schema missing-column errors', () => {
    const marked = markTaskCompletedAtColumnUnavailable({
      code: '42703',
      message: 'column tasks.completed_at does not exist',
    });

    expect(marked).toBe(true);
    expect(getCompatibleTaskSelectFields('id,title,completed_at,attention_meta')).toBe('id,title,attention_meta');
    expect(getCompatibleTaskWriteRow({ id: 'task-1', completed_at: 'now', attention_meta: { items: [] } })).toEqual({
      id: 'task-1',
      attention_meta: { items: [] },
    });
  });

  it('strips attention_meta after old-schema missing-column errors', () => {
    const marked = markTaskAttentionMetaColumnUnavailable({
      code: '42703',
      message: 'column tasks.attention_meta does not exist',
    });

    expect(marked).toBe(true);
    expect(getCompatibleTaskSelectFields('id,title,completed_at,attention_meta')).toBe('id,title,completed_at');
    expect(getCompatibleTaskWriteRow({ id: 'task-1', completed_at: 'now', attention_meta: { items: [] } })).toEqual({
      id: 'task-1',
      completed_at: 'now',
    });
  });

  it('lets the existing completed_at marker also detect attention_meta compatibility errors', () => {
    const marked = markTaskCompletedAtColumnUnavailable({
      code: '42703',
      message: 'column tasks.attention_meta does not exist',
    });

    expect(marked).toBe(true);
    expect(getCompatibleTaskSelectFields('id,attention_meta')).toBe('id');
  });
});