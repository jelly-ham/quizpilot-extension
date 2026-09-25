import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so tests don't run the crx/preact build plugins.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
});
