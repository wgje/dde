import { defineConfig } from 'vitest/config';
import base from '../vitest.config.mts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    restoreMocks: true,
    mockReset: true,
    clearMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
