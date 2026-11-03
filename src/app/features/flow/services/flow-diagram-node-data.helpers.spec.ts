import { describe, expect, it } from 'vitest';
import { SUPERSCRIPT_DIGITS } from '../../../../config';
import { getFlowStyles } from '../../../../config/flow-styles';
import type { Task } from '../../../../models';
import type { GoJSNodeData } from './flow-diagram-config.service';
import {
  applyFlowLineageDisplayColors,
  compressFlowDisplayId,
  computeFlowNodeColors,
  computeFlowNodeLocation,
  isFlowTaskSearchMatch,
  needsFlowDisplayIdRenumbering,
  resolveFlowDisplayId,
} from './flow-diagram-node-data.helpers';

function task(id: string, options: Partial<Task> = {}): Task {
  return {
    id,
    title: options.title ?? id,
    content: options.content ?? '',
    stage: Object.prototype.hasOwnProperty.call(options, 'stage')
      ? (options.stage ?? null)
      : 1,
    parentId: options.parentId ?? null,
    order: 1,
    rank: 100,
    status: options.status ?? 'active',
    x: options.x ?? 0,
    y: options.y ?? 0,
    createdDate: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    displayId: options.displayId ?? '1',
    attachments: options.attachments ?? [],
    tags: options.tags ?? [],
  } as Task;
}

function node(key: string, options: Partial<GoJSNodeData> = {}): GoJSNodeData {
  return {
    key,
    title: key,
    displayId: '1',
    stage: 1,
    parentId: null,
    status: 'active',
    loc: '0 0',
    color: '#fff',
    borderColor: '#000',
    borderWidth: 1,
    titleColor: '#111',
    displayIdColor: '#222',
    selectedBorderColor: '#333',
    isUnassigned: false,
    isSearchMatch: false,
    isSelected: false,
    ...options,
  };
}

describe('flow diagram node data helpers', () => {
  it('computes stable node locations from existing model data, stored task coordinates, or stage slots', () => {
    const existingNodeMap = new Map<string, { loc?: string; stage?: number | null; parentId?: string | null }>([
      ['existing', { loc: '10 20', stage: 1, parentId: null }],
    ]);

    expect(computeFlowNodeLocation(task('existing', { x: 40, y: 50 }), existingNodeMap, 3)).toBe('10 20');
    expect(computeFlowNodeLocation(task('stored', { x: 40, y: 50 }), existingNodeMap, 3)).toBe('40 50');
    expect(computeFlowNodeLocation(task('new-stage-3', { stage: 3 }), existingNodeMap, 2)).toBe('300 200');
    expect(computeFlowNodeLocation(task('new-unassigned', { stage: null }), existingNodeMap, 2)).toBe('0 200');
  });

  it('uses persisted task coordinates when an existing node changes stage', () => {
    const existingNodeMap = new Map([
      ['moved-stage', { loc: '10 20', stage: 1, parentId: null }],
    ]);

    expect(computeFlowNodeLocation(
      task('moved-stage', { stage: 3, x: 320, y: 240 }),
      existingNodeMap,
      0,
    )).toBe('320 240');
  });

  it('uses the current stage slot when parent changes without stored coordinates', () => {
    const existingNodeMap = new Map([
      ['moved-parent', { loc: '10 20', stage: 2, parentId: 'old-parent' }],
    ]);

    expect(computeFlowNodeLocation(
      task('moved-parent', { stage: 2, parentId: 'new-parent' }),
      existingNodeMap,
      3,
    )).toBe('150 300');
  });

  it('matches normalized search text across task text, display id, attachments, and tags', () => {
    const searchable = task('searchable', {
      title: 'Alpha',
      content: 'Beta content',
      displayId: '1,a',
      attachments: [{
        id: 'att-1',
        name: 'Design.md',
        type: 'document',
        size: 1,
        url: 'local://design',
        createdAt: '2026-06-17T00:00:00.000Z',
      }],
      tags: ['Review'],
    });

    expect(isFlowTaskSearchMatch(searchable, '')).toBe(false);
    expect(isFlowTaskSearchMatch(searchable, 'alpha')).toBe(true);
    expect(isFlowTaskSearchMatch(searchable, 'beta')).toBe(true);
    expect(isFlowTaskSearchMatch(searchable, '1,a')).toBe(true);
    expect(isFlowTaskSearchMatch(searchable, 'design')).toBe(true);
    expect(isFlowTaskSearchMatch(searchable, 'review')).toBe(true);
    expect(isFlowTaskSearchMatch(searchable, 'missing')).toBe(false);
  });

  it('computes node colors for search, unassigned, completed, and default states', () => {
    const styles = getFlowStyles('default', 'light');

    expect(computeFlowNodeColors(task('search'), true, styles)).toEqual({
      nodeColor: styles.node.searchHighlightBackground,
      borderColor: styles.node.searchHighlightBorder,
      borderWidth: 2,
      titleColor: styles.text.titleColor,
    });
    expect(computeFlowNodeColors(task('unassigned', { stage: null }), false, styles)).toEqual({
      nodeColor: styles.node.unassignedBackground,
      borderColor: styles.node.unassignedBorder,
      borderWidth: 2,
      titleColor: styles.text.unassignedTitleColor,
    });
    expect(computeFlowNodeColors(task('done', { status: 'completed' }), false, styles)).toEqual({
      nodeColor: styles.node.completedBackground,
      borderColor: styles.node.defaultBorder,
      borderWidth: 1,
      titleColor: styles.text.titleColor,
    });
    expect(computeFlowNodeColors(task('default'), false, styles)).toEqual({
      nodeColor: styles.node.background,
      borderColor: styles.node.defaultBorder,
      borderWidth: 1,
      titleColor: styles.text.titleColor,
    });
  });

  it('resolves and compresses display ids without renumbering unassigned nodes', () => {
    const assignedMissing = task('assigned-missing', { displayId: '' });
    const assignedPlaceholder = task('assigned-placeholder', { displayId: '?' });
    const assignedReady = task('assigned-ready', { displayId: '1' });
    const unassigned = task('unassigned', { stage: null, displayId: '?' });
    const resolvedDisplayIds = new Map<string, string>([[assignedMissing.id, '1,a']]);

    expect(needsFlowDisplayIdRenumbering(assignedMissing)).toBe(true);
    expect(needsFlowDisplayIdRenumbering(assignedPlaceholder)).toBe(true);
    expect(needsFlowDisplayIdRenumbering(assignedReady)).toBe(false);
    expect(needsFlowDisplayIdRenumbering(unassigned)).toBe(false);
    expect(resolveFlowDisplayId(assignedMissing, resolvedDisplayIds)).toBe('1,a');
    expect(resolveFlowDisplayId(assignedReady, resolvedDisplayIds)).toBe('1');
    expect(compressFlowDisplayId('?')).toBe('?');
    expect(compressFlowDisplayId('A,A,A,A')).toBe('A,A,A,A');
    expect(compressFlowDisplayId('A,A,A,A,A')).toBe(`A${SUPERSCRIPT_DIGITS['5']}`);
  });

  it('applies darker family colors only to assigned lineage nodes that are not search matches', () => {
    const darker = (familyColor: string) => `dark:${familyColor}`;
    const nodes = [
      node('assigned', { familyColor: '#f00' }),
      node('search', { familyColor: '#0f0', isSearchMatch: true }),
      node('unassigned', { familyColor: '#00f', stage: null }),
      node('plain'),
    ];

    expect(applyFlowLineageDisplayColors(nodes, darker)).toEqual([
      expect.objectContaining({ key: 'assigned', displayIdColor: 'dark:#f00' }),
      expect.objectContaining({ key: 'search', displayIdColor: '#222' }),
      expect.objectContaining({ key: 'unassigned', displayIdColor: '#222' }),
      expect.objectContaining({ key: 'plain', displayIdColor: '#222' }),
    ]);
  });
});
