import { beforeEach, describe, expect, it, vi } from 'vitest';
import { switchTradingAccount } from './account-switch';
import type { AuthSession, SessionTokens } from '@/integrations/gateway/auth/auth-session';
import { useSessionStore } from '@/stores/session-store';
import { NO_SUFFIX_POLICY } from '@/integrations/gateway/mappers/symbol-suffix';

/**
 * Every account switch runs behind a FRESH gateway JWT: renewal extends the
 * token's expiry and re-checks the target account's authorization at switch
 * time. A failed renewal or a missing claim CANCELS the switch — the current
 * account must stay active on the current, still-valid token.
 */

function jwt(accounts: string): string {
  const payload = btoa(JSON.stringify({ accounts, exp: Date.now() / 1000 + 3600 }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

function tokens(accounts: string): SessionTokens {
  return { gatewayToken: jwt(accounts), crmToken: 'crm', expiresAt: Date.now() + 3_600_000 };
}

function authWith(renewed: SessionTokens | null): AuthSession {
  return { renew: vi.fn().mockResolvedValue(renewed) } as unknown as AuthSession;
}

beforeEach(() => {
  useSessionStore.setState({
    activeLogin: '1001',
    suffixPolicy: NO_SUFFIX_POLICY,
    readOnly: false,
    accounts: [
      {
        login: '1002',
        name: 'Standard 1002',
        typeId: 58,
        server: null,
        currency: 'USD',
        readOnly: false,
        enabled: true,
        suffix: '!',
      },
    ],
  });
});

describe('switchTradingAccount', () => {
  it('renews, verifies the claim, and activates the account', async () => {
    const auth = authWith(tokens('1001,1002'));

    await switchTradingAccount(auth, '1002');

    expect(auth.renew).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().activeLogin).toBe('1002');
    // The account's resolved suffix rode along with the activation.
    expect(useSessionStore.getState().suffixPolicy.suffix).toBe('!');
  });

  it('cancels the switch when renewal fails', async () => {
    const auth = authWith(null);

    await expect(switchTradingAccount(auth, '1002')).rejects.toMatchObject({
      code: 'auth.switch-renewal',
    });
    // The current account is untouched — never stranded between accounts.
    expect(useSessionStore.getState().activeLogin).toBe('1001');
  });

  it('cancels the switch when the fresh claim no longer authorizes the account', async () => {
    // The CRM revoked 1002 since sign-in; the renewed token proves it.
    const auth = authWith(tokens('1001'));

    await expect(switchTradingAccount(auth, '1002')).rejects.toMatchObject({
      code: 'auth.switch-unauthorized',
    });
    expect(useSessionStore.getState().activeLogin).toBe('1001');
  });
});
