import { TradingError } from '@/domain/common/errors';
import type { TokenStore } from '@/integrations/gateway/auth/token-store';

/**
 * The client area's CRM calls (demomarket's /client-api). Every request
 * carries the CRM bearer token; errors become TradingErrors the UI already
 * knows how to show, with the server's own message where it gave one.
 */

export type AccountKind = 'real' | 'demo';

export interface ClientAccount {
  login: string;
  typeId: number;
  currency: string;
  balance: number;
  equity: number;
  margin: number;
  marginFree: number;
  leverage: number;
  openPositions: number;
  pendingOrders: number;
  createdAt: string;
  kind: AccountKind;
  hasTradingPassword: boolean;
  type: { id: number; title: string; platform: string; server: string };
}

export interface AccountType {
  id: number;
  title: string;
  platform: string;
  description: string;
  maxLeverage: number;
  minDeposit: number;
}

export interface Catalogue {
  types: AccountType[];
  leverages: number[];
  currencies: string[];
  demoStartBalance: number;
  depositMethods: string[];
  withdrawalMethods: string[];
}

export interface ClientTransaction {
  id: number;
  login: string;
  kind: 'deposit' | 'withdrawal' | 'transfer_in' | 'transfer_out';
  amount: number;
  currency: string;
  method: string;
  status: string;
  counterpart: string;
  comment: string;
  createdAt: string;
}

export type StepStatus = 'unverified' | 'pending' | 'verified';

export interface VerificationStep {
  id: 'profile' | 'identity' | 'address';
  title: string;
  status: StepStatus;
  unlocks: string[];
  missing?: string[];
  submitted?: Record<string, string>;
}

export interface Verification {
  level: number;
  verified: boolean;
  stepsComplete: number;
  stepsTotal: number;
  steps: VerificationStep[];
  depositLimit: number | null;
  depositRemaining: number | null;
  depositedTotal: number;
  withdrawalsEnabled: boolean;
}

export interface ClientUser {
  id: number;
  email: string;
  name: string;
  phone: string;
  country: string;
  city: string;
  language: string;
  timezone: string;
  kycStatus: StepStatus;
  dateOfBirth: string;
  address: string;
  postalCode: string;
  addressStatus: StepStatus;
  verificationLevel: number;
  createdAt: string;
}

export interface ProfileInput {
  name: string;
  phone: string;
  country: string;
  city: string;
  language: string;
  timezone: string;
}

export class ClientAreaApi {
  constructor(
    private readonly crmBaseUrl: string,
    private readonly tokens: TokenStore,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; signal?: AbortSignal; auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.auth !== false) {
      const crmToken = this.tokens.get()?.crmToken;
      if (!crmToken) {
        throw new TradingError({
          kind: 'unauthorized',
          message: 'Sign in again to continue.',
          code: 'auth.no-crm-token',
        });
      }
      headers.Authorization = `Bearer ${crmToken}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.crmBaseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
        credentials: 'omit',
      });
    } catch (error) {
      throw TradingError.from(error, {
        kind: 'network',
        message: 'The account service could not be reached.',
      });
    }
    const text = await response.text();
    const body: unknown = text ? safeJson(text) : null;
    if (response.ok) return body as T;

    const serverMessage =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : null;
    const code =
      body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string'
        ? (body as { code: string }).code
        : `crm.${response.status}`;
    if (response.status === 401) {
      throw new TradingError({
        kind: 'unauthorized',
        message: 'Your session has expired. Please sign in again.',
        code: 'crm.401',
      });
    }
    throw new TradingError({
      kind:
        response.status === 400 ||
        response.status === 403 ||
        response.status === 404 ||
        response.status === 409 ||
        response.status === 422
          ? 'validation'
          : 'unavailable',
      message: serverMessage ?? `The account service answered ${response.status}.`,
      code,
      payload: body,
    });
  }

  catalogue(signal?: AbortSignal) {
    return this.request<Catalogue>('/client-api/account-types', { signal, auth: false });
  }

  me(signal?: AbortSignal) {
    return this.request<ClientUser>('/client-api/me', { signal });
  }

  updateProfile(input: ProfileInput, signal?: AbortSignal) {
    return this.request<ClientUser>('/client-api/me', { method: 'PUT', body: input, signal });
  }

  changePassword(currentPassword: string, newPassword: string) {
    return this.request<{ changed: boolean }>('/client-api/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    });
  }

  accounts(signal?: AbortSignal) {
    return this.request<ClientAccount[]>('/client-api/accounts?version=1.0.0', {
      method: 'POST',
      body: {},
      signal,
    });
  }

  openAccount(input: { typeId: number; kind: AccountKind; currency: string; leverage: number }) {
    return this.request<ClientAccount>('/client-api/accounts/open', {
      method: 'POST',
      body: input,
    });
  }

  setTradingPassword(login: string, password: string) {
    return this.request<{ changed: boolean }>(`/client-api/accounts/${login}/trading-password`, {
      method: 'POST',
      body: { password },
    });
  }

  deposit(input: { login: string; amount: number; method: string }) {
    return this.request<{ transaction: ClientTransaction; balance: number }>(
      '/client-api/deposit',
      { method: 'POST', body: input },
    );
  }

  withdraw(input: { login: string; amount: number; method: string }) {
    return this.request<{ transaction: ClientTransaction; balance: number }>(
      '/client-api/withdraw',
      { method: 'POST', body: input },
    );
  }

  transfer(input: { from: string; to: string; amount: number }) {
    return this.request<{ transactions: ClientTransaction[]; balances: Record<string, number> }>(
      '/client-api/transfer',
      { method: 'POST', body: input },
    );
  }

  transactions(signal?: AbortSignal) {
    return this.request<ClientTransaction[]>('/client-api/transactions?limit=200', { signal });
  }

  verification(signal?: AbortSignal) {
    return this.request<{ user: ClientUser; verification: Verification }>(
      '/client-api/verification',
      { signal },
    );
  }

  submitIdentity(input: { documentType: string; documentNumber: string; dateOfBirth: string }) {
    return this.request<{ user: ClientUser; verification: Verification }>(
      '/client-api/verification/identity',
      { method: 'POST', body: input },
    );
  }

  submitAddress(input: { address: string; city: string; postalCode: string; country: string }) {
    return this.request<{ user: ClientUser; verification: Verification }>(
      '/client-api/verification/address',
      { method: 'POST', body: input },
    );
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 200) };
  }
}
