import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The block's cross-rate hook reaches for the service container and live
// quote subscriptions; both are irrelevant here (quote and account currency
// are the same, so the rate is "1").
vi.mock('@/features/watchlist/useSymbolSubscription', () => ({
  useSymbolSubscription: () => {},
}));
import type { DecimalString } from '@/domain/common/decimal';
import type { TradingAccount, TradingSymbol } from '@/domain/common/models';
import { useTradingStore } from '@/stores/trading-store';
import { OrderInfoBlock } from './OrderInfoBlock';

const d = (v: string) => v as DecimalString;

const symbol: TradingSymbol = {
  name: 'XAUUSD',
  displayName: 'XAUUSD',
  description: 'Gold vs US Dollar',
  type: 'CFD',
  exchange: 'Broker',
  digits: 2,
  pricescale: 100,
  minMove: 1,
  volumeMin: d('0.01'),
  volumeMax: d('100'),
  volumeStep: d('0.01'),
  contractSize: d('100'),
  tickSize: d('0.01'),
  tickValue: d('1'),
  currencyCode: 'USD',
  session: '24x5',
  timezone: 'Etc/UTC',
  supportedResolutions: ['1'],
  sector: null,
  industry: null,
};

function setAccount(overrides: Partial<TradingAccount>) {
  const account = {
    login: 1,
    name: 'Test',
    server: 'Server',
    currency: 'USD',
    balance: d('0'),
    credit: d('0'),
    equity: d('0'),
    profit: d('0'),
    margin: d('0'),
    marginFree: d('0'),
    marginLevel: null,
    leverage: d('300'),
    readOnly: false,
    ...overrides,
  } as unknown as TradingAccount;
  useTradingStore.setState({ account });
}

describe('OrderInfoBlock (HGH-06)', () => {
  beforeEach(() => {
    useTradingStore.setState({ account: null });
  });

  it('shows "—" while the volume is invalid instead of computing from it', () => {
    setAccount({ marginFree: d('10000') });
    render(
      <OrderInfoBlock
        title="Order info"
        symbol={symbol}
        volumeLots="0.015"
        volumeInvalid
        price={d('2400')}
      />,
    );
    // Trade Value / Margin Used must NOT be derived from the invalid size.
    expect(screen.queryByText(/3\.6|360/)).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('warns when margin used exceeds margin available', () => {
    setAccount({ marginFree: d('0') });
    render(<OrderInfoBlock title="Order info" symbol={symbol} volumeLots="50" price={d('2400')} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/not enough free margin/i);
  });

  it('stays calm while margin fits', () => {
    setAccount({ marginFree: d('1000000') });
    render(<OrderInfoBlock title="Order info" symbol={symbol} volumeLots="1" price={d('2400')} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
