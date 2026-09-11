import { describe, expect, it, vi } from 'vitest';
import type { MarketApi } from './api/market-api';
import { probeSuffix } from './suffix-probe';
import { useSessionStore } from '@/stores/session-store';
import { SymbolSuffixPolicy } from './mappers/symbol-suffix';

/**
 * The probe corrects a wrong symbol dialect ONLY on hard evidence, and only
 * ever to bare names — several suffixed dialects can coexist server-wide, so
 * choosing among them would risk charting another group's prices. Everything
 * else is reported or ignored; a network blip during account activation must
 * never rewrite how order symbols are built.
 */

function marketWith(answers: Record<string, unknown[] | Error>): MarketApi {
  return {
    dailyBars: vi.fn().mockImplementation(({ symbol }: { symbol: string }) => {
      const answer = answers[symbol];
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer ?? []);
    }),
  } as unknown as MarketApi;
}

const bar = { time: 1_700_000_000, open: 1.1, high: 1.2, low: 1.0, close: 1.15, volume: 10 };

describe('probeSuffix', () => {
  it('reports ok for a working dialect and asks nothing further', async () => {
    const market = marketWith({ 'EURUSD#': [bar] });
    await expect(probeSuffix(market, '#')).resolves.toEqual({ outcome: 'ok' });
    expect((market.dailyBars as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('corrects to bare names when the suffixed name is dead and the bare one lives', async () => {
    // The live Social PRO failure: "#" configured, EURUSD# serves nothing,
    // EURUSD serves history.
    const market = marketWith({ 'EURUSD#': [], EURUSD: [bar] });
    await expect(probeSuffix(market, '#')).resolves.toEqual({ outcome: 'corrected', suffix: '' });
  });

  it('reports a dead BARE dialect with suffixed survivors instead of guessing', async () => {
    // The live "ECN Pro" failure: bare names configured, bare EURUSD serves no
    // history — while suffixed groups exist. Adopting one silently could chart
    // another group's prices; the operator must configure the true suffix.
    const market = marketWith({ EURUSD: [], 'EURUSD.': [bar], 'EURUSD!': [bar] });
    await expect(probeSuffix(market, '')).resolves.toEqual({
      outcome: 'misconfigured',
      configured: '',
      alive: ['.', '!'],
    });
  });

  it('reports a dead suffixed dialect whose only survivors are other suffixes', async () => {
    const market = marketWith({ 'EURUSD#': [], EURUSD: [], 'EURUSD!': [bar] });
    await expect(probeSuffix(market, '#')).resolves.toEqual({
      outcome: 'misconfigured',
      configured: '#',
      alive: ['!'],
    });
  });

  it('is indeterminate when no dialect serves history', async () => {
    // An instrument invisible to the whole server proves nothing.
    const market = marketWith({});
    await expect(probeSuffix(market, '#')).resolves.toEqual({ outcome: 'indeterminate' });
  });

  it('is indeterminate on a network failure of the configured dialect', async () => {
    const market = marketWith({ 'EURUSD#': new Error('gateway down'), EURUSD: [bar] });
    await expect(probeSuffix(market, '#')).resolves.toEqual({ outcome: 'indeterminate' });
  });
});

describe('session-store correctSuffix', () => {
  it('applies only to the account the probe ran for', () => {
    useSessionStore.setState({
      activeLogin: '1001',
      suffixPolicy: new SymbolSuffixPolicy('#'),
    });

    // A stale probe from a previous account must not leak onto this one.
    useSessionStore.getState().correctSuffix('9999', '');
    expect(useSessionStore.getState().suffixPolicy.suffix).toBe('#');

    useSessionStore.getState().correctSuffix('1001', '');
    expect(useSessionStore.getState().suffixPolicy.suffix).toBe('');
  });
});
