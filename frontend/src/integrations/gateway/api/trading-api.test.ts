import { describe, expect, it, vi } from 'vitest';
import { TradingError } from '@/domain/common/errors';
import { GatewayHttpClient } from './http-client';
import { interpretTradeResult, TradingApi } from './trading-api';
import type { DecimalString } from '@/domain/common/decimal';

/**
 * The single most safety-critical mapping in the app: turning a trade response
 * into a state the UI reports to the trader.
 *
 * The rule under test throughout: `accepted` only when the server said so, and
 * NEVER `filled` — a fill is confirmed by the authoritative position/order
 * state, not by the mutation response.
 */

describe('interpretTradeResult — raw MT5 PlaceOrderAnswer', () => {
  it('accepts a success retcode', () => {
    const result = interpretTradeResult(
      { Order: '123456', ResultRetcode: '10009', Comment: 'Request executed' },
      'req-1',
    );
    expect(result.state).toBe('accepted');
    expect(result.orderId).toBe('123456');
    expect(result.retcode).toBe('10009');
  });

  it('accepts a partial fill (10010) as accepted, not filled', () => {
    const result = interpretTradeResult({ Order: '1', ResultRetcode: '10010' }, 'req-2');
    expect(result.state).toBe('accepted');
  });

  it('throws a typed rejection for insufficient funds', () => {
    try {
      interpretTradeResult({ Order: '0', ResultRetcode: '10019' }, 'req-3');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TradingError);
      const tradingError = error as TradingError;
      expect(tradingError.kind).toBe('rejected');
      expect(tradingError.code).toBe('mt5.10019');
      expect(tradingError.message).toMatch(/not enough money/i);
      // A rejected trade must never be auto-retried.
      expect(tradingError.retryable).toBe(false);
    }
  });

  it('maps market-closed and invalid-stops rejections to readable text', () => {
    expect(() => interpretTradeResult({ Order: '0', ResultRetcode: '10018' }, 'r')).toThrow(
      /market is closed/i,
    );
    expect(() => interpretTradeResult({ Order: '0', ResultRetcode: '10016' }, 'r')).toThrow(
      /stop-loss or take-profit/i,
    );
  });

  it('keeps an unknown retcode visible instead of inventing friendly text', () => {
    try {
      interpretTradeResult({ Order: '0', ResultRetcode: '19999' }, 'r');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as TradingError).message).toContain('19999');
    }
  });

  it('preserves 64-bit ticket precision', () => {
    const result = interpretTradeResult(
      { Order: '9007199254740993', ResultRetcode: '10009' },
      'req-4',
    );
    expect(result.orderId).toBe('9007199254740993');
  });
});

describe('interpretTradeResult — Go gateway PlacedOrder shape', () => {
  it('accepts a non-rejected status', () => {
    const result = interpretTradeResult(
      { id: '777', symbol: 'EURUSD.', status: 6, message: 'ok' },
      'req-5',
    );
    expect(result.state).toBe('accepted');
    expect(result.orderId).toBe('777');
  });

  it('throws on the rejected status (5)', () => {
    // transform/enums.go#GetStatusType maps an unrecognised retcode to 5.
    expect(() =>
      interpretTradeResult({ id: '0', status: 5, message: 'Not enough money' }, 'req-6'),
    ).toThrow(TradingError);
  });

  it('never reports filled even when the status says Filled', () => {
    // Status 2 is the library's "Filled", but the mutation response is not
    // authoritative — the position snapshot is.
    const result = interpretTradeResult({ id: '888', status: 2 }, 'req-7');
    expect(result.state).toBe('accepted');
    expect(result.state).not.toBe('filled');
  });
});

describe('interpretTradeResult — legacy .NET shape', () => {
  it('accepts the { order, mTresult, answer } shape the staging backend returns', () => {
    // See docs/integration/contract-discrepancies.md#D1 — the working broker
    // adapter reads this shape, so it must keep working.
    const result = interpretTradeResult(
      { order: { id: '999' }, mTresult: 1, answer: 'Done' },
      'req-8',
    );
    expect(result.state).toBe('accepted');
    expect(result.orderId).toBe('999');
  });

  it('throws when mTresult is 0 (rejected)', () => {
    try {
      interpretTradeResult(
        { order: { id: '0' }, mTresult: 0, answer: 'Not enough money' },
        'req-9',
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as TradingError).kind).toBe('rejected');
      expect((error as TradingError).message).toBe('Not enough money');
    }
  });
});

describe('interpretTradeResult — MT5 retcodes carry their text', () => {
  /**
   * MT5 sends `"10009 Done"`, never a bare `"10009"` — verified by running the
   * shipped gateway against its own MT5 stand-in. Matching the raw string meant
   * NO retcode was ever recognised as a success, and the gateway's own derived
   * `status` field has the same defect (`GetStatusType` is an exact-match table
   * keyed on the bare number, defaulting to 5 = Rejected). Between them, every
   * completed order was reported to the trader as refused.
   */
  it('accepts "10009 Done"', () => {
    const result = interpretTradeResult(
      { Order: '123456', ResultRetcode: '10009 Done', Comment: 'Request executed' },
      'req-r1',
    );
    expect(result.state).toBe('accepted');
    expect(result.retcode).toBe('10009');
  });

  it('rejects "10019 No money" with the right code and text', () => {
    try {
      interpretTradeResult({ Order: '0', ResultRetcode: '10019 No money' }, 'req-r2');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as TradingError).code).toBe('mt5.10019');
      expect((error as TradingError).message).toMatch(/not enough money/i);
    }
  });

  it('treats an MT5 timeout (10012) as undecided, never as a rejection', () => {
    const result = interpretTradeResult({ Order: '0', ResultRetcode: '10012 Timeout' }, 'req-r3');
    expect(result.state).toBe('unknown');
  });
});

describe('interpretTradeResult — the gateway states its verdict', () => {
  /**
   * The shipped PlacedOrder carries `outcome` and tells clients to branch on
   * it: "never infer acceptance from the shape itself". It outranks `status`,
   * which is derived and wrong for every real retcode.
   */
  it('trusts outcome=accepted over a status of 5', () => {
    const result = interpretTradeResult(
      {
        id: '100002',
        status: 5,
        resultRetcode: '10009 Done',
        outcome: 'accepted',
        retcodeDescription: 'Request completed',
        message: '',
      },
      'req-o1',
    );
    expect(result.state).toBe('accepted');
    expect(result.orderId).toBe('100002');
    expect(result.retcode).toBe('10009');
  });

  it('reports outcome=rejected with MT5’s own reason', () => {
    try {
      interpretTradeResult(
        { id: '0', status: 5, resultRetcode: '10019 No money', outcome: 'rejected' },
        'req-o2',
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as TradingError).code).toBe('mt5.10019');
    }
  });

  it('reads the {order:0,status:5,outcome:"unknown"} fallback as undecided', () => {
    // internal/domain/trade.go#unknownOutcome. `status:5` reads as rejected on
    // its own, but the submission reached MT5 — the order may be live.
    const result = interpretTradeResult(
      {
        order: 0,
        status: 5,
        outcome: 'unknown',
        resultRetcode: '',
        message: 'Trade result could not be read from MT5; reconcile against Positions.',
      },
      'req-o3',
    );
    expect(result.state).toBe('unknown');
    expect(result.orderId).toBeNull();
    expect(result.message).toMatch(/reconcile/i);
  });

  it('does not guess when the outcome word is one it has never seen', () => {
    const result = interpretTradeResult({ id: '5', status: 2, outcome: 'deferred' }, 'req-o4');
    expect(result.state).toBe('unknown');
  });
});

describe('an unreadable trade reply reconciles instead of reporting failure', () => {
  /**
   * Several gateway paths answer 200/success with something that is not a
   * trade result at all — an empty dealer body, a result poll that came back in
   * a shape it could not read. All of them have ALREADY sent the request to
   * MT5. Reporting "this app does not understand" told the trader nothing had
   * happened and invited an immediate resubmit; the second click is a duplicate
   * position.
   */
  function apiReturning(data: unknown, envelope: { success?: boolean; status?: number } = {}) {
    const success = envelope.success ?? true;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ data, errorMessage: null, message: null, success }), {
          status: envelope.status ?? (success ? 200 : 400),
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const http = new GatewayHttpClient({
      baseUrl: 'https://gateway.test',
      getToken: () => 'token',
      fetchImpl,
    });
    return new TradingApi(http, () => true);
  }

  const request = {
    login: '1010',
    gatewaySymbol: 'EURUSD.',
    side: 'buy' as const,
    volumeLots: '1' as DecimalString,
    price: '1.0850' as DecimalString,
    digits: 5,
  };

  it('reports an unparseable payload as unknown, not as an error', async () => {
    const result = await apiReturning({ nothing: 'recognisable' }).openPosition(request);

    expect(result.state).toBe('unknown');
    expect(result.message).toMatch(/check positions/i);
    // The defect itself is still recorded for support.
    expect(result.diagnostic?.kind).toBe('contract');
  });

  it('reports a null payload as unknown', async () => {
    const result = await apiReturning(null).openPosition(request);
    expect(result.state).toBe('unknown');
  });

  it('names the mismatch in the diagnostic instead of "Invalid input"', async () => {
    const result = await apiReturning({ retcode: '0 Done', answer: { '777': [] } }).openPosition(
      request,
    );

    // A union error hides every branch's objection behind one top-level
    // "Invalid input"; without expanding it the diagnostic named nothing.
    expect(result.diagnostic?.detail).toMatch(/received object\{retcode, answer\}/);
    expect(result.diagnostic?.detail).not.toBe('(root): Invalid input');
  });

  it('reads an undecided outcome out of a FAILURE envelope', async () => {
    // The gateway rides `unknownOutcome` on success=false. The envelope alone
    // says "could not complete"; only the body says the order may be live.
    const result = await apiReturning(
      {
        order: 0,
        status: 5,
        outcome: 'unknown',
        message: 'Trade result could not be read from MT5; reconcile against Positions.',
      },
      { success: false },
    ).openPosition(request);

    expect(result.state).toBe('unknown');
    expect(result.message).toMatch(/reconcile against Positions/);
  });

  it('still fails hard when the gateway says the submission never left', async () => {
    // "Idempotency store unavailable; submission not attempted" carries no
    // outcome the trade may be live under — this one IS a failure.
    await expect(
      apiReturning({ error: 'submission not attempted' }, { success: false }).openPosition(request),
    ).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('TradingError semantics', () => {
  it('never marks a rejection retryable', () => {
    const error = new TradingError({ kind: 'rejected', message: 'no' });
    expect(error.retryable).toBe(false);
  });

  it('marks transport failures retryable', () => {
    expect(new TradingError({ kind: 'network', message: 'x' }).retryable).toBe(true);
    expect(new TradingError({ kind: 'unavailable', message: 'x' }).retryable).toBe(true);
  });

  it('carries a request id for tracing', () => {
    const error = new TradingError({ kind: 'unknown', message: 'x' });
    expect(error.requestId).toBeTruthy();
  });
});
