import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { __setEnvForTests, type AppEnv } from '@/app/config/env';

/**
 * Test environment.
 *
 * Mocking happens at the NETWORK boundary only. Production code never
 * fabricates market or account data — see docs/architecture/frontend-architecture.md.
 */

export const TEST_ENV: AppEnv = {
  appEnv: 'development',
  gatewayHttpUrl: 'http://gateway.test',
  gatewayWsUrl: 'ws://gateway.test',
  crmHttpUrl: 'https://crm.test',
  tradingViewLibraryPath: '/charting_library/',
  brandConfigUrl: undefined,
  defaultTimezone: 'Etc/UTC',
  confirmTrades: true,
  enableOneClickTrading: false,
  enableLegacyAuthStorage: false,
  allowedHostOrigins: ['https://host.test'],
  appVersion: '0.0.0-test',
  quoteStaleAfterMs: 12_000,
  isProduction: false,
};

beforeEach(() => {
  __setEnvForTests(TEST_ENV);
  // Not every environment this suite runs in exposes a full Storage (the
  // contract config uses `node`), so clearing is best-effort.
  if (typeof localStorage !== 'undefined' && typeof localStorage.clear === 'function') {
    localStorage.clear();
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __setEnvForTests(null);
});

// jsdom lacks these; several components observe or query them.
if (!('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (!('ResizeObserver' in globalThis)) {
  // Minimal stand-in for the virtualiser and the panel library.
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
