export const CURRENT_SUPABASE_INIT_VERSION = '7.56.0';

export function isSupabaseInitVersionAtLeast(
  current: string,
  minimum: string,
): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const currentParts = parse(current);
  const minimumParts = parse(minimum);
  if (!currentParts || !minimumParts) return false;

  for (let index = 0; index < currentParts.length; index += 1) {
    const currentPart = currentParts[index];
    const minimumPart = minimumParts[index];
    if (currentPart !== minimumPart) return currentPart > minimumPart;
  }

  return true;
}
