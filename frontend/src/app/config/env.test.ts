import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from './env';

/**
 * The configuration layer is a production safety control, not a convenience.
 *
 * The shipped bundle carries production defaults and `runtime-config.js`
 * overrides them so one artifact can serve several environments. Both halves
 * of that arrangement are tested here, because a silent misconfiguration would
 * point a real-money terminal at the wrong server.
 */

const PRODUCTION = {
  VITE_APP_ENV: 'production',
  VITE_GATEWAY_HTTP_URL: 'https://terminal.example.com/gateway',
  VITE_GATEWAY_WS_URL: 'wss://terminal.example.com/gateway',
  VITE_CRM_HTTP_URL: 'https://terminal.example.com/crm',
};

describe('production hardening', () => {
  it('accepts a fully secure production configuration', () => {
    const env = parseEnv(PRODUCTION);
    expect(env.isProduction).toBe(true);
    expect(env.gatewayHttpUrl).toBe('https://terminal.example.com/gateway');
  });

  it('REFUSES to start on a plaintext gateway URL in production', () => {
    // Silently downgrading a real-money session to plaintext is the failure
    // this check exists to prevent.
    expect(() =>
      parseEnv({ ...PRODUCTION, VITE_GATEWAY_HTTP_URL: 'http://127.0.0.1:5063' }),
    ).toThrow(EnvValidationError);
  });

  it('REFUSES to start on a plaintext WebSocket URL in production', () => {
    expect(() => parseEnv({ ...PRODUCTION, VITE_GATEWAY_WS_URL: 'ws://127.0.0.1:5063' })).toThrow(
      EnvValidationError,
    );
  });

  it('REFUSES legacy localStorage token mirroring in production', () => {
    expect(() => parseEnv({ ...PRODUCTION, VITE_ENABLE_LEGACY_AUTH_STORAGE: 'true' })).toThrow(
      /legacy_auth_storage/i,
    );
  });

  it('permits plaintext in development', () => {
    const env = parseEnv({
      VITE_APP_ENV: 'development',
      VITE_GATEWAY_HTTP_URL: 'http://localhost:5063',
      VITE_GATEWAY_WS_URL: 'ws://localhost:5063',
      VITE_CRM_HTTP_URL: 'https://crm.example.com',
    });
    expect(env.isProduction).toBe(false);
  });

  it('reports every problem at once rather than one at a time', () => {
    try {
      parseEnv({
        ...PRODUCTION,
        VITE_GATEWAY_HTTP_URL: 'http://a.test',
        VITE_GATEWAY_WS_URL: 'ws://a.test',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as EnvValidationError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('rejects a missing gateway URL outright', () => {
    expect(() => parseEnv({ VITE_APP_ENV: 'production' })).toThrow(EnvValidationError);
  });
});

describe('defaults', () => {
  it('applies safe defaults for optional settings', () => {
    const env = parseEnv(PRODUCTION);
    expect(env.tradingViewLibraryPath).toBe('/charting_library/');
    expect(env.enableOneClickTrading).toBe(false);
    expect(env.enableLegacyAuthStorage).toBe(false);
    // Four times the gateway's ~3s push cadence.
    expect(env.quoteStaleAfterMs).toBe(12_000);
  });

  it('treats an empty host-origin list as "not embeddable"', () => {
    expect(parseEnv(PRODUCTION).allowedHostOrigins).toEqual([]);
  });

  it('parses a comma-separated host-origin allowlist', () => {
    const env = parseEnv({
      ...PRODUCTION,
      VITE_ALLOWED_HOST_ORIGINS: 'https://a.example.com, https://b.example.com',
    });
    expect(env.allowedHostOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('strips trailing slashes so URL construction cannot double up', () => {
    const env = parseEnv({ ...PRODUCTION, VITE_GATEWAY_HTTP_URL: 'https://a.test/gateway/' });
    expect(env.gatewayHttpUrl).toBe('https://a.test/gateway');
  });

  it('reads booleans from both "true" and "1"', () => {
    expect(parseEnv({ ...PRODUCTION, VITE_CONFIRM_TRADES: 'true' }).confirmTrades).toBe(true);
    expect(parseEnv({ ...PRODUCTION, VITE_CONFIRM_TRADES: '1' }).confirmTrades).toBe(true);
    expect(parseEnv({ ...PRODUCTION, VITE_CONFIRM_TRADES: 'false' }).confirmTrades).toBe(false);
    expect(parseEnv(PRODUCTION).confirmTrades).toBe(true);
  });
});
