import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { memo } from 'react';
import type { DecimalString } from '@/domain/common/decimal';
import { quoteStore, useQuote } from './quote-store';

const d = (v: string) => v as DecimalString;

/**
 * Ticks, then waits for the store's fan-out.
 *
 * The store renders at most once per frame rather than once per tick, so that
 * a burst of quotes cannot outrun React (see FLUSH_INTERVAL_MS). Every
 * assertion about RENDERING therefore has to let that gap elapse; assertions
 * about the stored VALUE do not, because the map is written synchronously.
 */
async function tickAndRender(fn: () => void): Promise<void> {
  await act(async () => {
    fn();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function tick(symbol: string, bid: string, ask: string, last = bid, brokerTime = Date.now()) {
  quoteStore.apply({
    symbol,
    bid: d(bid),
    ask: d(ask),
    last: d(last),
    volume: null,
    receivedAt: Date.now(),
    brokerTime,
  });
}

beforeEach(() => {
  quoteStore.clear();
});

describe('quoteStore', () => {
  it('advances the broker time even when the price is unchanged', () => {
    // A quiet instrument reprints the SAME price with a newer broker stamp.
    // The store short-circuits that update to avoid a re-render, and if it
    // dropped the timestamp a perfectly live market would decay into a false
    // "stale" badge just for not moving.
    tick('EURUSD.', '1.1000', '1.1002', '1.1000', 1_000);
    tick('EURUSD.', '1.1000', '1.1002', '1.1000', 61_000);

    expect(quoteStore.get('EURUSD.')?.brokerTime).toBe(61_000);
  });

  it('stores and returns a quote by symbol', () => {
    tick('EURUSD.', '1.1000', '1.1002');
    expect(quoteStore.get('EURUSD.')?.bid).toBe('1.1000');
  });

  it('computes the tick direction', () => {
    tick('EURUSD.', '1.1000', '1.1002', '1.1000');
    expect(quoteStore.get('EURUSD.')?.direction).toBe('flat');

    tick('EURUSD.', '1.1005', '1.1007', '1.1005');
    expect(quoteStore.get('EURUSD.')?.direction).toBe('up');

    tick('EURUSD.', '1.1001', '1.1003', '1.1001');
    expect(quoteStore.get('EURUSD.')?.direction).toBe('down');
  });

  it('keeps the previous direction on an unchanged price', () => {
    // Flickering the arrow to neutral on every repeated tick would be noise.
    tick('EURUSD.', '1.1000', '1.1002', '1.1000');
    tick('EURUSD.', '1.1005', '1.1007', '1.1005');
    tick('EURUSD.', '1.1005', '1.1007', '1.1005');
    expect(quoteStore.get('EURUSD.')?.direction).toBe('up');
  });

  it('clears every quote on account switch', () => {
    tick('EURUSD.', '1.1', '1.2');
    tick('GBPUSD.', '1.3', '1.4');
    quoteStore.clear();
    expect(quoteStore.get('EURUSD.')).toBeUndefined();
    expect(quoteStore.get('GBPUSD.')).toBeUndefined();
  });
});

describe('render isolation', () => {
  it('a tick in one symbol does NOT re-render another symbol’s cell', async () => {
    // The core performance guarantee: one tick must not re-render the whole
    // watchlist, table, header, or chart shell.
    const eurRenders = vi.fn();
    const gbpRenders = vi.fn();

    const Cell = memo(function Cell({
      symbol,
      onRender,
    }: {
      symbol: string;
      onRender: () => void;
    }) {
      const quote = useQuote(symbol);
      onRender();
      return <span data-testid={symbol}>{quote?.bid ?? '—'}</span>;
    });

    render(
      <>
        <Cell symbol="EURUSD." onRender={eurRenders} />
        <Cell symbol="GBPUSD." onRender={gbpRenders} />
      </>,
    );

    const eurBaseline = eurRenders.mock.calls.length;
    const gbpBaseline = gbpRenders.mock.calls.length;

    await tickAndRender(() => tick('EURUSD.', '1.1050', '1.1052', '1.1050'));

    expect(eurRenders.mock.calls.length).toBeGreaterThan(eurBaseline);
    // The GBP cell must not have re-rendered at all.
    expect(gbpRenders.mock.calls.length).toBe(gbpBaseline);
    expect(screen.getByTestId('EURUSD.')).toHaveTextContent('1.1050');
  });

  it('renders once for a burst, not once per frame in it', async () => {
    // The defect this guards: a burst of frames used to become a chain of
    // synchronous React renders, and past fifty React aborts with "Maximum
    // update depth exceeded" — a real exception in the production console on
    // load. Fifty ticks must now cost a small number of renders, not fifty.
    const onRender = vi.fn();

    const Cell = memo(function Cell({ symbol }: { symbol: string }) {
      const quote = useQuote(symbol);
      onRender();
      return <span data-testid="burst">{quote?.bid ?? '—'}</span>;
    });

    render(<Cell symbol="EURUSD." />);
    const baseline = onRender.mock.calls.length;

    await tickAndRender(() => {
      for (let i = 1; i <= 50; i++) {
        tick(
          'EURUSD.',
          `1.10${String(i).padStart(2, '0')}`,
          '1.2000',
          `1.10${String(i).padStart(2, '0')}`,
        );
      }
    });

    expect(onRender.mock.calls.length - baseline).toBeLessThan(5);
    // And the price shown is the LAST one, not the one the render caught.
    expect(screen.getByTestId('burst')).toHaveTextContent('1.1050');
  });

  it('does not notify when nothing visible changed', async () => {
    const onRender = vi.fn();

    const Cell = memo(function Cell({ symbol }: { symbol: string }) {
      const quote = useQuote(symbol);
      onRender();
      return <span>{quote?.bid ?? '—'}</span>;
    });

    render(<Cell symbol="EURUSD." />);
    await tickAndRender(() => tick('EURUSD.', '1.1000', '1.1002', '1.1000'));

    const baseline = onRender.mock.calls.length;

    // An identical tick still updates the receive time (so staleness stays
    // accurate) but must not trigger a render. Waited out rather than asserted
    // immediately, so this proves no render happened rather than proving only
    // that none had happened YET.
    await tickAndRender(() => tick('EURUSD.', '1.1000', '1.1002', '1.1000'));

    expect(onRender.mock.calls.length).toBe(baseline);
    expect(quoteStore.get('EURUSD.')?.receivedAt).toBeGreaterThan(0);
  });
});
