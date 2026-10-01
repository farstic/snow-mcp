import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // desktop/ is the separate Electron app with its own package.json, dependencies and
    // vitest/playwright configs; run its tests from desktop/, not from the root.
    exclude: [...configDefaults.exclude, 'desktop/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'tests/', 'dist/']
    }
  }
});
