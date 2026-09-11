import { z } from 'zod';

/**
 * Runtime-validated public client configuration.
 *
 * Only PUBLIC values belong here. Anything in `VITE_*` is compiled into the
 * bundle and readable by anyone — never put a secret, MT5 credential, JWT
 * signing key, or service token in this file or in `.env`.
 *
 * Validation runs once at startup and throws with a precise message rather
 * than letting a misconfigured build fail later with a confusing network error.
 */

const httpUrl = z
  .string()
  .min(1)
  .transform((v) => v.replace(/\/+$/, ''))
  .refine((v) => /^https?:\/\//.test(v), { message: 'must start with http:// or https://' });

const wsUrl = z
  .string()
  .min(1)
  .transform((v) => v.replace(/\/+$/, ''))
  .refine((v) => /^wss?:\/\//.test(v), { message: 'must start with ws:// or wss://' });

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  VITE_APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  VITE_GATEWAY_HTTP_URL: httpUrl,
  VITE_GATEWAY_WS_URL: wsUrl,
  VITE_CRM_HTTP_URL: httpUrl,
  VITE_BRAND_CONFIG_URL: z.string().optional(),
  VITE_DEFAULT_TIMEZONE: z.string().default('Etc/UTC'),
  // Omission must be distinguishable from an explicit false: in production,
  // the fail-safe default is to require confirmation before real money moves.
  VITE_CONFIRM_TRADES: z.string().optional(),
  VITE_ENABLE_ONE_CLICK_TRADING: bool,
  VITE_ENABLE_LEGACY_AUTH_STORAGE: bool,
  VITE_ALLOWED_HOST_ORIGINS: z.string().default(''),
  VITE_APP_VERSION: z.string().default('0.0.0-dev'),
  VITE_QUOTE_STALE_AFTER_MS: z.coerce.number().int().positive().default(12_000),
});

export type AppEnv = {
  appEnv: 'development' | 'staging' | 'production';
  gatewayHttpUrl: string;
  gatewayWsUrl: string;
  crmHttpUrl: string;
  brandConfigUrl: string | undefined;
  defaultTimezone: string;
  confirmTrades: boolean;
  enableOneClickTrading: boolean;
  enableLegacyAuthStorage: boolean;
  /** postMessage origins permitted to bootstrap a host session. */
  allowedHostOrigins: readonly string[];
  appVersion: string;
  /**
   * How long a snapshot may go without a frame before the UI must present it
   * as stale. The gateway pushes at a ~3s configured cadence, so the default
   * is four cadences.
   */
  quoteStaleAfterMs: number;
  isProduction: boolean;
};

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid runtime configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

export function parseEnv(raw: Record<string, unknown>): AppEnv {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const v = result.data;
  const isProduction = v.VITE_APP_ENV === 'production';

  // Plaintext transport is a development-only affordance. Refusing to boot is
  // the correct failure mode: silently downgrading a real-money session is not.
  if (isProduction) {
    const insecure: string[] = [];
    if (!v.VITE_GATEWAY_HTTP_URL.startsWith('https://'))
      insecure.push('VITE_GATEWAY_HTTP_URL must use https:// in production');
    if (!v.VITE_GATEWAY_WS_URL.startsWith('wss://'))
      insecure.push('VITE_GATEWAY_WS_URL must use wss:// in production');
    if (!v.VITE_CRM_HTTP_URL.startsWith('https://'))
      insecure.push('VITE_CRM_HTTP_URL must use https:// in production');
    if (v.VITE_ENABLE_LEGACY_AUTH_STORAGE)
      insecure.push(
        'VITE_ENABLE_LEGACY_AUTH_STORAGE must be off in production (see docs/architecture/frontend-architecture.md#auth-storage)',
      );
    if (insecure.length > 0) throw new EnvValidationError(insecure);
  }

  const allowedHostOrigins = v.VITE_ALLOWED_HOST_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  return {
    appEnv: v.VITE_APP_ENV,
    gatewayHttpUrl: v.VITE_GATEWAY_HTTP_URL,
    gatewayWsUrl: v.VITE_GATEWAY_WS_URL,
    crmHttpUrl: v.VITE_CRM_HTTP_URL,
    brandConfigUrl: v.VITE_BRAND_CONFIG_URL || undefined,
    defaultTimezone: v.VITE_DEFAULT_TIMEZONE,
    confirmTrades:
      v.VITE_CONFIRM_TRADES === undefined
        ? isProduction
        : v.VITE_CONFIRM_TRADES === 'true' || v.VITE_CONFIRM_TRADES === '1',
    enableOneClickTrading: v.VITE_ENABLE_ONE_CLICK_TRADING,
    enableLegacyAuthStorage: v.VITE_ENABLE_LEGACY_AUTH_STORAGE,
    allowedHostOrigins,
    appVersion: v.VITE_APP_VERSION,
    quoteStaleAfterMs: v.VITE_QUOTE_STALE_AFTER_MS,
    isProduction,
  };
}

declare global {
  interface Window {
    /**
     * Runtime configuration injected into index.html by the container
     * entrypoint. It lets ONE built image serve staging and production; values
     * here override the build-time `VITE_*` defaults.
     */
    __RUNTIME_CONFIG__?: Record<string, string>;
  }
}

/**
 * Merges the build-time and runtime sources.
 *
 * Runtime wins, but only for keys it actually sets — an empty string from the
 * entrypoint means "not configured" and must not blank out a build-time value
 * that is correct.
 */
function readRawConfig(): Record<string, unknown> {
  const buildTime = import.meta.env as unknown as Record<string, unknown>;
  const runtime = typeof window === 'undefined' ? undefined : window.__RUNTIME_CONFIG__;
  if (!runtime) return buildTime;

  const merged: Record<string, unknown> = { ...buildTime };
  for (const [key, value] of Object.entries(runtime)) {
    if (value !== '' && value !== undefined) merged[key] = value;
  }
  return merged;
}

let cached: AppEnv | null = null;

/** The validated environment. Throws once, at first access, if misconfigured. */
export function env(): AppEnv {
  cached ??= parseEnv(readRawConfig());
  return cached;
}

/** Test-only override. */
export function __setEnvForTests(value: AppEnv | null): void {
  cached = value;
}
