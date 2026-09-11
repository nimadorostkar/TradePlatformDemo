import { describe, expect, it } from 'vitest';
import { clearAccountScopedIn } from './session-store';

/**
 * A real in-memory Storage. The suite's global localStorage is Node's
 * experimental one and lacks parts of the interface, so proving this behaviour
 * needs a complete stand-in — including `key(i)`, which is what makes the
 * reindexing hazard below reproducible.
 */
function makeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  } as Storage;
}

/**
 * MED-01. The retest of 2026-08-26 listed exactly what was live in a signed-in
 * session and still present afterwards. These are those keys.
 *
 * The report said the test matters more than the fix here, and it is right:
 * the failure is silent, lands on a shared computer, and hands the next person
 * the previous trader's account number, notes and half-typed order.
 */
const ACCOUNT_SCOPED_LOCAL = {
  'tradeplatform.last-account': '15597243',
  'tradeplatform.last-account-snapshot': '{"login":"15597243","suffix":"","readOnly":false}',
  'tradeplatform.journal.v1': '{"version":1,"entries":[{"body":"my thesis"}]}',
  'tradeplatform.tv-qty-default.v2': '0.25',
  'tradeplatform.last-activity': '1787740000',
  'tradeplatform.tv.charts': '{"layout":"…"}',
  'tradeplatform.tv.drawings': '{"lines":[]}',
};

const LAYOUT_KEPT = {
  'tradeplatform.workspace.active': 'default',
  'tradeplatform.workspace.index': '["default"]',
  'tradeplatform.workspace.v3.default': '{"regions":{}}',
  'tradeplatform.chunk-reload-at': '1787740000',
};

describe('sign-out clears account-scoped storage', () => {
  it('removes every account-scoped key from both storages', () => {
    const local = makeStorage(ACCOUNT_SCOPED_LOCAL);
    const session = makeStorage({
      'tradeplatform.order-draft': '{"kind":"market","volume":"0.01"}',
    });

    clearAccountScopedIn(local);
    clearAccountScopedIn(session);

    for (const key of Object.keys(ACCOUNT_SCOPED_LOCAL)) {
      expect(local.getItem(key), `${key} survived sign-out`).toBeNull();
    }
    expect(session.getItem('tradeplatform.order-draft')).toBeNull();
  });

  it('keeps layout preferences, which carry no account data', () => {
    const local = makeStorage(LAYOUT_KEPT);

    clearAccountScopedIn(local);

    for (const [key, value] of Object.entries(LAYOUT_KEPT)) {
      expect(local.getItem(key), `${key} should survive`).toBe(value);
    }
  });

  it('clears a key nobody has invented yet', () => {
    // The actual guarantee. The previous implementation deleted a fixed list,
    // so every key added after it was written leaked by default. This is the
    // regression that must not return.
    const local = makeStorage({ 'tradeplatform.something-added-next-month': 'account data' });
    const session = makeStorage({ 'tradeplatform.another-new-thing': 'account data' });

    clearAccountScopedIn(local);
    clearAccountScopedIn(session);

    expect(local.getItem('tradeplatform.something-added-next-month')).toBeNull();
    expect(session.getItem('tradeplatform.another-new-thing')).toBeNull();
  });

  it('clears the legacy auth-storage keys', () => {
    // VITE_ENABLE_LEGACY_AUTH_STORAGE opens a second path that held raw tokens.
    const local = makeStorage({ token: 'a.jwt.value', crm_token: 'a.crm.value' });

    clearAccountScopedIn(local);

    expect(local.getItem('token')).toBeNull();
    expect(local.getItem('crm_token')).toBeNull();
  });

  it('leaves other applications on the same origin alone', () => {
    const local = makeStorage({ 'unrelated-app.setting': 'keep me' });
    clearAccountScopedIn(local);
    expect(local.getItem('unrelated-app.setting')).toBe('keep me');
  });

  it('removes every key even though removal reindexes the store', () => {
    // Removing while enumerating skips every other key — the classic version
    // of this bug, which would leave half the data behind.
    const seed: Record<string, string> = {};
    for (let i = 0; i < 12; i++) seed[`tradeplatform.scoped-${i}`] = String(i);
    const local = makeStorage(seed);

    clearAccountScopedIn(local);

    expect(local.length).toBe(0);
  });
});
