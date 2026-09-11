import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChartController, type ChartControllerOptions } from './chart-controller';
import type { TradingTerminalWidgetOptions } from '../types';

/**
 * Feature gating burned into the widget at construction.
 *
 * `disabled_features` cannot be changed after the widget exists, so what these
 * tests assert is exactly what a trader gets for the pane's whole lifetime.
 */

interface ConstructedWidget {
  options: TradingTerminalWidgetOptions;
}

const constructed: ConstructedWidget[] = [];

class FakeWidget {
  constructor(options: TradingTerminalWidgetOptions) {
    constructed.push({ options });
  }
  onChartReady(): void {
    /* never fires in these tests */
  }
  remove(): void {
    /* no-op */
  }
}

function install(): void {
  (window as unknown as { TradingView: unknown }).TradingView = {
    widget: FakeWidget,
  };
}

function options(overrides: Partial<ChartControllerOptions>): ChartControllerOptions {
  return {
    container: document.createElement('div'),
    libraryPath: '/charting_library/',
    symbol: 'EURUSD',
    interval: '1',
    theme: 'dark',
    timezone: 'Etc/UTC',
    datafeed: {} as ChartControllerOptions['datafeed'],
    saveLoadAdapter: {} as ChartControllerOptions['saveLoadAdapter'],
    enableTrading: true,
    brokerFactory: () => ({}) as never,
    debug: false,
    onReady: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  constructed.length = 0;
  delete (window as unknown as { TradingView?: unknown }).TradingView;
});

describe('ChartController ready watchdog', () => {
  it('reports a widget that never becomes ready, once, and not after ready', async () => {
    vi.useFakeTimers();
    try {
      install();
      const onReadyTimeout = vi.fn();
      const controller = await ChartController.create(
        options({ onReadyTimeout, readyTimeoutMs: 1_000 }),
      );

      // The library wedge this guards against raises nothing — only silence.
      await vi.advanceTimersByTimeAsync(1_100);
      expect(onReadyTimeout).toHaveBeenCalledTimes(1);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays quiet when the chart becomes ready in time', async () => {
    vi.useFakeTimers();
    try {
      let readyCallback: (() => void) | null = null;
      class ReadyWidget {
        constructor(widgetOptions: TradingTerminalWidgetOptions) {
          constructed.push({ options: widgetOptions });
        }
        onChartReady(callback: () => void): void {
          readyCallback = callback;
        }
        activeChart() {
          throw new Error('not needed');
        }
        subscribe(): void {}
        remove(): void {}
      }
      (window as unknown as { TradingView: unknown }).TradingView = { widget: ReadyWidget };

      const onReadyTimeout = vi.fn();
      const onError = vi.fn();
      const controller = await ChartController.create(
        options({ onReadyTimeout, readyTimeoutMs: 1_000, onError }),
      );
      readyCallback!();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(onReadyTimeout).not.toHaveBeenCalled();
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire after disposal', async () => {
    vi.useFakeTimers();
    try {
      install();
      const onReadyTimeout = vi.fn();
      const controller = await ChartController.create(
        options({ onReadyTimeout, readyTimeoutMs: 1_000 }),
      );
      controller.dispose();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(onReadyTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChartController market-depth gating', () => {
  it('keeps dom_widget disabled when the gateway does not serve market depth', async () => {
    install();
    const controller = await ChartController.create(options({ enableMarketDepth: false }));

    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.options.disabled_features).toContain('dom_widget');
    controller.dispose();
  });

  it('keeps dom_widget disabled when the option is omitted (safe default)', async () => {
    install();
    const controller = await ChartController.create(options({}));

    expect(constructed[0]!.options.disabled_features).toContain('dom_widget');
    controller.dispose();
  });

  it('offers the DOM and level-2 data when the gateway serves market depth', async () => {
    install();
    const controller = await ChartController.create(options({ enableMarketDepth: true }));

    expect(constructed[0]!.options.disabled_features).not.toContain('dom_widget');
    // The DOM widget only asks the broker for depth when level-2 support is
    // declared; the two must move together.
    const config = (
      constructed[0]!.options as unknown as {
        broker_config: { configFlags: Record<string, boolean> };
      }
    ).broker_config;
    expect(config.configFlags.supportLevel2Data).toBe(true);
    controller.dispose();
  });

  it('does not declare level-2 support when depth is unavailable', async () => {
    install();
    const controller = await ChartController.create(options({ enableMarketDepth: false }));

    const config = (
      constructed[0]!.options as unknown as {
        broker_config: { configFlags: Record<string, boolean> };
      }
    ).broker_config;
    expect(config.configFlags.supportLevel2Data).toBe(false);
    controller.dispose();
  });
});

/**
 * The wedge, as it appears from outside the library.
 *
 * Two of four cold loads in the 2026-08-20 retest came up like this: the pane
 * laid out full-size, the history subscription connected and answering, and
 * every canvas still at its 300×150 default because nothing was ever painted
 * into it. Nothing else the pane could observe distinguished it from a healthy
 * chart, which is why the alarm keyed to the history channel stayed silent for
 * 95 seconds while a trader looked at an empty rectangle.
 */
function canvas(backing: [number, number], layout: [number, number]): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = backing[0];
  element.height = backing[1];
  // jsdom lays nothing out, so the box is stubbed at the property the detector
  // reads — the same value a browser reports for a laid-out canvas.
  Object.defineProperty(element, 'clientWidth', { value: layout[0] });
  Object.defineProperty(element, 'clientHeight', { value: layout[1] });
  return element;
}

async function paneWith(...canvases: HTMLCanvasElement[]) {
  install();
  const container = document.createElement('div');
  for (const element of canvases) container.append(element);
  const controller = await ChartController.create(options({ container }));
  return controller;
}

describe('ChartController broker capabilities', () => {
  it('advertises editable order amounts so the Qty field renders', async () => {
    install();
    await ChartController.create(options({}));

    // With this false the library renders no quantity input at all, in any of
    // its modify surfaces — which left a trader no route to resize a pending
    // order and no explanation either (2026-08-21 QA blocker).
    const config = constructed[0]!.options.broker_config as {
      configFlags: Record<string, boolean>;
    };
    expect(config.configFlags.supportEditAmount).toBe(true);
  });
});

describe('ChartController paint state', () => {
  it('calls a pane blank when its canvases never left the default backing size', async () => {
    // The production wedge exactly: laid out 408×459, backing still 300×150.
    const controller = await paneWith(
      canvas([300, 150], [408, 459]),
      canvas([300, 150], [52, 459]),
      canvas([300, 150], [408, 28]),
    );
    expect(controller.paintState()).toBe('blank');
  });

  it('calls a pane painted once any canvas has been sized to its box', async () => {
    const controller = await paneWith(
      canvas([709, 751], [709, 751]),
      canvas([300, 150], [408, 459]),
    );
    // A chart mid-layout has some canvases sized and some not; only a pane
    // where NONE of them ever were is wedged. Accusing this one is what put
    // the banner over a fully drawn EURUSD series after a rapid symbol switch.
    expect(controller.paintState()).toBe('painted');
  });

  it('will not judge a pane the dock has not laid out yet', async () => {
    const controller = await paneWith(canvas([300, 150], [0, 0]));
    expect(controller.paintState()).toBe('unknown');
  });

  it('will not judge a pane with no canvases at all', async () => {
    const controller = await paneWith();
    expect(controller.paintState()).toBe('unknown');
  });

  it('does not accuse a pane that genuinely is 300×150', async () => {
    // Indistinguishable from the wedge by backing size alone, so the box is
    // consulted too — a coincidence must never cost a trader their layout.
    const controller = await paneWith(canvas([300, 150], [300, 150]));
    expect(controller.paintState()).toBe('painted');
  });

  it('does not accuse a small pane on a high-density display', async () => {
    // A 150x75 box at devicePixelRatio 2 is allocated exactly 300x150 — the
    // wedge's numbers, on a canvas that is correctly sized for its box. Both
    // ratios are 2.0, which is what tells the two apart.
    const controller = await paneWith(canvas([300, 150], [150, 75]));
    expect(controller.paintState()).toBe('painted');
  });

  it('calls a canvas blank whenever its backing does not cover its box', async () => {
    // Not only at the HTML default: any pane whose backing store was never
    // allocated for the box it occupies has nothing rendered in it.
    const controller = await paneWith(canvas([408, 200], [408, 459]));
    expect(controller.paintState()).toBe('blank');
  });

  it('sees the wedge on the pane’s REAL canvas geometry', async () => {
    // Measured from the live terminal: seven canvases, three of them laid out
    // small, all at the 300x150 default. The 66x28 one is the trap — a default
    // backing COVERS that box, so a rule based on coverage called it healthy,
    // one healthy canvas was enough to call the pane painted, and the alarm
    // stayed silent on the exact failure it exists to catch.
    const controller = await paneWith(
      canvas([300, 150], [605, 494]),
      canvas([300, 150], [605, 494]),
      canvas([300, 150], [66, 494]),
      canvas([300, 150], [66, 494]),
      canvas([300, 150], [605, 28]),
      canvas([300, 150], [605, 28]),
      canvas([300, 150], [66, 28]),
    );
    expect(controller.paintState()).toBe('blank');
  });

  it('calls that same pane painted once the library has allocated it', async () => {
    // The same seven, healthy, at this display's 1.8x ratio.
    const controller = await paneWith(
      canvas([1089, 890], [605, 494]),
      canvas([1089, 890], [605, 494]),
      canvas([119, 890], [66, 494]),
      canvas([119, 890], [66, 494]),
      canvas([1089, 50], [605, 28]),
      canvas([1089, 50], [605, 28]),
      canvas([119, 50], [66, 28]),
    );
    expect(controller.paintState()).toBe('painted');
  });

  it('reports unknown once disposed rather than blank', async () => {
    const controller = await paneWith(canvas([300, 150], [408, 459]));
    controller.dispose();
    // A torn-down pane has not failed to draw; it is simply gone. Reporting a
    // wedge here would escalate a recovery against nothing.
    expect(controller.paintState()).toBe('unknown');
  });
});

/**
 * The widget is created with `autosize`, so the library observes its CONTAINER.
 * A window resize event leaves that box untouched, the observer reports no
 * change, and the stale measurement the pane is stuck on survives — which made
 * the cheap recovery rung a no-op for the one failure it exists to fix.
 */
describe('ChartController re-measure', () => {
  it('perturbs the container so an autosize widget cannot ignore it', async () => {
    install();
    const container = document.createElement('div');
    container.style.width = '100%';
    const controller = await ChartController.create(options({ container }));

    controller.forceRemeasure();

    // The box genuinely differs, which is the only thing a ResizeObserver acts on.
    expect(container.style.width).toBe('calc(100% - 1px)');
  });

  it('puts the box back so the pane is not left a pixel narrow', async () => {
    vi.useFakeTimers();
    try {
      install();
      const container = document.createElement('div');
      container.style.width = '100%';
      const controller = await ChartController.create(options({ container }));

      controller.forceRemeasure();
      await vi.advanceTimersByTimeAsync(200);

      expect(container.style.width).toBe('100%');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the box when the pane is torn down mid-perturbation', async () => {
    vi.useFakeTimers();
    try {
      install();
      const container = document.createElement('div');
      container.style.width = '100%';
      const controller = await ChartController.create(options({ container }));

      controller.forceRemeasure();
      // A recovery disposes the controller while the perturbation is pending;
      // leaving it in place would hand the next widget a narrower container.
      controller.dispose();

      expect(container.style.width).toBe('100%');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the box alone when merely told the layout changed', async () => {
    install();
    const container = document.createElement('div');
    container.style.width = '100%';
    const controller = await ChartController.create(options({ container }));

    // What the pane's own ResizeObserver calls, on every dock resize. If this
    // perturbed the box it would see its own change and call back, and the
    // pane would thrash its layout forever.
    controller.resize();

    expect(container.style.width).toBe('100%');
  });

  it('does not stack perturbations when nudged repeatedly', async () => {
    vi.useFakeTimers();
    try {
      install();
      const container = document.createElement('div');
      container.style.width = '100%';
      const controller = await ChartController.create(options({ container }));

      controller.forceRemeasure();
      controller.forceRemeasure();
      controller.forceRemeasure();
      await vi.advanceTimersByTimeAsync(200);

      // The second call must not capture the perturbed value as the one to
      // restore, or the container never comes back.
      expect(container.style.width).toBe('100%');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChartController error severity', () => {
  // One failed widget call used to go through the FATAL channel, which the
  // pane answers by unmounting the chart — a still-drawing chart replaced by
  // an error card over a convenience that failed (2026-08-24 wedge report).
  it('routes a failed widget call to onNonFatalError, never onError', async () => {
    class ThrowingWidget {
      onChartReady(callback: () => void): void {
        callback();
      }
      activeChart(): never {
        throw new Error('boom');
      }
      subscribe(): void {}
      remove(): void {}
    }
    (window as unknown as { TradingView: unknown }).TradingView = { widget: ThrowingWidget };

    const onError = vi.fn();
    const onNonFatalError = vi.fn();
    const controller = await ChartController.create(options({ onError, onNonFatalError }));

    controller.setSymbol('GBPUSD');
    controller.setInterval('5');

    expect(onError).not.toHaveBeenCalled();
    expect(onNonFatalError).toHaveBeenCalled();
    controller.dispose();
  });

  it('collapses the detached-iframe signature into ONE diagnostic and goes quiet', async () => {
    class DetachedWidget {
      onChartReady(callback: () => void): void {
        callback();
      }
      activeChart(): never {
        // The exact production signature: the wrapper reading
        // `contentWindow.tradingViewApi` off a removed iframe.
        throw new Error("Cannot read properties of null (reading 'tradingViewApi')");
      }
      subscribe(): void {}
      remove(): void {}
    }
    (window as unknown as { TradingView: unknown }).TradingView = { widget: DetachedWidget };

    const onError = vi.fn();
    const onNonFatalError = vi.fn();
    const controller = await ChartController.create(options({ onError, onNonFatalError }));

    // In production this repeated every timer tick, forever. Now: the first
    // hit marks the controller detached; every later call is a no-op.
    controller.setSymbol('GBPUSD');
    controller.setSymbol('USDJPY');
    controller.setInterval('5');
    controller.revealPrice(1.1);

    expect(onError).not.toHaveBeenCalled();
    expect(onNonFatalError).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('treats a live iframe whose contentWindow is gone as detached before calling in', async () => {
    class QuietWidget {
      onChartReady(callback: () => void): void {
        callback();
      }
      activeChart() {
        return {
          setSymbol: vi.fn(),
          symbol: () => 'EURUSD',
          onSymbolChanged: () => ({ subscribe: vi.fn() }),
          onIntervalChanged: () => ({ subscribe: vi.fn() }),
        };
      }
      subscribe(): void {}
      remove(): void {}
    }
    (window as unknown as { TradingView: unknown }).TradingView = { widget: QuietWidget };

    const container = document.createElement('div');
    // An iframe that is not in the document has a null contentWindow — the
    // state the pane leaves behind when it unmounts without disposing.
    container.appendChild(document.createElement('iframe'));

    const onError = vi.fn();
    const onNonFatalError = vi.fn();
    const controller = await ChartController.create(
      options({ container, onError, onNonFatalError }),
    );

    controller.setSymbol('GBPUSD');

    expect(onError).not.toHaveBeenCalled();
    expect(onNonFatalError).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});
