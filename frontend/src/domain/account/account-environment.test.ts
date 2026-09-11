import { describe, expect, it } from 'vitest';
import { accountFundsOf, FUNDS_LABEL, FUNDS_TONE, hasBadge } from './account-environment';

/**
 * The 2026-08-26 retest named the unsafe DEFAULT as the defect: every account
 * was badged LIVE because nothing said otherwise. These tests exist to make
 * that specific regression loud — it is the kind that returns quietly.
 */
describe('accountFundsOf', () => {
  it('reads what the gateway stated', () => {
    expect(accountFundsOf('live')).toBe('live');
    expect(accountFundsOf('demo')).toBe('demo');
  });

  it('tolerates case and whitespace from the wire', () => {
    expect(accountFundsOf(' LIVE ')).toBe('live');
    expect(accountFundsOf('Demo')).toBe('demo');
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '   '],
    ['unrecognised', 'unknown'],
    ['a typo', 'liv'],
    ['a newer gateway value', 'simulated'],
    ['a number', 1],
    ['a boolean', true],
    ['an object', { kind: 'live' }],
  ])('never produces LIVE for %s', (_label, value) => {
    const funds = accountFundsOf(value);
    expect(funds).toBe('unknown');
    // The assertion that matters: nothing renders.
    expect(hasBadge(funds)).toBe(false);
  });

  it('renders no badge for an unknown account', () => {
    expect(hasBadge(accountFundsOf(undefined))).toBe(false);
    expect(hasBadge('live')).toBe(true);
    expect(hasBadge('demo')).toBe(true);
  });

  it('gives demo its own colour token, not just different text', () => {
    // A visually distinct treatment was the explicit ask: two words in the
    // same amber differ by one glance's worth of attention.
    expect(FUNDS_TONE.demo).not.toBe(FUNDS_TONE.live);
    expect(FUNDS_LABEL.demo).toBe('DEMO');
    expect(FUNDS_LABEL.live).toBe('LIVE');
  });
});
