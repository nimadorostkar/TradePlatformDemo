import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Node ≥ 22 ships its own Web Storage behind a flag; on Node 25 merely touching
// `localStorage` (which every jsdom test does) prints "`--localstorage-file`
// was provided without a valid path" once per worker. jsdom supplies the
// storage the tests want, so Node's is switched off where the flag exists.
const nodeMajor = Number(process.versions.node.split('.')[0]);
const workerArgs = nodeMajor >= 22 ? ['--no-experimental-webstorage'] : [];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    poolOptions: { forks: { execArgv: workerArgs }, threads: { execArgv: workerArgs } },
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Contract smoke tests talk to a real non-production gateway and are opt-in.
    exclude: ['node_modules/**', 'e2e/**', 'src/**/*.contract.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts'],
    },
  },
});
