import { afterEach, describe, expect, it } from 'vitest';
import { __setEnvForTests } from '@/app/config/env';
import { TEST_ENV } from '@/test/setup';
import { clientAreaHref, placementFor, terminalHref } from './surfaces';

const TERMINAL = 'https://trade.example.com';
const CLIENT_AREA = 'https://my.example.com';

function withOrigins(surface: 'auto' | 'terminal' | 'client-area' = 'auto') {
  __setEnvForTests({
    ...TEST_ENV,
    surface,
    terminalOrigin: TERMINAL,
    clientAreaOrigin: CLIENT_AREA,
  });
}

afterEach(() => __setEnvForTests(TEST_ENV));

describe('one host, no subdomains (the default)', () => {
  it('serves the terminal at / and the client area under /pa', () => {
    expect(placementFor('/', 'http://203.0.113.10:8080').surface).toBe('terminal');
    expect(placementFor('/pa/payments/deposit', 'http://203.0.113.10:8080')).toMatchObject({
      surface: 'client-area',
      clientAreaBase: '/pa',
    });
    expect(placementFor('/anything-else', 'http://203.0.113.10:8080').surface).toBe('not-found');
  });

  it('links stay on the host', () => {
    expect(terminalHref('1010', 'http://203.0.113.10:8080')).toBe('/?account=1010');
    expect(clientAreaHref('/trading/accounts', 'http://203.0.113.10:8080')).toBe(
      '/pa/trading/accounts',
    );
  });
});

describe('terminal and client area on their own subdomains', () => {
  it('the client-area origin is the client area from the root', () => {
    withOrigins();
    expect(placementFor('/', CLIENT_AREA)).toEqual({ surface: 'client-area', clientAreaBase: '' });
    expect(placementFor('/payments/deposit', CLIENT_AREA).surface).toBe('client-area');
  });

  it('the terminal origin serves the terminal and sends /pa across', () => {
    withOrigins();
    expect(placementFor('/', TERMINAL).surface).toBe('terminal');
    expect(placementFor('/pa/payments/deposit', TERMINAL).redirectTo).toBe(
      `${CLIENT_AREA}/payments/deposit`,
    );
    expect(placementFor('/pa', TERMINAL).redirectTo).toBe(`${CLIENT_AREA}/`);
    expect(placementFor('/elsewhere', TERMINAL).surface).toBe('not-found');
  });

  it('a third host (the bare IP) keeps the path-based layout', () => {
    withOrigins();
    expect(placementFor('/pa/settings', 'http://203.0.113.10:8080')).toMatchObject({
      surface: 'client-area',
      clientAreaBase: '/pa',
    });
  });

  it('cross-links point at the other subdomain', () => {
    withOrigins();
    expect(terminalHref('1010', CLIENT_AREA)).toBe(`${TERMINAL}/?account=1010`);
    expect(terminalHref(null, CLIENT_AREA)).toBe(`${TERMINAL}/`);
    expect(clientAreaHref('/trading/accounts', TERMINAL)).toBe(`${CLIENT_AREA}/trading/accounts`);
    // On its own host the client area links to itself at the root.
    expect(clientAreaHref('/trading/accounts', CLIENT_AREA)).toBe('/trading/accounts');
  });

  it('APP_SURFACE pins a surface whatever the host', () => {
    withOrigins('client-area');
    expect(placementFor('/', 'http://203.0.113.10:8080')).toEqual({
      surface: 'client-area',
      clientAreaBase: '',
    });
    withOrigins('terminal');
    expect(placementFor('/pa/x', 'http://203.0.113.10:8080').redirectTo).toBe(`${CLIENT_AREA}/x`);
  });
});
