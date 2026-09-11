import { describe, expect, it } from 'vitest';
import { TokenStore } from './token-store';

/** Minimal in-memory Storage double. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe('TokenStore legacy storage hygiene', () => {
  it('purges leftover legacy tokens at construction when legacy mode is off', () => {
    // A pre-flag build persisted the JWT — with the full account-id claim —
    // under these keys and nothing ever deleted it.
    const storage = fakeStorage({ token: 'stale.jwt', crm_token: 'stale-crm', other: 'keep' });

    new TokenStore({ legacyStorage: false, storage });

    expect(storage.getItem('token')).toBeNull();
    expect(storage.getItem('crm_token')).toBeNull();
    expect(storage.getItem('other')).toBe('keep');
  });

  it('keeps and reads the legacy keys when legacy mode is on', () => {
    const storage = fakeStorage({ token: 'legacy.jwt', crm_token: 'legacy-crm' });

    const store = new TokenStore({ legacyStorage: true, storage });

    expect(store.gatewayToken()).toBe('legacy.jwt');
    expect(storage.getItem('token')).toBe('legacy.jwt');
  });

  it('survives a storage that throws', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;

    expect(() => new TokenStore({ legacyStorage: false, storage })).not.toThrow();
    expect(() => new TokenStore({ legacyStorage: true, storage })).not.toThrow();
  });

  it('notifies subscribers on every token replacement', () => {
    const store = new TokenStore({ legacyStorage: false, storage: fakeStorage() });
    const seen: Array<string | null> = [];
    store.subscribe((tokens) => seen.push(tokens?.gatewayToken ?? null));

    store.set({ gatewayToken: 'a', crmToken: null, expiresAt: 1 });
    store.set({ gatewayToken: 'b', crmToken: null, expiresAt: 2 });
    store.clear();

    expect(seen).toEqual(['a', 'b', null]);
  });
});
