import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOrderDraft } from './order-draft-store';

/**
 * The draft lives in a store, outside the ticket component, for two reasons:
 * another widget can populate it, and — the one this file guards — it survives
 * the ticket being remounted.
 *
 * BUG-D, 2026-08-20 retest: while the chart was recovering from a wedge and
 * remounting the dock with it, a half-typed stop ticket reset itself twice —
 * order type dropped from Stop back to Market, entry, stop-loss and target all
 * cleared, with nothing said. Losing a ticket you are part-way through typing
 * is bad; doing it silently is worse.
 */

beforeEach(() => {
  sessionStorage.clear();
  useOrderDraft.setState({
    kind: 'market',
    volume: '0.01',
    price: '',
    stopLoss: '',
    stopLossUnit: 'price',
    takeProfit: '',
    takeProfitUnit: 'price',
    appliedFrom: null,
    side: null,
    volumeBySymbol: {},
  });
});

function halfTypedStop() {
  useOrderDraft.getState().set({
    kind: 'stop',
    price: '1.16759',
    stopLoss: '1.16632',
    takeProfit: '1.17032',
    volume: '0.05',
  });
}

describe('a draft that outlives the ticket', () => {
  it('keeps everything the trader typed when nothing but the component changed', () => {
    halfTypedStop();
    // A remount reads the store; it does not reset it. Nothing here should be
    // reachable except by the trader moving to another instrument.
    expect(useOrderDraft.getState()).toMatchObject({
      kind: 'stop',
      price: '1.16759',
      stopLoss: '1.16632',
      takeProfit: '1.17032',
    });
  });

  it('clears prices when the trader really does change instrument', () => {
    halfTypedStop();
    useOrderDraft.getState().resetForSymbol('EURUSD', 'XAUUSD');

    // Carrying a EURUSD stop price onto gold would be actively dangerous.
    const state = useOrderDraft.getState();
    expect(state.price).toBe('');
    expect(state.stopLoss).toBe('');
    expect(state.takeProfit).toBe('');
  });

  it('remembers each instrument its own size', () => {
    halfTypedStop();
    useOrderDraft.getState().resetForSymbol('EURUSD', 'XAUUSD');
    expect(useOrderDraft.getState().volume).toBe('0.01');

    useOrderDraft.getState().set({ volume: '0.2' });
    useOrderDraft.getState().resetForSymbol('XAUUSD', 'EURUSD');
    // 0.25 lots of EURUSD is not 0.25 lots of gold, so neither inherits the
    // other's size — and returning restores what was left there.
    expect(useOrderDraft.getState().volume).toBe('0.05');
  });
});

/**
 * The mechanism BUG-D actually had. `resetForSymbol` never touched `kind`, so
 * nothing in the app could turn Stop back into Market — only a fresh module
 * evaluation could, which is to say a page RELOAD. The terminal performs one on
 * its own: `reloadForStaleChunk` reloads when a lazy widget chunk 404s because
 * a deploy replaced the hashed assets under a running tab, which is exactly the
 * situation QA was testing in. A reload took the whole draft back to INITIAL —
 * order type Market, entry, stop and target empty — which is precisely what was
 * reported, Stop→Market included.
 *
 * So the ticket is restored across a reload, and the guarantee is narrow: a
 * reload should be invisible to it.
 */
describe('a draft that outlives a reload', () => {
  /** Boots a fresh store module against a given sessionStorage payload. */
  async function reboot(payload: unknown) {
    sessionStorage.setItem('tradeplatform.order-draft', JSON.stringify(payload));
    vi.resetModules();
    return (await import('./order-draft-store')).useOrderDraft;
  }

  it('brings back everything the trader had typed, order type included', async () => {
    const store = await reboot({
      kind: 'stop',
      volume: '0.05',
      price: '1.16759',
      stopLoss: '1.16632',
      takeProfit: '1.17032',
      stopLossUnit: 'price',
      takeProfitUnit: 'price',
      volumeBySymbol: { EURUSD: '0.05' },
      symbol: 'EURUSD',
    });
    store.getState().adoptSymbol('EURUSD');

    expect(store.getState()).toMatchObject({
      kind: 'stop',
      price: '1.16759',
      stopLoss: '1.16632',
      takeProfit: '1.17032',
      volume: '0.05',
    });
  });

  it('will not show one instrument’s prices against another', async () => {
    const store = await reboot({
      kind: 'stop',
      price: '1.16759',
      stopLoss: '1.16632',
      takeProfit: '1.17032',
      symbol: 'EURUSD',
      volumeBySymbol: { XAUUSD: '0.02' },
    });
    // The tab reloaded onto gold. A restored EURUSD stop price here is not a
    // stale field — it is a wrong number with nothing to mark it as wrong.
    store.getState().adoptSymbol('XAUUSD');

    const state = store.getState();
    expect(state.price).toBe('');
    expect(state.stopLoss).toBe('');
    expect(state.takeProfit).toBe('');
    // The per-symbol volume map is keyed by instrument and stays safe.
    expect(state.volumeBySymbol).toMatchObject({ XAUUSD: '0.02' });
    // And the SIZE is re-derived for the instrument on screen. Carrying 0.05
    // over from EURUSD would be a valid-looking number that silently resizes
    // the trade — the quieter and more dangerous half of the same mistake.
    expect(state.volume).toBe('0.02');
  });

  it('falls back to the default size for an instrument never traded before', async () => {
    const store = await reboot({ volume: '0.05', symbol: 'EURUSD', volumeBySymbol: {} });
    store.getState().adoptSymbol('XAUUSD');
    expect(store.getState().volume).toBe('0.01');
  });

  it('does not claim another widget just wrote the ticket', async () => {
    const store = await reboot({ price: '1.1', symbol: 'EURUSD', appliedFrom: 'Risk calculator' });
    store.getState().adoptSymbol('EURUSD');
    // "Values applied from Risk calculator" is a statement about something the
    // trader watched happen; it must not survive into a reloaded tab.
    expect(store.getState().appliedFrom).toBeNull();
  });

  it('starts empty rather than throwing when the stored draft is junk', async () => {
    sessionStorage.setItem('tradeplatform.order-draft', '{not json');
    vi.resetModules();
    const store = (await import('./order-draft-store')).useOrderDraft;
    expect(store.getState().kind).toBe('market');
    expect(store.getState().price).toBe('');
  });

  it('ignores stored values of the wrong shape', async () => {
    const store = await reboot({
      kind: 'nonsense',
      price: 42,
      volumeBySymbol: 'no',
      symbol: 'EURUSD',
    });
    expect(store.getState().kind).toBe('market');
    expect(store.getState().price).toBe('');
    expect(store.getState().volumeBySymbol).toEqual({});
  });

  it('mirrors every change so the next reload has something to restore', async () => {
    sessionStorage.removeItem('tradeplatform.order-draft');
    vi.resetModules();
    const store = (await import('./order-draft-store')).useOrderDraft;
    store.getState().adoptSymbol('EURUSD');
    store.getState().set({ kind: 'stop', price: '1.16759' });

    const written = JSON.parse(sessionStorage.getItem('tradeplatform.order-draft')!);
    expect(written).toMatchObject({ kind: 'stop', price: '1.16759', symbol: 'EURUSD' });
  });
});
