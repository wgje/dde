import { describe, expect, it } from 'vitest';
import { resolveRouteIntent } from './route-intent';

describe('resolveRouteIntent', () => {
  it('should return task intent for task deep link', () => {
    const result = resolveRouteIntent('/projects/p-1/task/t-9', null);
    expect(result).toEqual({ kind: 'task', projectId: 'p-1', taskId: 't-9' });
  });

  it('should return flow intent for flow route', () => {
    const result = resolveRouteIntent('/projects/p-1/flow', null);
    expect(result).toEqual({ kind: 'flow', projectId: 'p-1', taskId: null });
  });

  it('should return text intent for text route', () => {
    const result = resolveRouteIntent('/projects/p-1/text', null);
    expect(result).toEqual({ kind: 'text', projectId: 'p-1', taskId: null });
  });

  it('should return project intent for project route', () => {
    const result = resolveRouteIntent('/projects/p-1', null);
    expect(result).toEqual({ kind: 'project', projectId: 'p-1', taskId: null });
  });

  it('should keep project routes when startup query params are present', () => {
    const result = resolveRouteIntent('/projects/p-1?entry=widget&intent=open-workspace', null);
    expect(result).toEqual({ kind: 'project', projectId: 'p-1', taskId: null });
  });

  it('should return projects intent for unknown route with no active project', () => {
    const result = resolveRouteIntent('/some/unknown', null);
    expect(result).toEqual({ kind: 'projects', projectId: null, taskId: null });
  });

  it('should return projects intent with projectId when active project is set', () => {
    const result = resolveRouteIntent('/some/unknown', 'p-active');
    expect(result).toEqual({ kind: 'projects', projectId: 'p-active', taskId: null });
  });

  it('should return project intent when routeUrl is null and activeProjectId exists', () => {
    const result = resolveRouteIntent(null, 'p-1');
    expect(result).toEqual({ kind: 'project', projectId: 'p-1', taskId: null });
  });

  it('should return projects intent when routeUrl is null and no active project', () => {
    const result = resolveRouteIntent(null, null);
    expect(result).toEqual({ kind: 'projects', projectId: null, taskId: null });
  });

  it('should not match flow route with trailing characters', () => {
    const result = resolveRouteIntent('/projects/p-1/flow/extra', null);
    expect(result.kind).not.toBe('flow');
  });

  it('should handle URL with query params and hash in task route', () => {
    const result = resolveRouteIntent('/projects/p-1/task/t-2?entry=widget&intent=open-workspace', null);
    expect(result).toEqual({ kind: 'task', projectId: 'p-1', taskId: 't-2' });
  });

  it('should keep flow routes when startup query params are present', () => {
    const result = resolveRouteIntent('/projects/p-1/flow?entry=twa&intent=open-workspace', null);
    expect(result).toEqual({ kind: 'flow', projectId: 'p-1', taskId: null });
  });
});
