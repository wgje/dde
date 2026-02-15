import { defineConfig } from 'vitest/config';
import base from '../vitest.config.mts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    setupFiles: ['/workspaces/dde/src/test-setup.services.ts'],
  },
});
