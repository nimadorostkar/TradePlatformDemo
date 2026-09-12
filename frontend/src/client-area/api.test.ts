import { describe, expect, it, vi } from 'vitest';
import { TradingError } from '@/domain/common/errors';
import { ClientAreaApi } from './api';

function api(response: { status: number; body?: unknown }, crmToken: string | null = 'crm-token') {
  const fetchImpl = vi.fn(
    async () =>
      new Response(response.body === undefined ? null : JSON.stringify(response.body), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const tokens = { get: () => (crmToken ? { crmToken, gatewayToken: 'jwt' } : null) };
  return {
    api: new ClientAreaApi('/crm', tokens as never, fetchImpl as unknown as typeof fetch),
    fetchImpl,
  };
}

describe('ClientAreaApi', () => {
  it('sends the CRM bearer token and JSON bodies', async () => {
    const { api: client, fetchImpl } = api({ status: 201, body: { transaction: {}, balance: 10 } });
    await client.deposit({ login: '1010', amount: 10, method: 'Bank card' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/crm/client-api/deposit');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer crm-token');
    expect(JSON.parse(String(init.body))).toEqual({
      login: '1010',
      amount: 10,
      method: 'Bank card',
    });
  });

  it("surfaces the server's own message for a refused request", async () => {
    const { api: client } = api({
      status: 403,
      body: { error: 'complete your profile to enable withdrawals', code: 'verification_required' },
    });
    await expect(
      client.withdraw({ login: '1010', amount: 5, method: 'Bank card' }),
    ).rejects.toMatchObject({
      kind: 'validation',
      code: 'verification_required',
      message: 'complete your profile to enable withdrawals',
    });
  });

  it('turns a 401 into an unauthorized error and a missing token into one without a request', async () => {
    const { api: expired } = api({ status: 401, body: {} });
    await expect(expired.me()).rejects.toMatchObject({ kind: 'unauthorized' });
    const { api: signedOut, fetchImpl } = api({ status: 200, body: {} }, null);
    await expect(signedOut.me()).rejects.toBeInstanceOf(TradingError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not need a token for the public catalogue', async () => {
    const { api: client, fetchImpl } = api({ status: 200, body: { types: [] } }, null);
    await expect(client.catalogue()).resolves.toEqual({ types: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
