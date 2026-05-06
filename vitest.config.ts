import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Minimal vitest config. Wires the `@/*` path alias from
// `tsconfig.json` so unit tests can import application modules the
// same way the runtime does. Default `node` environment is fine for
// the current test surface (no React component tests yet — those will
// flip to `jsdom` per file via `// @vitest-environment jsdom`).

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
