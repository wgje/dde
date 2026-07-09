export function remoteExternalSourceLinkRow(id: string, taskId: string) {
  const updatedAt = '2026-06-09T00:00:00.000Z';
  return {
    id,
    user_id: '00000000-0000-0000-0000-000000000001',
    task_id: taskId,
    source_type: 'siyuan-block',
    target_id: `20260609000000-${id.slice(-7)}`,
    uri: `siyuan://blocks/20260609000000-${id.slice(-7)}?focus=1`,
    label: null,
    hpath: null,
    role: null,
    sort_order: 0,
    deleted_at: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}
