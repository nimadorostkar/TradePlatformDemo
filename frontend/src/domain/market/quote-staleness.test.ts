import { describe, expect, it } from 'vitest';
import type { Quote } from '@/domain/common/models';
import { formatQuoteAge, isQuoteStale, QUOTE_STALE_AFTER_MS, quoteAgeMs } from './quote-staleness';

const NOW = 1_786_029_053_000;

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: 'XAUUSD',
    bid: '4264.78',
    ask: '4264.99',
    last: '4264.78',
    volume: '1',
    receivedAt: NOW,
    brokerTime: NOW,
    direction: 'flat',
    ...overrides,
  };
}

describe('quote staleness', () => {
  it('treats a quote printed just now as live', () => {
    expect(isQuoteStale(quote({ brokerTime: NOW - 1_000 }), NOW)).toBe(false);
  });

  it('flags a quote older than the threshold', () => {
    expect(isQuoteStale(quote({ brokerTime: NOW - QUOTE_STALE_AFTER_MS - 1 }), NOW)).toBe(true);
  });

  it('judges age on broker time, not on when the frame arrived', () => {
    // The socket is healthy and delivering on cadence; the PRICE is from Friday.
    // Judging on receivedAt would call this live, which is the whole failure
    // this indicator exists to prevent.
    const friday = quote({ brokerTime: NOW - 48 * 3600 * 1000, receivedAt: NOW });
    expect(isQuoteStale(friday, NOW)).toBe(true);
  });

  it('tolerates a client clock running slightly ahead of the broker', () => {
    // A couple of seconds of skew must never light up the indicator.
    expect(isQuoteStale(quote({ brokerTime: NOW - 3_000 }), NOW)).toBe(false);
  });

  it('does not flag a clock running behind the broker as stale', () => {
    // Negative age: our clock is behind. Not stale, just skewed.
    expect(isQuoteStale(quote({ brokerTime: NOW + 5_000 }), NOW)).toBe(false);
  });

  it('never flags staleness when the gateway sends no broker time', () => {
    // An older gateway cannot answer this question. Flagging every price would
    // train users to ignore the indicator.
    expect(isQuoteStale(quote({ brokerTime: null }), NOW)).toBe(false);
    expect(quoteAgeMs(quote({ brokerTime: null }), NOW)).toBeNull();
  });

  it('reports no age for a symbol with no quote at all', () => {
    expect(quoteAgeMs(undefined, NOW)).toBeNull();
    expect(isQuoteStale(undefined, NOW)).toBe(false);
  });

  it('formats an age at the coarsest useful unit', () => {
    expect(formatQuoteAge(45_000)).toBe('45s');
    expect(formatQuoteAge(10 * 60_000)).toBe('10m');
    expect(formatQuoteAge(5 * 3600_000)).toBe('5h');
    expect(formatQuoteAge(3 * 24 * 3600_000)).toBe('3d');
  });
});
