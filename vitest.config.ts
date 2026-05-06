import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Minimal Vitest config. Tests live next to the code under test
// (`src/**/*.test.ts`). Node environment by default — DOM tests can
// opt in via the `// @vitest-environment jsdom` pragma.

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', '.next', 'legacy'],
    globals: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
