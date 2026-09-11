import { create } from 'zustand';
import type { AccountOption } from '@/integrations/gateway/mappers/to-domain';
import { NO_SUFFIX_POLICY, SymbolSuffixPolicy } from '@/integrations/gateway/mappers/symbol-suffix';

/**
 * Session and account-selection state.
 *
 * Kept separate from `trading-store` because it changes rarely — mixing a
 * once-per-session value into the store that ticks would re-render account UI
 * on every position update.
 */

export type AuthStatus = 'initialising' | 'signed-out' | 'signing-in' | 'signed-in' | 'expired';

/**
 * Progress of the account-list fetch.
 *
 * Tracked separately from `accounts`, because an empty list and a list that has
 * not been fetched yet are indistinguishable by content alone. Telling a trader
 * "no tradable account" before we have finished asking is a false statement.
 */
export type AccountsStatus = 'idle' | 'loading' | 'ready' | 'error';

interface SessionState {
  status: AuthStatus;
  username: string | null;
  accounts: AccountOption[];
  accountsStatus: AccountsStatus;
  accountsError: string | null;
  activeLogin: string | null;
  /** Suffix policy derived from the ACTIVE account's type. */
  suffixPolicy: SymbolSuffixPolicy;
  /** True when the account may not trade (investor mode or MT5 rights). */
  readOnly: boolean;
  error: string | null;

  setStatus: (status: AuthStatus, error?: string | null) => void;
  setUsername: (username: string | null) => void;
  setAccounts: (accounts: AccountOption[]) => void;
  setAccountsStatus: (status: AccountsStatus, error?: string | null) => void;
  setActiveAccount: (login: string | null) => void;
  setReadOnly: (readOnly: boolean) => void;
  /**
   * Replaces the active account's suffix policy after a live probe proved the
   * configured one wrong (see integrations/gateway/suffix-probe). Ignored when
   * the account has changed since the probe started — a stale correction must
   * never leak onto a different account.
   */
  correctSuffix: (login: string, suffix: string) => void;
  /**
   * Boots the last remembered account (login + suffix + read-only flag) so a
   * restored session can render the terminal before the CRM account list
   * resolves. `claimedLogins` is the gateway JWT's accounts claim — the
   * synchronously-available authority on what this session may touch; a
   * snapshot outside it is another user's and is forgotten, not adopted.
   * Returns false when nothing valid is remembered or an account is already
   * active. See the implementation for the reconciliation contract.
   */
  adoptRecalledAccount: (claimedLogins: readonly string[]) => boolean;
  reset: () => void;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  status: 'initialising',
  username: null,
  accounts: [],
  accountsStatus: 'idle',
  accountsError: null,
  activeLogin: null,
  suffixPolicy: NO_SUFFIX_POLICY,
  readOnly: false,
  error: null,

  setStatus: (status, error = null) => set({ status, error }),
  setUsername: (username) => set({ username }),

  setAccounts: (accounts) => set({ accounts }),

  setAccountsStatus: (accountsStatus, accountsError = null) =>
    set({ accountsStatus, accountsError }),

  setActiveAccount: (login) => {
    if (login === null) {
      set({ activeLogin: null, suffixPolicy: NO_SUFFIX_POLICY, readOnly: false });
      return;
    }
    const account = get().accounts.find((a) => a.login === login);
    // The suffix policy is rebuilt on every switch — reusing the previous
    // policy would send the previous group's symbol names. The account's
    // RESOLVED suffix (gateway deployment config first, built-in type map as
    // fallback — see crm-session.listAccounts) takes precedence; the type map
    // alone is the last resort for accounts loaded by an older code path.
    const suffixPolicy =
      account?.suffix !== null && account?.suffix !== undefined
        ? new SymbolSuffixPolicy(account.suffix)
        : SymbolSuffixPolicy.forAccountType(account?.typeId ?? null);
    const readOnly = account?.readOnly ?? false;
    // Re-applying the active account (the post-list reconcile does this on
    // every refresh) must not hand subscribers a fresh-but-identical policy
    // object — that would re-render every consumer for nothing.
    const previous = get();
    if (
      previous.activeLogin !== login ||
      previous.suffixPolicy.suffix !== suffixPolicy.suffix ||
      previous.readOnly !== readOnly
    ) {
      set({ activeLogin: login, suffixPolicy, readOnly });
    }
    rememberLastAccount(login);
    // Snapshot only what a fast boot needs, and only from a RESOLVED account
    // row — an adopted snapshot must never re-persist itself, or a stale
    // value could survive forever.
    if (account) {
      rememberAccountSnapshot({ login, suffix: suffixPolicy.suffix, readOnly });
    }
  },

  setReadOnly: (readOnly) => {
    set({ readOnly });
    const { activeLogin, suffixPolicy } = get();
    if (activeLogin !== null) {
      rememberAccountSnapshot({ login: activeLogin, suffix: suffixPolicy.suffix, readOnly });
    }
  },

  correctSuffix: (login, suffix) => {
    const state = get();
    if (state.activeLogin !== login) return;
    if (state.suffixPolicy.suffix === suffix) return;
    set({ suffixPolicy: new SymbolSuffixPolicy(suffix) });
    rememberAccountSnapshot({ login, suffix, readOnly: state.readOnly });
  },

  adoptRecalledAccount: (claimedLogins) => {
    if (get().activeLogin !== null) return false;
    const snapshot = recallAccountSnapshot();
    if (!snapshot) return false;
    // The snapshot is browser-scoped, but the SESSION is user-scoped: a
    // different CRM user signing in on this browser must never boot into the
    // previous user's account. Adopting an unauthorized login is fail-closed
    // server-side, but it produced a full boot's worth of 403s and failed
    // WebSockets before the CRM list corrected it (observed live 2026-08-24:
    // login 600132510 adopted under a session whose claim did not carry it).
    // The JWT accounts claim is available synchronously at boot and is the
    // authority on what this session may touch — a snapshot outside it is
    // treated as belonging to someone else and forgotten.
    if (!claimedLogins.includes(snapshot.login)) {
      forgetAccountSnapshot();
      return false;
    }
    // The snapshot is metadata remembered from the last resolved session on
    // this browser — login number, symbol suffix, read-only flag; never a
    // credential. Adopting it lets the terminal (and above all the chart)
    // boot immediately on a restored session instead of waiting the measured
    // 5.7–12 s for the CRM account list. The authoritative list still loads
    // and reconciles: a vanished login falls back to normal selection, and a
    // changed suffix or read-only flag is re-applied the moment it is known.
    // The gateway enforces account rights server-side on every request, so a
    // stale flag here can inconvenience, never authorize.
    set({
      activeLogin: snapshot.login,
      suffixPolicy: new SymbolSuffixPolicy(snapshot.suffix),
      readOnly: snapshot.readOnly,
    });
    return true;
  },

  reset: () => {
    // MED-01: sign-out on a shared computer must not leave the previous
    // trader's account number, fast-boot snapshot, or half-typed order for
    // the next person. Layout preferences deliberately survive — they carry
    // no account data. reset() is the single choke point every sign-out path
    // (header button, expired session, dead CRM token) already goes through.
    clearAccountScopedStorage();
    set({
      status: 'signed-out',
      username: null,
      accounts: [],
      accountsStatus: 'idle',
      accountsError: null,
      activeLogin: null,
      suffixPolicy: NO_SUFFIX_POLICY,
      readOnly: false,
      error: null,
    });
  },
}));

/**
 * Everything sign-out must remove — defined by what SURVIVES, not by what goes.
 *
 * The retest of 2026-08-26 found three account-scoped keys still present after
 * sign-out (the journal, the default order quantity, the idle stamp) because
 * the old version listed the keys to delete, and a list of things to delete
 * only covers the keys that existed the day it was written. Inverting it means
 * a key added next month is cleared by default, which is the property that
 * matters: this is a defect that returns quietly, on a shared computer, as the
 * previous trader's data.
 *
 * Layout preferences legitimately survive — they carry no account data.
 */
const SURVIVES_SIGN_OUT: readonly string[] = [
  'tradeplatform.workspace.', // saved layouts, panel sizes, the active workspace
  'tradeplatform.chunk-reload-at', // stale-build recovery marker, not user data
];

/** Legacy token keys, cleared whenever VITE_ENABLE_LEGACY_AUTH_STORAGE was on. */
const LEGACY_AUTH_KEYS: readonly string[] = ['token', 'crm_token'];

/**
 * Keys removed by name as well as by sweep.
 *
 * The sweep below needs `length` and `key(i)`, which a real browser Storage
 * always has — but not every environment this runs in does (an embedded
 * webview, or Node's partial implementation under test), and there the sweep
 * would silently clear NOTHING. Naming the keys we already know keeps the
 * guarantee in a degraded environment; the sweep adds the ones nobody has
 * invented yet. Neither alone is enough.
 */
const KNOWN_ACCOUNT_SCOPED_KEYS: readonly string[] = [
  'tradeplatform.last-account',
  'tradeplatform.last-account-snapshot',
  'tradeplatform.order-draft',
  'tradeplatform.journal.v1',
  'tradeplatform.tv-qty-default.v2',
  'tradeplatform.last-activity',
  'tradeplatform.tv.charts',
  'tradeplatform.tv.drawings',
  ...LEGACY_AUTH_KEYS,
];

/**
 * Clears one storage. Exported for tests: the suite's global `localStorage` is
 * Node's experimental implementation, which is not a complete Storage, so a
 * test that wants to prove this behaviour has to supply its own.
 */
export function clearAccountScopedIn(
  storage: Pick<Storage, 'removeItem'> & Partial<Pick<Storage, 'length' | 'key'>>,
): void {
  // By name first, so the guarantee holds even where the sweep cannot run.
  for (const key of KNOWN_ACCOUNT_SCOPED_KEYS) storage.removeItem(key);

  if (typeof storage.length !== 'number' || typeof storage.key !== 'function') return;

  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key === null) continue;
    if (LEGACY_AUTH_KEYS.includes(key)) {
      doomed.push(key);
      continue;
    }
    if (!key.startsWith('tradeplatform.')) continue;
    if (SURVIVES_SIGN_OUT.some((prefix) => key.startsWith(prefix))) continue;
    doomed.push(key);
  }
  // Collected first: removing while enumerating reindexes the store and skips
  // every other key.
  for (const key of doomed) storage.removeItem(key);
}

/** Every account-scoped key sign-out must remove (MED-01). */
export function clearAccountScopedStorage(): void {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      clearAccountScopedIn(storage);
    } catch {
      /* storage blocked (private mode, embedded webview) */
    }
  }
}

// The last selected account, so a restored session (AUTH-001) reopens on the
// account the trader was actually using. A login NUMBER is stored — never a
// credential — and a blocked/full storage silently degrades to "first account".
const LAST_ACCOUNT_KEY = 'tradeplatform.last-account';

function rememberLastAccount(login: string): void {
  try {
    localStorage.setItem(LAST_ACCOUNT_KEY, login);
  } catch {
    // Storage can be blocked entirely (private mode, embedded webview).
  }
}

export function recallLastAccount(): string | null {
  try {
    return localStorage.getItem(LAST_ACCOUNT_KEY);
  } catch {
    return null;
  }
}

// The fast-boot snapshot: enough about the last active account to render the
// terminal before the CRM list arrives. Written only from a RESOLVED account
// (see setActiveAccount), read once per boot by adoptRecalledAccount.
const ACCOUNT_SNAPSHOT_KEY = 'tradeplatform.last-account-snapshot';

interface AccountSnapshot {
  login: string;
  suffix: string;
  readOnly: boolean;
}

function rememberAccountSnapshot(snapshot: AccountSnapshot): void {
  try {
    localStorage.setItem(ACCOUNT_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage can be blocked entirely (private mode, embedded webview).
  }
}

function recallAccountSnapshot(): AccountSnapshot | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as AccountSnapshot).login === 'string' &&
      (parsed as AccountSnapshot).login !== '' &&
      typeof (parsed as AccountSnapshot).suffix === 'string' &&
      typeof (parsed as AccountSnapshot).readOnly === 'boolean'
    ) {
      return parsed as AccountSnapshot;
    }
    return null;
  } catch {
    return null;
  }
}

export function forgetAccountSnapshot(): void {
  try {
    localStorage.removeItem(ACCOUNT_SNAPSHOT_KEY);
  } catch {
    /* nothing to clear */
  }
}

export const selectActiveLogin = (s: SessionState) => s.activeLogin;
export const selectSuffixPolicy = (s: SessionState) => s.suffixPolicy;
export const selectReadOnly = (s: SessionState) => s.readOnly;
export const selectAccounts = (s: SessionState) => s.accounts;
export const selectAccountsStatus = (s: SessionState) => s.accountsStatus;
