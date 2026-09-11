import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document
    .querySelectorAll('script[src*="charting_library.standalone.js"]')
    .forEach((node) => node.remove());
  delete window.TradingView;
  vi.resetModules();
});

describe('loadTradingView', () => {
  it('allows a fresh attempt after a transient script load failure', async () => {
    const { loadTradingView, TradingViewNotLoadedError } = await import('./types');
    const firstAttempt = loadTradingView('/charting_library/');
    const firstScript = document.querySelector<HTMLScriptElement>(
      'script[src="/charting_library/charting_library.standalone.js"]',
    );
    expect(firstScript).not.toBeNull();

    firstScript?.dispatchEvent(new Event('error'));
    await expect(firstAttempt).rejects.toBeInstanceOf(TradingViewNotLoadedError);
    expect(firstScript?.isConnected).toBe(false);

    const secondAttempt = loadTradingView('/charting_library/');
    const secondScript = document.querySelector<HTMLScriptElement>(
      'script[src="/charting_library/charting_library.standalone.js"]',
    );
    expect(secondScript).not.toBeNull();
    expect(secondScript).not.toBe(firstScript);

    const fakeLibrary = { widget: vi.fn() } as unknown as NonNullable<Window['TradingView']>;
    window.TradingView = fakeLibrary;
    secondScript?.dispatchEvent(new Event('load'));
    await expect(secondAttempt).resolves.toBe(fakeLibrary);
  });
});
