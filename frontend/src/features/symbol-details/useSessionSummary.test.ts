import { describe, expect, it } from 'vitest';
import { sessionPanelState } from './useSessionSummary';
import type { SessionSummary } from '@/domain/market/session-summary';
import type { DecimalString } from '@/domain/common/decimal';

const d = (v: string) => v as DecimalString;

const summary: SessionSummary = {
  open: d('1.16774'),
  low: d('1.16681'),
  high: d('1.17107'),
  change: d('0.00011'),
  changePercent: d('0.01'),
  position: 25.4,
};

/**
 * The panel has exactly three things it can say, and it must always reach one
 * of them. The case that broke it was none of the obvious two.
 */
describe('sessionPanelState', () => {
  it('is loading while the request is in flight', () => {
    const s = sessionPanelState({ status: 'pending', fetchStatus: 'fetching', summary: null });
    expect(s).toEqual({ loading: true, unavailable: false, stalled: false });
  });

  it('shows the range once it arrives', () => {
    const s = sessionPanelState({ status: 'success', fetchStatus: 'idle', summary });
    expect(s).toEqual({ loading: false, unavailable: false, stalled: false });
  });

  it('says unavailable when the request failed', () => {
    const s = sessionPanelState({ status: 'error', fetchStatus: 'idle', summary: null });
    expect(s).toEqual({ loading: false, unavailable: true, stalled: false });
  });

  // The instrument answered; it just had no session to summarise.
  it('says unavailable when the bars carried no session', () => {
    const s = sessionPanelState({ status: 'success', fetchStatus: 'idle', summary: null });
    expect(s.unavailable).toBe(true);
  });

  /**
   * The production stall: React Query aborts an in-flight fetch when the last
   * observer unmounts, leaving pending + idle — no data, no error, nothing
   * running. Reported as loading (it is about to be asked again) and flagged
   * stalled so the hook asks, but never as unavailable: the instrument did not
   * fail, this client stopped listening.
   */
  it('flags an aborted request rather than waiting on it forever', () => {
    const s = sessionPanelState({ status: 'pending', fetchStatus: 'idle', summary: null });
    expect(s).toEqual({ loading: true, unavailable: false, stalled: true });
  });

  // Offline, with the request queued rather than abandoned. Nothing to retry.
  it('waits on a paused request without retrying it', () => {
    const s = sessionPanelState({ status: 'pending', fetchStatus: 'paused', summary: null });
    expect(s).toEqual({ loading: true, unavailable: false, stalled: false });
  });
});
