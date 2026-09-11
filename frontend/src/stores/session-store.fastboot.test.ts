import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetAccountSnapshot, useSessionStore } from './session-store';

// Node 22's experimental localStorage global shadows jsdom's here and is a
// stub without working methods. The store treats storage failures as "no
// snapshot", so these tests need a real (if tiny) storage to exercise the
// round-trip at all.
const backing = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => void backing.set(key, value),
  removeItem: (key: string) => void backing.delete(key),
});

/**
 * The fast-boot contract (chart-load performance, 2026-08-24): a restored
 * session must be able to render the terminal from the remembered account
 * snapshot BEFORE the CRM account list resolves — measured at a 5.7 s floor,
 * 12 s worst case — and the authoritative list must still win afterwards.
 */
describe('account snapshot fast boot', () => {
  beforeEach(() => {
    backing.clear();
    useSessionStore.getState().reset();
    useSessionStore.setState({ status: 'signed-in' });
  });

  it('adopts nothing on a browser with no remembered account', () => {
    expect(useSessionStore.getState().adoptRecalledAccount(['7788', '1010'])).toBe(false);
    expect(useSessionStore.getState().activeLogin).toBeNull();
  });

  it('round-trips the resolved account through the snapshot', () => {
    const session = useSessionStore.getState();
    session.setAccounts([
      {
        login: '7788',
        name: 'OPO Trade STD 7788',
        currency: 'USD',
        enabled: true,
        readOnly: true,
        typeId: 57,
        suffix: '!',
        server: 'Opogroup-Server1',
      },
    ]);
    session.setActiveAccount('7788');

    // A later visit: fresh store, list not yet loaded. NOT reset() — that is
    // the SIGN-OUT path and now clears the snapshot on purpose (MED-01); a
    // reload simply starts from a blank in-memory store.
    useSessionStore.setState({
      status: 'signed-in',
      accounts: [],
      accountsStatus: 'idle',
      activeLogin: null,
      readOnly: false,
    });

    expect(useSessionStore.getState().adoptRecalledAccount(['7788'])).toBe(true);
    const adopted = useSessionStore.getState();
    expect(adopted.activeLogin).toBe('7788');
    expect(adopted.suffixPolicy.suffix).toBe('!');
    // Read-only MUST survive the snapshot: booting an investor account as
    // tradable, even briefly, would be a trading regression.
    expect(adopted.readOnly).toBe(true);
  });

  it('does not adopt over an already-active account', () => {
    const session = useSessionStore.getState();
    session.setAccounts([
      {
        login: '1010',
        name: 'A',
        currency: 'USD',
        enabled: true,
        readOnly: false,
        typeId: 57,
        suffix: '',
        server: 's',
      },
    ]);
    session.setActiveAccount('1010');
    expect(useSessionStore.getState().adoptRecalledAccount(['7788', '1010'])).toBe(false);
    expect(useSessionStore.getState().activeLogin).toBe('1010');
  });

  it('adopts nothing after the snapshot is forgotten (dead CRM token path)', () => {
    const session = useSessionStore.getState();
    session.setAccounts([
      {
        login: '1010',
        name: 'A',
        currency: 'USD',
        enabled: true,
        readOnly: false,
        typeId: 57,
        suffix: '',
        server: 's',
      },
    ]);
    session.setActiveAccount('1010');
    forgetAccountSnapshot();
    useSessionStore.getState().reset();
    expect(useSessionStore.getState().adoptRecalledAccount(['7788', '1010'])).toBe(false);
  });

  it('refuses a snapshot outside the session JWT accounts claim (cross-user)', () => {
    // Observed live 2026-08-24: a browser last used with login 600132510 was
    // signed into by a DIFFERENT CRM user, and the fast boot adopted the old
    // account — a full boot of 403s and failed WebSockets until the CRM list
    // corrected it. The claim is the authority; a foreign snapshot is
    // forgotten, never adopted.
    const session = useSessionStore.getState();
    session.setAccounts([
      {
        login: '600132510',
        name: 'ECN Pro',
        currency: 'USD',
        enabled: true,
        readOnly: false,
        typeId: 57,
        suffix: '',
        server: 's',
      },
    ]);
    session.setActiveAccount('600132510');

    // A different user signs in: fresh store, a claim that does NOT carry
    // the remembered login.
    useSessionStore.getState().reset();
    useSessionStore.setState({ status: 'signed-in' });

    expect(useSessionStore.getState().adoptRecalledAccount(['15597243'])).toBe(false);
    expect(useSessionStore.getState().activeLogin).toBeNull();
    // And the foreign snapshot is gone for good — the next boot under ANY
    // claim starts clean.
    expect(useSessionStore.getState().adoptRecalledAccount(['600132510'])).toBe(false);
  });

  it('sign-out clears every account-scoped key (MED-01)', () => {
    const session = useSessionStore.getState();
    session.setAccounts([
      {
        login: '7788',
        name: 'OPO Trade STD 7788',
        currency: 'USD',
        enabled: true,
        readOnly: true,
        typeId: 57,
        suffix: '!',
        server: 'Opogroup-Server1',
      },
    ]);
    session.setActiveAccount('7788');
    sessionStorage.setItem('tradeplatform.order-draft', '{"volume":"0.01"}');

    useSessionStore.getState().reset();

    // On a shared computer the next person must find nothing of the previous
    // trader: no login number, no fast-boot snapshot, no half-typed order.
    expect(localStorage.getItem('tradeplatform.last-account')).toBeNull();
    expect(localStorage.getItem('tradeplatform.last-account-snapshot')).toBeNull();
    expect(sessionStorage.getItem('tradeplatform.order-draft')).toBeNull();
    expect(useSessionStore.getState().adoptRecalledAccount(['7788'])).toBe(false);
  });
});
