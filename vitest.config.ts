import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Minimal Vitest config. Wires the `@/*` path alias from `tsconfig.json`
// so unit tests can import application modules the same way the
// runtime does. Default `node` environment — DOM tests can opt in via
// the `// @vitest-environment jsdom` pragma.

export default defineConfig({
  // tsconfig sets `jsx: preserve` (Next compiles JSX itself); under Vitest's
  // esbuild transform that leaves component .tsx files with no JSX runtime, so
  // a client component using hooks throws "React is not defined" when rendered
  // to markup in a test. Pin the React 18 automatic runtime for the test build
  // — no `import React` needed at any call site, server or client component.
  esbuild: {
    jsx: 'automatic',
  },
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
