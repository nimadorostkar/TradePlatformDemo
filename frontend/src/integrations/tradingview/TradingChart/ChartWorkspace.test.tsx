import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { NO_CAPABILITIES } from '@/integrations/gateway/api/capabilities';
import { NO_SUFFIX_POLICY } from '@/integrations/gateway/mappers/symbol-suffix';
import { useCapabilities } from '@/stores/capabilities-store';
import { useSessionStore } from '@/stores/session-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import type { TradingTerminalWidgetOptions } from '../types';

/**
 * The race under test: capability discovery starts at "everything off", and
 * `disabled_features` is burned into the TradingView widget at construction.
 * A chart created BEFORE the gateway answers would carry DOM-off (and every
 * other capability default) for its entire lifetime.
 */

const constructedOptions: TradingTerminalWidgetOptions[] = [];

/** Every widget built so far, so a recreate can be inspected as such. */
const widgets: FakeWidget[] = [];

/**
 * How the next widget's canvases are laid out.
 *
 * `wedged` is the production failure: canvases laid out full-size with their
 * backing store still at the 300x150 HTML default, because nothing was ever
 * painted into them.
 */
let paint: 'wedged' | 'drawn' = 'drawn';

class FakeWidget {
  symbol: string;
  private readonly listeners: (() => void)[] = [];

  constructor(options: TradingTerminalWidgetOptions) {
    constructedOptions.push(options);
    widgets.push(this);
    this.symbol = String(options.symbol);

    const container = options.container as HTMLElement;
    const backing = paint === 'wedged' ? [300, 150] : [709, 751];
    for (const [width, height] of [backing, backing]) {
      const canvas = document.createElement('canvas');
      canvas.width = width!;
      canvas.height = height!;
      // jsdom lays nothing out, so the box is stubbed where the detector reads.
      Object.defineProperty(canvas, 'clientWidth', { value: 709 });
      Object.defineProperty(canvas, 'clientHeight', { value: 751 });
      container.append(canvas);
    }
  }

  onChartReady(callback: () => void): void {
    callback();
  }

  activeChart() {
    return {
      symbol: () => this.symbol,
      setSymbol: (next: string) => {
        this.symbol = next;
        for (const listener of this.listeners) listener();
      },
      setResolution: () => {},
      onSymbolChanged: () => ({
        subscribe: (_: unknown, handler: () => void) => this.listeners.push(handler),
      }),
      onIntervalChanged: () => ({ subscribe: () => {} }),
      getPanes: () => [],
    };
  }

  subscribe(): void {}
  changeTheme(): Promise<void> {
    return Promise.resolve();
  }
  remove(): void {}
}

const servicesStub = {
  market: { marketDepth: vi.fn(), symbolInfo: vi.fn() },
  pool: { subscribe: vi.fn(() => () => {}) },
  features: { executionsSince: vi.fn().mockResolvedValue([]) },
  tradingService: {},
  symbolCache: new Map<string, unknown>(),
};

vi.mock('@/app/providers/services', () => ({
  useServices: () => servicesStub,
  reportError: vi.fn(),
}));

const { ChartWorkspace } = await import('./ChartWorkspace');

/**
 * A working Storage for this suite.
 *
 * The environment these tests run in exposes a `localStorage` object with no
 * `setItem`, and the recovery ladder's storage work sits inside a try/catch —
 * so it silently did nothing here and the rungs that disarm the library's
 * persisted panels were never actually exercised by a test.
 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage(),
    configurable: true,
    writable: true,
  });
  constructedOptions.length = 0;
  widgets.length = 0;
  paint = 'drawn';
  useWorkspace.getState().setActiveSymbol('EURUSD');
  (window as unknown as { TradingView: unknown }).TradingView = { widget: FakeWidget };
  useCapabilities.getState().reset();
  useSessionStore.setState({
    activeLogin: '1001',
    suffixPolicy: NO_SUFFIX_POLICY,
    readOnly: false,
  });
});

describe('ChartWorkspace capability sequencing', () => {
  it('creates the widget only after discovery, with the discovered DOM state', async () => {
    render(<ChartWorkspace />);

    // Discovery has not answered: the primary pane must NOT have been
    // initialised against the "nothing available" defaults.
    await act(async () => {
      await Promise.resolve();
    });
    expect(constructedOptions).toHaveLength(0);

    act(() => {
      useCapabilities.getState().set({
        ...NO_CAPABILITIES,
        marketDepth: { enabled: true, reason: null },
      });
    });

    await waitFor(() => expect(constructedOptions).toHaveLength(1));
    // Exactly one widget for the pane — the capability answer delayed
    // creation, it did not recreate an earlier, wrongly-configured iframe.
    expect(constructedOptions[0]!.disabled_features).not.toContain('dom_widget');
  });

  it('keeps the DOM off for a deployment that does not serve market depth', async () => {
    render(<ChartWorkspace />);

    act(() => {
      useCapabilities.getState().set({ ...NO_CAPABILITIES });
    });

    await waitFor(() => expect(constructedOptions).toHaveLength(1));
    expect(constructedOptions[0]!.disabled_features).toContain('dom_widget');
  });
});

/**
 * The 2026-08-20 retest, as tests.
 *
 * BUG-A: two of four cold loads came up with every canvas at its 300×150
 * default inside a full-size pane. Nothing painted, and nothing said so for 95
 * seconds — the alarm was keyed to the history channel, which was connected and
 * answering throughout, so it had nothing to fire on.
 *
 * BUG-B: the same alarm fired over a fully drawn chart after rapid symbol
 * switching, because bars had last arrived under the previous symbol.
 *
 * BUG-C: recovering a wedge by clicking another symbol left the ticket saying
 * GBPUSD over a EURUSD series and scale, and one symbol behind on every switch
 * after that.
 */
describe('a pane judged by what is on its canvas', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Renders the workspace and lets capability discovery answer. */
  async function bootPane() {
    render(<ChartWorkspace />);
    await act(async () => {
      useCapabilities.getState().set({ ...NO_CAPABILITIES });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(constructedOptions.length).toBeGreaterThan(0);
  }

  /** Runs the pane's watchdog forward without waiting in real time. */
  async function elapse(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('spends the free remedy before anything the trader would miss', async () => {
    paint = 'wedged';
    localStorage.setItem('tradingview.widgetbar.widget.objecttree', 'open');
    localStorage.setItem('tradingview.drawings', 'the trader’s own work');
    await bootPane();

    // Every free re-measure is tried first, and none of them costs anything.
    await elapse(12_000);
    expect(constructedOptions).toHaveLength(1);
    expect(localStorage.getItem('tradingview.widgetbar.widget.objecttree')).toBe('open');

    await elapse(12_000);
    // Only now, with the free attempts spent, does the pane rebuild — and the
    // panel it disarms is the one the evidence implicates. Both wedged loads
    // in the retest came back with the Object tree panel restored open; the
    // clean one did not. Drawings are NOT the price of this rung.
    expect(constructedOptions.length).toBeGreaterThan(1);
    expect(localStorage.getItem('tradingview.widgetbar.widget.objecttree')).toBeNull();
    expect(localStorage.getItem('tradingview.drawings')).toBe('the trader’s own work');
  });

  it('says so, and recovers itself, when its canvases never leave 300×150', async () => {
    paint = 'wedged';
    await bootPane();
    expect(constructedOptions).toHaveLength(1);

    // Well past the point a real chart has drawn, and the pane is still silent:
    // the cheap re-measure gets its turn first and the trader is told nothing.
    await elapse(7_000);
    expect(screen.queryByText(/has not drawn yet/)).toBeNull();

    await elapse(15_000);
    // Both halves of the fix: the trader is told, AND the recovery the manual
    // workaround was standing in for happens without them having to find it.
    expect(screen.getByText(/has not drawn yet/)).toBeTruthy();
    expect(constructedOptions.length).toBeGreaterThan(1);
  });

  it('stays silent over a chart that has drawn, however its bars arrived', async () => {
    await bootPane();
    await elapse(40_000);
    // Twice the stall window over a painted pane. The old alarm fired here,
    // tore a working chart down and rebuilt it 40 seconds later.
    expect(screen.queryByText(/has not drawn yet/)).toBeNull();
    expect(constructedOptions).toHaveLength(1);
  });

  it('clears its banner once the pane paints, rather than latching on', async () => {
    paint = 'wedged';
    await bootPane();
    await elapse(25_000);
    const retry = screen.getByRole('button', { name: 'Retry' });

    // Whatever finally makes the pane draw — the trader's Retry, or the
    // rebuild the pane started for itself — the banner is an observation, not
    // a latch: it goes when the canvas says the chart is there.
    paint = 'drawn';
    await act(async () => {
      retry.click();
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByText(/has not drawn yet/)).toBeNull();
  });

  it('never accuses a pane in a background tab', async () => {
    // Chrome suspends requestAnimationFrame in a hidden tab, and the library
    // sizes its canvases inside rAF — so a backgrounded pane looks exactly
    // like the wedge and paints the moment the tab is fronted. Tearing that
    // chart down, and eventually stripping its saved layout, would be a
    // worse failure than the one this watchdog exists to catch.
    paint = 'wedged';
    await bootPane();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

    await elapse(60_000);
    expect(screen.queryByText(/has not drawn yet/)).toBeNull();
    expect(constructedOptions).toHaveLength(1);

    hidden.mockRestore();
  });

  it('gives a pane its full grace period from when the tab is fronted', async () => {
    paint = 'wedged';
    await bootPane();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await elapse(60_000);

    hidden.mockRestore();
    // Not accused the instant it becomes visible on time it spent hidden...
    await elapse(10_000);
    expect(screen.queryByText(/has not drawn yet/)).toBeNull();

    // ...but still caught if it really is wedged once on screen.
    await elapse(15_000);
    expect(screen.getByText(/has not drawn yet/)).toBeTruthy();
  });

  it('comes back from a wedge on the symbol the ticket is armed for', async () => {
    paint = 'wedged';
    await bootPane();
    expect(widgets[0]!.symbol).toBe('EURUSD');

    // The trader does what recovered a wedged pane by hand: clicks another
    // instrument in the watchlist.
    await act(async () => {
      useWorkspace.getState().setActiveSymbol('GBPUSD');
      await vi.advanceTimersByTimeAsync(10);
    });

    // The pane rebuilds itself while that switch is settling.
    paint = 'drawn';
    await elapse(25_000);
    expect(widgets.length).toBeGreaterThan(1);

    // The rebuilt widget must not come back on EURUSD. The effects that push a
    // symbol only fire when it CHANGES, so a pane rebuilt after the switch was
    // never told about it — which is how the ticket, header and chips read
    // GBPUSD over a EURUSD series, price scale and OHLC for 26 seconds.
    expect(widgets[widgets.length - 1]!.symbol).toBe('GBPUSD');
  });
});
