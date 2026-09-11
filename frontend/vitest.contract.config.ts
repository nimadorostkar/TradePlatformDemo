import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Read-only contract smoke tests against a CONFIGURED NON-PRODUCTION gateway.
 *
 * These never run as part of `npm test`. They only execute when
 * CONTRACT_GATEWAY_URL and CONTRACT_GATEWAY_TOKEN are supplied, and they are
 * restricted to read endpoints (health, server time, symbols, quotes, bars,
 * account snapshots, history). Transactional verification additionally
 * requires CONTRACT_ALLOW_TRADING=yes plus a disposable demo account, and is
 * intentionally not implemented here.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.contract.test.ts'],
    testTimeout: 30_000,
  },
});
