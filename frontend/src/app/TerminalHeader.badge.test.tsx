import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useCapabilities } from '@/stores/capabilities-store';
import { useTradingStore } from '@/stores/trading-store';
import type { DecimalString } from '@/domain/common/decimal';
import type { TradingAccount } from '@/domain/common/models';
import { EnvironmentBadgeForTest } from './TerminalHeader';

/**
 * The real-money warning has to be about something a trader can check.
 *
 * It described only the deployment, and read against a hostname containing
 * "stage" that looked like a mislabelling rather than a statement about the
 * account in the ticket — so it was filed as a bug and traded through for a
 * session (2026-08-21). One gateway serves many accounts; the deployment is
 * not what anyone risks money on.
 */
const d = (v: string) => v as DecimalString;

function account(overrides: Partial<TradingAccount> = {}): TradingAccount {
  return {
    login: '15597243',
    name: 'ECN Pro 15597243',
    currency: 'USD',
    server: 'Opogroup-Server1',
    balance: d('93.70'),
    credit: null,
    equity: d('93.70'),
    profit: d('0'),
    margin: d('0'),
    marginFree: d('93.70'),
    marginLevel: null,
    leverage: d('500'),
    readOnly: false,
    asOf: 0,
    ...overrides,
  } as TradingAccount;
}

function setEnvironment(mode: string) {
  useCapabilities.setState((s) => ({
    capabilities: {
      ...s.capabilities,
      environment: {
        name: 'production',
        tradingMode: mode,
        mt5Server: 'https://mt5.example.com',
        buildSha: '14725d5b628',
        apiVersion: '2',
      },
    },
  }));
}

describe('the real-money badge', () => {
  it('names the account the warning is about', () => {
    setEnvironment('live');
    useTradingStore.getState().applyAccount(account(), useTradingStore.getState().generation, 1);

    render(<EnvironmentBadgeForTest funds="live" />);
    const label = screen.getByLabelText(/REAL MONEY/);

    // The account, not just the deployment — that is the part a trader can
    // check, and the part that was missing when this was dismissed.
    expect(label.getAttribute('aria-label')).toContain('ECN Pro 15597243');
    expect(label.getAttribute('aria-label')).toContain('#15597243');
    expect(label.getAttribute('aria-label')).toContain('Opogroup-Server1');
  });

  it('still says which gateway, since that is a different fact', () => {
    setEnvironment('live');
    useTradingStore.getState().applyAccount(account(), useTradingStore.getState().generation, 1);
    render(<EnvironmentBadgeForTest funds="live" />);
    expect(screen.getByLabelText(/REAL MONEY/).getAttribute('aria-label')).toContain(
      'production gateway',
    );
  });

  it('says nothing at all until the server states what the account is', () => {
    // This REPLACES an older test that expected a real-money warning before an
    // account was chosen. That expectation was the 2026-08-26 defect in
    // miniature: the badge was a claim about the deployment worn as a claim
    // about the account, and "LIVE" is the guess that cannot be walked back.
    // A badge nobody can substantiate is worse than no badge.
    setEnvironment('live');
    useTradingStore.setState({ account: null });

    const { container } = render(<EnvironmentBadgeForTest funds="unknown" />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/LIVE/)).toBeNull();
  });

  it('never shows LIVE for an account the server did not classify', () => {
    // The regression that matters: a funded account with no stated kind.
    setEnvironment('live');
    useTradingStore.getState().applyAccount(account(), useTradingStore.getState().generation, 1);

    const { container } = render(<EnvironmentBadgeForTest funds="unknown" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('says demo funds when the server says demo', () => {
    setEnvironment('live'); // deployment mode is irrelevant now — the ACCOUNT decides
    useTradingStore.getState().applyAccount(account(), useTradingStore.getState().generation, 1);
    render(<EnvironmentBadgeForTest funds="demo" />);
    expect(screen.getByLabelText(/Demo funds/)).toBeTruthy();
    expect(screen.getByText(/DEMO/)).toBeInTheDocument();
  });

  it('names the MT5 group, which is what settles the question with the broker', () => {
    // The badge cannot derive the answer: /api/group/get returns identical
    // configuration for this broker's demo-signature groups and its live ones,
    // and an MT5 user's Rights carry no demo bit. So it states the identifier a
    // trader can quote to their broker.
    setEnvironment('live');
    useTradingStore.getState().applyAccount(account(), useTradingStore.getState().generation, 1);
    render(<EnvironmentBadgeForTest funds="live" group={'Opoforex\\ECNPRO-APP-SF-USD-B'} />);

    expect(screen.getByLabelText(/MT5 group Opoforex\\ECNPRO-APP-SF-USD-B/)).toBeInTheDocument();
  });
});
