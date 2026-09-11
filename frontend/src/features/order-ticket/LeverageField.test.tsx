import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { DecimalString } from '@/domain/common/decimal';
import type { Position, TradingAccount } from '@/domain/common/models';
import { asAccountLogin, asPositionId } from '@/domain/common/ids';
import { NO_CAPABILITIES } from '@/integrations/gateway/api/capabilities';
import { SymbolSuffixPolicy } from '@/integrations/gateway/mappers/symbol-suffix';
import { useCapabilities } from '@/stores/capabilities-store';
import { useSessionStore } from '@/stores/session-store';
import { useTradingStore } from '@/stores/trading-store';
import { LeverageField } from './LeverageField';

const d = (v: string) => v as DecimalString;

const leverage = vi.fn();
const setLeverage = vi.fn();

vi.mock('@/app/providers/services', () => ({
  useServices: () => ({
    trading: {
      leverage: (...args: unknown[]) => leverage(...args),
      setLeverage: (...args: unknown[]) => setLeverage(...args),
    },
  }),
  reportError: vi.fn(),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function account(overrides: Partial<TradingAccount> = {}): TradingAccount {
  return {
    login: asAccountLogin('123456815'),
    name: 'OPO Trade STD 123456815',
    currency: 'USD',
    server: null,
    balance: d('3286.92'),
    credit: null,
    equity: d('3286.92'),
    profit: d('0'),
    margin: d('0'),
    marginFree: d('3286.92'),
    marginLevel: null,
    leverage: d('300'),
    readOnly: false,
    asOf: Date.now(),
    ...overrides,
  };
}

function position(id: string): Position {
  return {
    id: asPositionId(id),
    symbol: 'EURUSD.',
    displaySymbol: 'EURUSD',
    side: 'buy',
    volume: d('0.01'),
    openPrice: d('1.10000'),
    currentPrice: null,
    stopLoss: null,
    takeProfit: null,
    profit: null,
    swap: null,
    commission: null,
    openTime: null,
    comment: null,
  };
}

async function openDialog() {
  const user = userEvent.setup();
  render(<LeverageField />, { wrapper });
  await user.click(await screen.findByRole('button', { name: /adjust leverage/i }));
  await screen.findByRole('dialog');
  return user;
}

beforeEach(() => {
  leverage.mockReset();
  setLeverage.mockReset();
  leverage.mockResolvedValue({ leverage: 300, min: 100, max: 500, choices: [100, 200, 300] });
  setLeverage.mockResolvedValue({ leverage: 200, min: 100, max: 500, choices: [100, 200, 300] });

  useCapabilities.setState({
    capabilities: { ...NO_CAPABILITIES, leverage: { enabled: true, reason: null } },
    loaded: true,
  });
  useSessionStore.setState({
    status: 'signed-in',
    activeLogin: '123456815',
    suffixPolicy: new SymbolSuffixPolicy('.'),
    readOnly: false,
    accounts: [
      {
        login: '123456815',
        name: 'OPO Trade STD 123456815',
        typeId: null,
        server: null,
        currency: 'USD',
        readOnly: false,
        enabled: true,
        suffix: '.',
      },
    ],
  });
  useTradingStore.setState({
    account: account(),
    positions: [],
    positionsById: new Map(),
  });
});

describe('LeverageField dialog', () => {
  it('names the account it applies to', async () => {
    await openDialog();
    expect(screen.getByRole('dialog')).toHaveTextContent('OPO Trade STD 123456815');
  });

  it('does NOT apply a preset on click — only Confirm sends the change', async () => {
    const user = await openDialog();

    await user.click(screen.getByRole('button', { name: '1:200' }));
    // The mis-click that used to re-margin the whole account now does nothing.
    expect(setLeverage).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /confirm/i }));
    expect(setLeverage).toHaveBeenCalledWith('123456815', 200);
  });

  it('disables Confirm until a value DIFFERENT from the current one is pending', async () => {
    const user = await openDialog();

    // Nothing selected yet.
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();

    // Selecting the current value is not a change.
    await user.click(screen.getByRole('button', { name: /1:300/ }));
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '1:200' }));
    expect(screen.getByRole('button', { name: /confirm/i })).toBeEnabled();
  });

  it('Cancel discards the pending selection without sending anything', async () => {
    const user = await openDialog();

    await user.click(screen.getByRole('button', { name: '1:200' }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(setLeverage).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Reopening starts clean: the discarded choice must not survive.
    await user.click(screen.getByRole('button', { name: /adjust leverage/i }));
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
  });

  it('warns with before/after margin and margin level when positions are open', async () => {
    useTradingStore.setState({
      account: account({ margin: d('100'), equity: d('3000'), marginLevel: d('3000') }),
      positions: [position('1'), position('2')],
    });
    const user = await openDialog();

    await user.click(screen.getByRole('button', { name: '1:100' }));

    const warning = screen.getByRole('status');
    expect(warning).toHaveTextContent('You have 2 open positions');
    expect(warning).toHaveTextContent('1:100');
    // 100 × 300/100 = 300; levels 3000/100 = 3000% → 3000/300 = 1000%.
    expect(warning).toHaveTextContent('from 100.00 to 300.00 USD');
    expect(warning).toHaveTextContent('from 3,000.00% to 1,000.00%');
    expect(screen.getByRole('button', { name: /confirm/i })).toBeEnabled();
  });

  it('shows no positions warning on a flat account', async () => {
    const user = await openDialog();
    await user.click(screen.getByRole('button', { name: '1:200' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('refuses a change whose projected margin would exceed equity', async () => {
    // 2,000 margin at 1:300 → 6,000 at 1:100, against 3,000 equity.
    useTradingStore.setState({
      account: account({ margin: d('2000'), equity: d('3000') }),
      positions: [position('1')],
    });
    const user = await openDialog();

    await user.click(screen.getByRole('button', { name: '1:100' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/would exceed this account.s equity/);
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
    // Never silently applied — and never applied at all.
    await user.click(screen.getByRole('button', { name: /confirm/i }));
    expect(setLeverage).not.toHaveBeenCalled();
  });

  it('keeps the success toast wiring: a confirmed change reports 1:200', async () => {
    const user = await openDialog();
    await user.click(screen.getByRole('button', { name: '1:200' }));
    await user.click(screen.getByRole('button', { name: /confirm/i }));

    // The dialog closes on success; the row reflects the server's answer.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText('1:200')).toBeInTheDocument();
  });
});
