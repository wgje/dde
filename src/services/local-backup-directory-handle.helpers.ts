export function isStaleDirectoryHandleError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { name?: unknown; message?: unknown };
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';

  return name === 'InvalidStateError'
    && /state cached|changed since it was read from disk|read from disk/i.test(message);
}
