import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        // Main process (Node). 'electron' is aliased to a lightweight manual mock.
        resolve: { alias: { electron: join(__dir, 'tests/helpers/electron-mock.ts') } },
        test: {
          name: 'main',
          environment: 'node',
          include: ['tests/main/**/*.test.ts'],
        },
      },
      {
        // Renderer (React) — jsdom + Testing Library.
        plugins: [react()],
        define: { __APP_VERSION__: JSON.stringify('test') },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.{ts,tsx}'],
          setupFiles: [join(__dir, 'tests/renderer/setup.ts')],
        },
      },
    ],
  },
});
