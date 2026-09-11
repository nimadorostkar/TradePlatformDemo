import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armSessionRenewal,
  canRetrySessionRenewal,
  validateGatewayToken,
  SESSION_RENEW_CHUNK_MS,
  SESSION_RENEW_SKEW_MS,
  SESSION_VALIDATE_INTERVAL_MS,
} from './session-renewal';
import { TradingError } from '@/domain/common/errors';
import type { GatewayHttpClient } from '@/integrations/gateway/api/http-client';

function httpAnswering(outcome: 'ok' | Error): GatewayHttpClient {
  return {
    request: () =>
      outcome === 'ok'
        ? Promise.resolve({ data: { serverTime: 1 }, requestId: 'r', receivedAt: 0 })
        : Promise.reject(outcome),
  } as unknown as GatewayHttpClient;
}

describe('session renewal scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires skewMs before expiry when the delay fits one chunk', () => {
    const onDue = vi.fn();
    armSessionRenewal(Date.now() + 30 * 60_000, onDue);

    vi.advanceTimersByTime(30 * 60_000 - SESSION_RENEW_SKEW_MS - 1);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it('walks a month-long delay in chunks instead of one int32-overflowing timer', () => {
    // A single setTimeout for 30 days overflows the signed 32-bit delay and
    // fires immediately — a renewal hammer-loop from the moment of sign-in.
    const onDue = vi.fn();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    armSessionRenewal(Date.now() + thirtyDays, onDue);

    // Immediately after arming nothing may fire (the overflow failure mode).
    vi.advanceTimersByTime(1000);
    expect(onDue).not.toHaveBeenCalled();

    // Walk to just before the due moment, chunk by chunk.
    vi.advanceTimersByTime(thirtyDays - SESSION_RENEW_SKEW_MS - 1000 - 1);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it('recomputes against the clock on each hop, so a slept-through expiry fires on the next hop', () => {
    // Browsers pause timers during laptop sleep. Each hop re-reads the clock,
    // so time that passed "outside" the timer shortens the remaining walk.
    const onDue = vi.fn();
    let clock = Date.now();
    armSessionRenewal(clock + 2 * SESSION_RENEW_CHUNK_MS + 60 * 60_000, onDue, {
      now: () => clock,
    });

    // First hop is pending. Simulate a long sleep: the wall clock jumps past
    // the expiry while the timer only advances one chunk.
    clock += 3 * SESSION_RENEW_CHUNK_MS;
    vi.advanceTimersByTime(SESSION_RENEW_CHUNK_MS);
    // The hop that just ran saw an already-due expiry and armed a zero-delay
    // final hop instead of walking the originally remaining chunks.
    vi.advanceTimersByTime(1);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it('returns null for a token without a parseable expiry', () => {
    expect(armSessionRenewal(null, vi.fn())).toBeNull();
  });

  it('cancel stops both a pending hop and the final timer', () => {
    const onDue = vi.fn();
    const cancel = armSessionRenewal(Date.now() + 10 * 60_000, onDue);
    cancel?.();
    vi.advanceTimersByTime(60 * 60_000);
    expect(onDue).not.toHaveBeenCalled();
  });

  it('floors the delay so a short replacement token cannot spin a request loop', () => {
    const onDue = vi.fn();
    armSessionRenewal(Date.now() - 1000, onDue, { minDelayMs: 15_000 });
    vi.advanceTimersByTime(14_999);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it('never retries after expiry', () => {
    expect(canRetrySessionRenewal(null, 100)).toBe(false);
    expect(canRetrySessionRenewal(99, 100)).toBe(false);
    expect(canRetrySessionRenewal(101, 100)).toBe(true);
  });
});

describe('periodic token validation', () => {
  it('checks every 20 minutes', () => {
    expect(SESSION_VALIDATE_INTERVAL_MS).toBe(20 * 60_000);
  });

  it('reports a token the gateway accepts as valid', async () => {
    await expect(validateGatewayToken(httpAnswering('ok'))).resolves.toBe('valid');
  });

  it('reports invalid ONLY on a definitive 401', async () => {
    const unauthorized = new TradingError({
      kind: 'unauthorized',
      code: 'http.401',
      message: 'expired',
      retryable: false,
    });
    await expect(validateGatewayToken(httpAnswering(unauthorized))).resolves.toBe('invalid');
  });

  it('treats network trouble as proof of nothing', async () => {
    const network = new TradingError({
      kind: 'network',
      code: 'http.network',
      message: 'unreachable',
      retryable: true,
    });
    await expect(validateGatewayToken(httpAnswering(network))).resolves.toBe('indeterminate');
    await expect(validateGatewayToken(httpAnswering(new Error('boom')))).resolves.toBe(
      'indeterminate',
    );
  });
});
