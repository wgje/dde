export const WIDGET_NOTIFY_DEVICE_LIMIT = 100;
export const WIDGET_NOTIFY_FCM_CONCURRENCY = 8;

export async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  concurrency: number,
  mapper: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive number');
  }

  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.trunc(concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}
