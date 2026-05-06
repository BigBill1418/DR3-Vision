import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Minimal Vitest config. Wires the `@/*` path alias from `tsconfig.json`
// so unit tests can import application modules the same way the
// runtime does. Default `node` environment — DOM tests can opt in via
// the `// @vitest-environment jsdom` pragma.

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/__tests__/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'legacy'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
