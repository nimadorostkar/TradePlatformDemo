import { describe, expect, it, vi } from 'vitest';
import { createUnauthorizedHandler } from './unauthorized-policy';
import { TradingError } from '@/domain/common/errors';

const rejection = () =>
  new TradingError({
    kind: 'unauthorized',
    code: 'http.401',
    message: 'Your session has expired. Please sign in again.',
  });

/** Lets a started renewal settle, so the next 401 is not merely joining it. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A session whose held credential the test can swap, as a renewal would. */
function session(initial: string | null) {
  let token = initial;
  return {
    currentToken: () => token,
    set: (next: string | null) => {
      token = next;
    },
  };
}

describe('gateway 401 policy', () => {
  it('renews once and keeps the session alive', async () => {
    const held = session('jwt-1');
    const onExpired = vi.fn();
    const renew = vi.fn(async () => {
      held.set('jwt-2');
      return 'jwt-2';
    });

    const handle = createUnauthorizedHandler({ currentToken: held.currentToken, renew, onExpired });
    handle(rejection(), 'jwt-1');
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(1));

    expect(onExpired).not.toHaveBeenCalled();
  });

  it('ends the session when the renewal fails', async () => {
    const held = session('jwt-1');
    const onExpired = vi.fn();
    const error = rejection();

    const handle = createUnauthorizedHandler({
      currentToken: held.currentToken,
      renew: async () => null,
      onExpired,
    });
    handle(error, 'jwt-1');

    await vi.waitFor(() => expect(onExpired).toHaveBeenCalledWith(error));
  });

  it('ends the session when the renewal itself throws', async () => {
    const held = session('jwt-1');
    const onExpired = vi.fn();

    const handle = createUnauthorizedHandler({
      currentToken: held.currentToken,
      renew: () => Promise.reject(new Error('CRM unreachable')),
      onExpired,
    });
    handle(rejection(), 'jwt-1');

    await vi.waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
  });

  it('shares one renewal across a burst of 401s', async () => {
    // A dead session fails every open request at once. One exchange, not one
    // per request.
    const held = session('jwt-1');
    let release: (() => void) | null = null;
    const renew = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          release = () => {
            held.set('jwt-2');
            resolve('jwt-2');
          };
        }),
    );
    const onExpired = vi.fn();

    const handle = createUnauthorizedHandler({ currentToken: held.currentToken, renew, onExpired });
    handle(rejection(), 'jwt-1');
    handle(rejection(), 'jwt-1');
    handle(rejection(), 'jwt-1');

    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('ignores a 401 answering a credential the session has already replaced', async () => {
    // In flight across a renewal or an account switch. It says nothing about
    // the token now in hand, and acting on it would sign the trader out of a
    // session that is working.
    const held = session('jwt-2');
    const renew = vi.fn(async () => 'jwt-3');
    const onExpired = vi.fn();

    const handle = createUnauthorizedHandler({ currentToken: held.currentToken, renew, onExpired });
    handle(rejection(), 'jwt-1');

    await Promise.resolve();
    expect(renew).not.toHaveBeenCalled();
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('renews a given credential at most once', async () => {
    // The replacement was refused too, so renewing again would only repeat the
    // exchange against the CRM.
    const held = session('jwt-1');
    const renew = vi.fn(async () => {
      held.set('jwt-2');
      return 'jwt-2';
    });
    const onExpired = vi.fn();

    const handle = createUnauthorizedHandler({ currentToken: held.currentToken, renew, onExpired });
    handle(rejection(), 'jwt-1');
    await settled();
    expect(renew).toHaveBeenCalledTimes(1);

    handle(rejection(), 'jwt-2');
    await settled();
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('renews again after the session replaced the token by another route', async () => {
    // An account switch renews outside this handler. The credential it
    // produced has not been through a silent renewal, so it gets one.
    const held = session('jwt-1');
    const renew = vi.fn(async () => {
      held.set('jwt-2');
      return 'jwt-2';
    });
    const onExpired = vi.fn();

    const handle = createUnauthorizedHandler({ currentToken: held.currentToken, renew, onExpired });
    handle(rejection(), 'jwt-1');
    await settled();

    held.set('switched-jwt');
    renew.mockImplementation(async () => 'switched-jwt-2');
    handle(rejection(), 'switched-jwt');
    await settled();

    expect(renew).toHaveBeenCalledTimes(2);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('ends the session for a 401 on a request that carried no credential', async () => {
    const onExpired = vi.fn();
    const renew = vi.fn(async () => 'jwt-2');

    const handle = createUnauthorizedHandler({
      currentToken: () => null,
      renew,
      onExpired,
    });
    handle(rejection(), null);

    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(renew).not.toHaveBeenCalled();
  });
});
