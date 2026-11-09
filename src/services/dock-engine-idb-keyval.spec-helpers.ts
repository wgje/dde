import { vi } from 'vitest';

type IdbKeyvalMocks = typeof import('idb-keyval');

export async function resetDockEngineIdbKeyvalMocks(): Promise<IdbKeyvalMocks> {
  const idbKeyval = await import('idb-keyval');
  vi.mocked(idbKeyval.clear).mockReset();
  vi.mocked(idbKeyval.clear).mockResolvedValue(undefined);
  vi.mocked(idbKeyval.del).mockReset();
  vi.mocked(idbKeyval.del).mockResolvedValue(undefined);
  vi.mocked(idbKeyval.get).mockReset();
  vi.mocked(idbKeyval.get).mockResolvedValue(null);
  vi.mocked(idbKeyval.keys).mockReset();
  vi.mocked(idbKeyval.keys).mockResolvedValue([]);
  vi.mocked(idbKeyval.set).mockReset();
  vi.mocked(idbKeyval.set).mockResolvedValue(undefined);
  vi.mocked(idbKeyval.update).mockReset();
  vi.mocked(idbKeyval.update).mockImplementation(
    async (_key: unknown, updater: (value: unknown) => unknown) => {
      updater(undefined);
    },
  );
  vi.mocked(idbKeyval.values).mockReset();
  vi.mocked(idbKeyval.values).mockResolvedValue([]);
  return idbKeyval;
}
