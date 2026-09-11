import { beforeEach, describe, expect, it, vi } from 'vitest';
import { retireLegacyChartQuantities } from './retire-legacy-quantities';

function fakeStorage() {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
    clear: () => entries.clear(),
  };
  // `Object.keys(localStorage)` must enumerate the stored keys, as it does on a
  // real Storage.
  return {
    entries,
    storage: new Proxy(storage, {
      ownKeys: () => [...entries.keys()],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    }) as unknown as Storage,
  };
}

describe('retireLegacyChartQuantities', () => {
  let entries: Map<string, string>;

  beforeEach(() => {
    const fake = fakeStorage();
    entries = fake.entries;
    vi.stubGlobal('localStorage', fake.storage);
  });

  it('deletes only the entries still holding the library default', () => {
    entries.set(
      'tradingview.trading.Broker',
      JSON.stringify({ qty: { EURUSD: 1, GBPUSD: 1, XAUUSD: 0.01, USDJPY: 0.5 } }),
    );

    retireLegacyChartQuantities();

    // Deleted, not rewritten: the library re-seeds each from the adapter's
    // qty.default, which is the instrument's own minimum. Nothing is invented.
    expect(JSON.parse(entries.get('tradingview.trading.Broker')!).qty).toEqual({
      XAUUSD: 0.01,
      USDJPY: 0.5,
    });
  });

  it('runs once per browser', () => {
    entries.set('tradingview.trading.Broker', JSON.stringify({ qty: { EURUSD: 1 } }));
    retireLegacyChartQuantities();
    expect(entries.get('opotrade.tv-qty-default.v2')).toBe('1');

    // A quantity the trader sets to 1 deliberately, later, must survive.
    entries.set('tradingview.trading.Broker', JSON.stringify({ qty: { EURUSD: 1 } }));
    retireLegacyChartQuantities();
    expect(JSON.parse(entries.get('tradingview.trading.Broker')!).qty).toEqual({ EURUSD: 1 });
  });

  it('leaves keys it does not understand alone', () => {
    entries.set('tradingview.trading.tradingPanelOpened', 'false');
    entries.set('tradingview.chartproperties', '{"timezone":"Etc/UTC"}');
    entries.set('opotrade.workspace.v3.default', '{"symbols":[]}');

    expect(() => retireLegacyChartQuantities()).not.toThrow();
    expect(entries.get('tradingview.trading.tradingPanelOpened')).toBe('false');
    expect(entries.get('tradingview.chartproperties')).toBe('{"timezone":"Etc/UTC"}');
    expect(entries.get('opotrade.workspace.v3.default')).toBe('{"symbols":[]}');
  });
});
