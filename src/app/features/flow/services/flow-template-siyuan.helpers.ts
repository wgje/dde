export function getSiyuanBadgeLabel(index: number | undefined): string {
  if (!Number.isFinite(index) || (index ?? 0) <= 0) return '';
  return String(index);
}
