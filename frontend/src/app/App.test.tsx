import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore } from '@/stores/session-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { createDefaultWorkspace } from '@/workspace/persistence/schema';
import type { AccountOption } from '@/integrations/gateway/mappers/to-domain';
import { NO_CAPABILITIES } from '@/integrations/gateway/api/capabilities';
import { TradingError } from '@/domain/common/errors';

/**
 * The gate between "signed in" and "trading terminal".
 *
 * The bug these cover: the app rendered "No tradable account" the instant
 * sign-in succeeded, while the account request was still in flight. That
 * asserts something the app has not established, and it is the first thing a
 * trader sees after entering their password.
 */

const listAccounts = vi.fn();
const getTokens = vi.fn();
const renew = vi.fn();
const fetchCapabilities = vi.fn();
const pullWorkspace = vi.fn();

// The container must be a STABLE reference: the real one comes from a useMemo
// in ServicesProvider, and the account-loading effect depends on its identity.
// Returning a fresh object each render would re-run the effect forever.
const servicesStub = {
  auth: { listAccounts, renew, signOut: vi.fn(), signInWithCrmToken: vi.fn() },
  tokens: { get: getTokens, subscribe: vi.fn(() => () => {}) },
  // Capability discovery never rejects in the real client; a stub that resolves
  // to nothing leaves every optional feature off, which is what these tests
  // want — they exercise the account gate, not the feature set.
  capabilities: { fetch: fetchCapabilities },
  workspaceStore: { reset: vi.fn(), pull: pullWorkspace },
  generations: { advance: vi.fn(() => 2) },
  symbolCache: new Map<string, unknown>(),
};

vi.mock('@/app/providers/services', () => ({
  ServicesProvider: ({ children }: { children: React.ReactNode }) => children,
  useServices: () => servicesStub,
  reportError: vi.fn(),
}));

vi.mock('@/app/TradingTerminalPage', () => ({
  TradingTerminalPage: () => <div data-testid="terminal">terminal</div>,
}));

vi.mock('@/features/auth/SignInScreen', () => ({
  SignInScreen: () => <div data-testid="sign-in">sign in</div>,
}));

const { AuthenticatedApp } = await import('./App');

const account = (login: string): AccountOption => ({
  login,
  name: `ECN ${login}`,
  typeId: 57,
  server: 'Broker-Live',
  currency: 'USD',
  readOnly: false,
  enabled: true,
  suffix: '.',
});

/** Never settles — models a request still in flight. */
const pending = () => new Promise<AccountOption[]>(() => {});

beforeEach(() => {
  listAccounts.mockReset();
  servicesStub.generations.advance.mockClear();
  servicesStub.symbolCache.clear();
  renew.mockReset();
  renew.mockResolvedValue(null);
  // The suite config resets mock implementations between tests, so these are
  // re-armed here rather than at definition.
  fetchCapabilities.mockResolvedValue(NO_CAPABILITIES);
  pullWorkspace.mockResolvedValue(false);
  // A held token is what puts the app in the signed-in branch.
  getTokens.mockReturnValue({ gatewayToken: 'token', crmToken: 'crm', expiresAt: null });
  listAccounts.mockResolvedValue([]);
  useWorkspace.setState({ workspace: createDefaultWorkspace(), hydrated: true });
  useSessionStore.setState({
    status: 'signed-in',
    accounts: [],
    accountsStatus: 'idle',
    accountsError: null,
    activeLogin: null,
    readOnly: false,
  });
});

describe('post-sign-in account loading', () => {
  it('shows a branded loader while the account request is in flight', async () => {
    listAccounts.mockReturnValue(pending());

    render(<AuthenticatedApp />);

    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/loading your accounts/i)).toBeInTheDocument();

    // The claim that must NOT appear before the request resolves.
    expect(screen.queryByText(/no tradable account/i)).not.toBeInTheDocument();
  });

  it('enters the terminal once an account resolves', async () => {
    listAccounts.mockResolvedValue([account('1001')]);

    render(<AuthenticatedApp />);

    expect(await screen.findByTestId('terminal')).toBeInTheDocument();
    expect(screen.queryByText(/no tradable account/i)).not.toBeInTheDocument();
  });

  it('reports "no tradable account" ONLY once the list is known to be empty', async () => {
    listAccounts.mockResolvedValue([]);

    render(<AuthenticatedApp />);

    expect(await screen.findByText(/no tradable account/i)).toBeInTheDocument();
  });

  it('distinguishes a FAILED lookup from an empty list', async () => {
    // "We could not ask" and "you have none" are different facts, and only one
    // of them is worth telling a trader to contact support about.
    listAccounts.mockRejectedValue(new Error('gateway unavailable'));

    render(<AuthenticatedApp />);

    expect(await screen.findByText(/could not load your accounts/i)).toBeInTheDocument();
    expect(screen.queryByText(/no tradable account/i)).not.toBeInTheDocument();
  });

  it('signs out to the sign-in screen when the lookup is UNAUTHORIZED', async () => {
    // A restored session can carry an expired CRM token (it lives far shorter
    // than the 30-day gateway JWT). Account lookup then 401s forever — and the
    // regression this covers stranded a trader on the retry screen with no way
    // to reach sign-in. Unauthorized must exit to a clean sign-out instead.
    listAccounts.mockRejectedValue(
      new TradingError({
        kind: 'unauthorized',
        message: 'Your session has expired. Please sign in again.',
        code: 'crm.401',
      }),
    );

    render(<AuthenticatedApp />);

    expect(await screen.findByTestId('sign-in')).toBeInTheDocument();
    expect(servicesStub.auth.signOut).toHaveBeenCalled();
    expect(screen.queryByText(/could not load your accounts/i)).not.toBeInTheDocument();
  });

  it('retries the request when asked', async () => {
    const user = userEvent.setup();
    listAccounts.mockRejectedValueOnce(new Error('gateway unavailable'));

    render(<AuthenticatedApp />);
    await screen.findByText(/could not load your accounts/i);
    expect(listAccounts).toHaveBeenCalledTimes(1);

    listAccounts.mockResolvedValueOnce([account('1001')]);
    await user.click(screen.getByRole('button', { name: /try again/i }));

    // The retry must actually re-issue the request, not just reset the label.
    await waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('terminal')).toBeInTheDocument();
  });

  it('shows the sign-in screen when no session is held', async () => {
    getTokens.mockReturnValue(null);
    useSessionStore.setState({ status: 'signed-out' });

    render(<AuthenticatedApp />);

    expect(await screen.findByTestId('sign-in')).toBeInTheDocument();
    expect(listAccounts).not.toHaveBeenCalled();
    expect(servicesStub.generations.advance).toHaveBeenCalledTimes(1);
  });

  it('renews a gateway token before expiry', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      getTokens.mockReturnValue({
        gatewayToken: 'token',
        crmToken: 'crm',
        expiresAt: now + 60_100,
      });
      renew.mockResolvedValue({
        gatewayToken: 'renewed',
        crmToken: 'crm',
        expiresAt: now + 60 * 60_000,
      });

      const view = render(<AuthenticatedApp />);
      await act(async () => vi.advanceTimersByTimeAsync(101));

      expect(renew).toHaveBeenCalledTimes(1);
      expect(listAccounts).toHaveBeenCalledTimes(2);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
