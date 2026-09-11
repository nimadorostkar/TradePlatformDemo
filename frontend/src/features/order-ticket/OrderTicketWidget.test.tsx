import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { DecimalString } from '@/domain/common/decimal';
import { TradingError } from '@/domain/common/errors';
import type { TradingSymbol } from '@/domain/common/models';
import { quoteStore } from '@/stores/quote-store';
import { useSessionStore } from '@/stores/session-store';
import { useTradingStore } from '@/stores/trading-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { createDefaultWorkspace } from '@/workspace/persistence/schema';
import { SymbolSuffixPolicy } from '@/integrations/gateway/mappers/symbol-suffix';
import { useOrderDraft } from '@/stores/order-draft-store';
import OrderTicketWidget from './OrderTicketWidget';

const d = (v: string) => v as DecimalString;

const symbol: TradingSymbol = {
  name: 'EURUSD.',
  displayName: 'EURUSD',
  description: 'Euro vs US Dollar',
  type: 'FX',
  exchange: 'Broker',
  digits: 5,
  pricescale: 100_000,
  minMove: 1,
  volumeMin: d('0.01'),
  volumeMax: d('100'),
  volumeStep: d('0.01'),
  contractSize: d('100000'),
  tickSize: d('0.00001'),
  tickValue: d('1'),
  currencyCode: 'USD',
  session: '24x5',
  timezone: 'Etc/UTC',
  supportedResolutions: ['1'],
  sector: null,
  industry: null,
};

const openPosition = vi.fn();
const placePendingOrder = vi.fn();

// The service container is mocked at the boundary; the widget's own logic —
// validation, confirmation, disabled states, result reporting — is real.
vi.mock('@/app/providers/services', () => ({
  useServices: () => ({
    tradingService: { openPosition, placePendingOrder },
    market: { symbolInfo: vi.fn().mockResolvedValue(symbol) },
    symbolCache: new Map(),
    pool: { subscribe: () => () => {} },
  }),
  reportError: vi.fn(),
}));

vi.mock('./useSymbolMetadata', () => ({
  useSymbolMetadata: () => ({ symbol, loading: false, error: null }),
}));

vi.mock('@/features/watchlist/useSymbolSubscription', () => ({
  useSymbolSubscription: () => {},
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  openPosition.mockReset();
  placePendingOrder.mockReset();
  quoteStore.clear();
  useTradingStore.setState({ account: null });

  useWorkspace.setState({
    workspace: createDefaultWorkspace({ activeSymbol: 'EURUSD' }),
    hydrated: true,
  });
  useSessionStore.setState({
    status: 'signed-in',
    activeLogin: '1001',
    suffixPolicy: new SymbolSuffixPolicy('.'),
    readOnly: false,
    accounts: [],
  });

  // The draft is a module-level store; reset it so tests cannot leak into
  // one another.
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
  });

  quoteStore.apply({
    symbol: 'EURUSD.',
    bid: d('1.10000'),
    ask: d('1.10020'),
    last: d('1.10010'),
    volume: null,
    receivedAt: Date.now(),
  });
});

describe('OrderTicketWidget', () => {
  it('shows live bid and ask on the sell and buy buttons', () => {
    render(<OrderTicketWidget />, { wrapper });
    expect(screen.getByText('1.10000')).toBeInTheDocument();
    expect(screen.getByText('1.10020')).toBeInTheDocument();
  });

  it('requires confirmation before submitting', async () => {
    const user = userEvent.setup();
    render(<OrderTicketWidget />, { wrapper });

    await user.click(screen.getByRole('button', { name: /buy/i }));

    // Nothing is sent until the trader confirms.
    expect(openPosition).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/confirm order/i)).toBeInTheDocument();
  });

  it('does not let a stored workspace preference bypass production confirmation policy', async () => {
    const user = userEvent.setup();
    useWorkspace.setState((state) => ({
      workspace: { ...state.workspace, confirmTrades: false },
    }));

    render(<OrderTicketWidget />, { wrapper });
    await user.click(screen.getByRole('button', { name: /buy/i }));

    expect(openPosition).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('sends the order only after confirmation', async () => {
    const user = userEvent.setup();
    openPosition.mockResolvedValue({
      state: 'accepted',
      orderId: '555',
      retcode: '10009',
      message: null,
      requestId: 'req-1',
    });

    render(<OrderTicketWidget />, { wrapper });
    await user.click(screen.getByRole('button', { name: /buy/i }));
    await user.click(await screen.findByRole('button', { name: /place market order/i }));

    await waitFor(() => expect(openPosition).toHaveBeenCalledTimes(1));

    const [request] = openPosition.mock.calls[0]!;
    expect(request).toMatchObject({
      displaySymbol: 'EURUSD',
      side: 'buy',
      volumeLots: '0.01',
      // A market buy executes at the ASK.
      price: '1.10020',
    });
  });

  it('cancels without sending anything', async () => {
    const user = userEvent.setup();
    render(<OrderTicketWidget />, { wrapper });

    await user.click(screen.getByRole('button', { name: /sell/i }));
    await user.click(await screen.findByRole('button', { name: /^cancel$/i }));

    expect(openPosition).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('reports acceptance WITHOUT claiming the order filled', async () => {
    const user = userEvent.setup();
    openPosition.mockResolvedValue({
      state: 'accepted',
      orderId: '555',
      retcode: '10009',
      message: null,
      requestId: 'req-1',
    });

    render(<OrderTicketWidget />, { wrapper });
    await user.click(screen.getByRole('button', { name: /buy/i }));
    await user.click(await screen.findByRole('button', { name: /place market order/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/accepted by the trading server/i);
    expect(status).toHaveTextContent(/awaiting confirmation/i);
    expect(status.textContent?.toLowerCase()).not.toContain('filled');
  });

  it('reports a timeout as an UNKNOWN outcome, not a failure', async () => {
    const user = userEvent.setup();
    openPosition.mockResolvedValue({
      state: 'unknown',
      orderId: null,
      retcode: null,
      message: 'The outcome is unknown — reconciling with the trading server.',
      requestId: 'req-2',
    });

    render(<OrderTicketWidget />, { wrapper });
    await user.click(screen.getByRole('button', { name: /buy/i }));
    await user.click(await screen.findByRole('button', { name: /place market order/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/outcome unknown/i);
    expect(status).toHaveTextContent(/check positions before retrying/i);
  });

  it('surfaces a rejection reason', async () => {
    const user = userEvent.setup();
    openPosition.mockRejectedValue(
      new TradingError({ kind: 'rejected', code: 'mt5.10019', message: 'Not enough money.' }),
    );

    render(<OrderTicketWidget />, { wrapper });
    await user.click(screen.getByRole('button', { name: /buy/i }));
    await user.click(await screen.findByRole('button', { name: /place market order/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not enough money/i);
    expect(alert).toHaveTextContent(/deposit funds/i);
  });

  it('blocks trading on a read-only account', () => {
    useSessionStore.setState({ readOnly: true });
    render(<OrderTicketWidget />, { wrapper });

    expect(screen.getByText(/this account is read-only/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /buy/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /sell/i })).toBeDisabled();
  });

  it('blocks submission for an invalid volume', async () => {
    const user = userEvent.setup();
    render(<OrderTicketWidget />, { wrapper });

    const volume = screen.getByLabelText(/volume/i);
    await user.clear(volume);
    await user.type(volume, '0.015');

    expect(await screen.findByText(/multiple of/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /buy/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(openPosition).not.toHaveBeenCalled();
  });

  it('disables BUY and SELL when the estimated margin exceeds free margin (HGH-06)', async () => {
    // 93.74 USD free at 1:100 — the punch list's own account. 50 lots of
    // EURUSD needs ~55,000 USD of margin; the server is guaranteed to reject.
    useTradingStore.setState({
      account: {
        login: '1001',
        name: 'ECN 1001',
        currency: 'USD',
        server: null,
        balance: d('93.74'),
        credit: null,
        equity: d('93.74'),
        profit: d('0.00'),
        margin: d('0.00'),
        marginFree: d('93.74'),
        marginLevel: null,
        leverage: d('100'),
        readOnly: false,
        asOf: Date.now(),
      },
    });
    const user = userEvent.setup();
    render(<OrderTicketWidget />, { wrapper });

    const volume = screen.getByLabelText(/volume/i);
    await user.clear(volume);
    await user.type(volume, '50');

    // The warning and the disabled buttons state one fact in one voice.
    expect(await screen.findByText(/not enough free margin/i)).toBeInTheDocument();
    const buy = screen.getByRole('button', { name: /buy/i });
    const sell = screen.getByRole('button', { name: /sell/i });
    expect(buy).toBeDisabled();
    expect(sell).toBeDisabled();
    expect(buy).toHaveAccessibleName(/not enough free margin/i);

    await user.click(buy);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(openPosition).not.toHaveBeenCalled();

    // A size the account can carry re-enables both.
    await user.clear(volume);
    await user.type(volume, '0.01');
    await waitFor(() => expect(screen.getByRole('button', { name: /buy/i })).toBeEnabled());
    expect(screen.getByRole('button', { name: /sell/i })).toBeEnabled();
  });

  it('shows the entry price field only for pending orders', async () => {
    const user = userEvent.setup();
    render(<OrderTicketWidget />, { wrapper });

    // Scoped to the textbox: a disabled BUY/SELL button now states its reason
    // in its accessible name, and one of those reasons is "Enter an entry
    // price." — which a bare label match also finds.
    expect(screen.queryByRole('textbox', { name: /entry price/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Limit' }));
    expect(screen.getByRole('textbox', { name: /entry price/i })).toBeInTheDocument();
  });

  it('clears per-symbol inputs when the symbol changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<OrderTicketWidget />, { wrapper });

    const stopLoss = screen.getByLabelText('Stop loss');
    await user.type(stopLoss, '1.09000');
    expect(stopLoss).toHaveValue('1.09000');

    // Carrying a EURUSD stop price onto XAUUSD would be actively dangerous.
    act(() => {
      useWorkspace.getState().setActiveSymbol('XAUUSD');
    });
    rerender(<OrderTicketWidget />);

    await waitFor(() => expect(screen.getByLabelText('Stop loss')).toHaveValue(''));
  });
});

describe('volume belongs to the symbol', () => {
  it('restores each instrument its own size instead of carrying one over', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<OrderTicketWidget />, { wrapper });

    // Scoped to the textbox: a disabled BUY/SELL button states its reason in
    // its accessible name, and "Enter a valid volume." also matches /volume/i.
    const volume = () => screen.getByRole('textbox', { name: /volume/i }) as HTMLInputElement;
    await user.clear(volume());
    await user.type(volume(), '0.25');
    expect(volume().value).toBe('0.25');

    // Switch away: 0.25 lots of EURUSD is not 0.25 lots of gold, so the size
    // must not follow the trader onto another instrument.
    act(() => {
      useWorkspace.setState((state) => ({
        workspace: { ...state.workspace, activeSymbol: 'XAUUSD' },
      }));
    });
    rerender(<OrderTicketWidget />);
    await waitFor(() => expect(volume().value).toBe('0.01'));

    await user.clear(volume());
    await user.type(volume(), '0.05');

    // …and coming back restores what EURUSD was left at.
    act(() => {
      useWorkspace.setState((state) => ({
        workspace: { ...state.workspace, activeSymbol: 'EURUSD' },
      }));
    });
    rerender(<OrderTicketWidget />);
    await waitFor(() => expect(volume().value).toBe('0.25'));
  });
});
