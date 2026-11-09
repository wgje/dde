import { describe, expect, it } from 'vitest';

import { buildParkingNoteContent, findParkingProjectId } from './parking-note.helpers';

describe('parking-note.helpers', () => {
  it('appends a parking note block to existing content', () => {
    expect(buildParkingNoteContent('Before', 'Later')).toBe('Before\n---\n> 备注（停泊时）: Later');
    expect(buildParkingNoteContent(null, 'Later')).toBe('\n---\n> 备注（停泊时）: Later');
  });

  it('resolves task project id before falling back to active project id', () => {
    expect(findParkingProjectId('task-1', () => 'task-project', () => 'active-project')).toBe('task-project');
    expect(findParkingProjectId('task-1', () => null, () => 'active-project')).toBe('active-project');
    expect(findParkingProjectId('task-1', () => null, () => null)).toBeNull();
  });
});
