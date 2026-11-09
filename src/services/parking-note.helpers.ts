export function buildParkingNoteContent(content: string | null | undefined, noteContent: string): string {
  return `${content ?? ''}\n---\n> 备注（停泊时）: ${noteContent}`;
}

export function findParkingProjectId(
  taskId: string,
  getTaskProjectId: (taskId: string) => string | null | undefined,
  activeProjectId: () => string | null
): string | null {
  return getTaskProjectId(taskId) ?? activeProjectId() ?? null;
}
