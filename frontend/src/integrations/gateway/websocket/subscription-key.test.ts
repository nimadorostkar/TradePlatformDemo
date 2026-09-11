import { describe, expect, it } from 'vitest';
import {
  buildSubscriptionQuery,
  buildSubscriptionProtocols,
  buildSubscriptionUrl,
  redactUrl,
  subscriptionKey,
} from './subscription-key';

describe('buildSubscriptionQuery', () => {
  it('builds the verified quote subscription', () => {
    // Matches src/QuoteSubscription.ts in the working integration.
    expect(buildSubscriptionQuery({ family: 'quote', symbol: 'EURUSD.' })).toEqual({
      symbol: 'EURUSD.',
      id: '1',
      methodtype: 'GetQuotes',
      TP: '1',
      source: 'tv',
    });
  });

  it('builds the verified intraday bar subscription', () => {
    expect(buildSubscriptionQuery({ family: 'intraday-bar', symbol: 'EURUSD.' })).toEqual({
      symbol: 'EURUSD.',
      fromtime: '0',
      totime: '1',
      data: 'dhloc',
      source: 'tv',
      methodtype: 'GetM1History',
      TP: '1',
    });
  });

  it('builds the daily bar subscription on TP=5', () => {
    // docs/API.md documents only TP=1..4, but internal/realtime/dispatch.go
    // handles TP=5 → GetLastDailyBar. The code is authoritative.
    expect(buildSubscriptionQuery({ family: 'daily-bar', symbol: 'XAUUSD.' })).toMatchObject({
      methodtype: 'GetLastDailyBar',
      TP: '5',
    });
  });

  it('builds the account, orders and positions subscriptions', () => {
    expect(buildSubscriptionQuery({ family: 'account', login: '1001' })).toEqual({
      login: '1001',
      methodtype: 'GetTradeState',
      TP: '3',
    });
    expect(buildSubscriptionQuery({ family: 'orders', login: '1001' })).toEqual({
      login: '1001',
      offset: '0',
      total: '1000',
      methodtype: 'GetPagebyPageOrder',
      TP: '4',
      source: 'tv',
    });
    expect(buildSubscriptionQuery({ family: 'positions', login: '1001' })).toEqual({
      login: '1001',
      offset: '0',
      total: '1000',
      methodtype: 'GetPagebyPagePositionWs',
      TP: '2',
      source: 'tv',
    });
  });

  it('refuses to build a subscription missing a required parameter', () => {
    expect(() => buildSubscriptionQuery({ family: 'quote' })).toThrow(/symbol/);
    expect(() => buildSubscriptionQuery({ family: 'account' })).toThrow(/login/);
  });
});

describe('subscriptionKey', () => {
  it('is independent of parameter order', () => {
    const a = subscriptionKey({ TP: '1', symbol: 'EURUSD.', methodtype: 'GetQuotes' });
    const b = subscriptionKey({ methodtype: 'GetQuotes', symbol: 'EURUSD.', TP: '1' });
    expect(a).toBe(b);
  });

  it('distinguishes genuinely different subscriptions', () => {
    const eur = subscriptionKey(buildSubscriptionQuery({ family: 'quote', symbol: 'EURUSD.' }));
    const gbp = subscriptionKey(buildSubscriptionQuery({ family: 'quote', symbol: 'GBPUSD.' }));
    expect(eur).not.toBe(gbp);
  });

  it('distinguishes the same symbol across accounts (suffix differs)', () => {
    const ecn = subscriptionKey(buildSubscriptionQuery({ family: 'quote', symbol: 'EURUSD.' }));
    const std = subscriptionKey(buildSubscriptionQuery({ family: 'quote', symbol: 'EURUSD!' }));
    expect(ecn).not.toBe(std);
  });

  it('never contains a token', () => {
    const key = subscriptionKey(buildSubscriptionQuery({ family: 'account', login: '1001' }));
    expect(key).not.toMatch(/access_token/);
  });
});

describe('token handling', () => {
  it('keeps the token out of the connection URL', () => {
    const url = buildSubscriptionUrl(
      'wss://gateway.test',
      buildSubscriptionQuery({ family: 'quote', symbol: 'EURUSD.' }),
    );
    expect(url).not.toContain('secret-jwt');
    expect(url).not.toContain('access_token');
    expect(url.startsWith('wss://gateway.test/ws?')).toBe(true);
  });

  it('carries the token in a credential subprotocol after the application protocol', () => {
    expect(buildSubscriptionProtocols('secret-jwt')).toEqual([
      'opotrade.v1',
      'opotrade.jwt.secret-jwt',
    ]);
  });

  it('rejects an empty credential protocol', () => {
    expect(() => buildSubscriptionProtocols('')).toThrow(/required/);
  });

  it('still redacts a legacy token URL used in diagnostics', () => {
    const url = new URL(
      buildSubscriptionUrl(
        'wss://gateway.test',
        buildSubscriptionQuery({ family: 'quote', symbol: 'EURUSD.' }),
      ),
    );
    url.searchParams.set('access_token', 'eyJhbGciOiJIUzI1NiJ9.super-secret.signature');
    const redacted = redactUrl(url.toString());

    expect(redacted).toContain('access_token=REDACTED');
    // Even a prefix of a token is a credential fragment.
    expect(redacted).not.toContain('eyJ');
    expect(redacted).not.toContain('super-secret');
    // Non-sensitive parameters survive so the diagnostic stays useful.
    expect(redacted).toContain('symbol=EURUSD');
  });

  it('does not throw on an unparseable url', () => {
    expect(redactUrl('not a url')).toBe('(unparseable url)');
  });
});
