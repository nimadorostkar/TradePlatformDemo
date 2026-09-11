import { describe, expect, it } from 'vitest';
import {
  isInsufficientFunds,
  isSuccessRetcode,
  isUnknownRetcode,
  parseRetcode,
  tradeErrorFromRetcode,
} from './errors';

/**
 * MT5 sends `"<code> <text>"`, not a bare number — verified against the shipped
 * gateway, whose own `PlaceOrderAnswer.ResultRetcode` carries values like
 * `"10009 Done"` and `"10019 No money"`.
 *
 * Every classification in the app keys off the code, so the split has to happen
 * before any lookup. It did not, and the blast radius was wide: no retcode was
 * ever recognised as a success, no rejection got its readable text, and the
 * insufficient-funds CTA — keyed on `mt5.10019` — could never fire.
 */

describe('parseRetcode', () => {
  it('splits the code from MT5’s text', () => {
    expect(parseRetcode('10009 Done')).toEqual({ code: '10009', text: 'Done' });
    expect(parseRetcode('10019 No money')).toEqual({ code: '10019', text: 'No money' });
  });

  it('handles a bare code and surrounding whitespace', () => {
    expect(parseRetcode('10009')).toEqual({ code: '10009', text: '' });
    expect(parseRetcode('  10006  Reject ')).toEqual({ code: '10006', text: 'Reject' });
  });

  it('does not invent a code it was not given', () => {
    expect(parseRetcode('')).toEqual({ code: '', text: '' });
    expect(parseRetcode(null)).toEqual({ code: '', text: '' });
    expect(parseRetcode('garbage')).toEqual({ code: 'garbage', text: '' });
  });
});

describe('retcode classification', () => {
  it('recognises the three acceptance codes in wire format', () => {
    expect(isSuccessRetcode('10008 Placed')).toBe(true);
    expect(isSuccessRetcode('10009 Done')).toBe(true);
    expect(isSuccessRetcode('10010 Done partially')).toBe(true);
  });

  it('does not treat a rejection as a success', () => {
    expect(isSuccessRetcode('10019 No money')).toBe(false);
    expect(isSuccessRetcode('10006 Reject')).toBe(false);
    expect(isSuccessRetcode('')).toBe(false);
  });

  it('separates an MT5 timeout from a refusal', () => {
    // 10012 means MT5 never decided — the order may still be live.
    expect(isUnknownRetcode('10012 Timeout')).toBe(true);
    expect(isUnknownRetcode('10006 Reject')).toBe(false);
  });
});

describe('tradeErrorFromRetcode', () => {
  it('keeps the code stable and readable in wire format', () => {
    const error = tradeErrorFromRetcode('10019 No money');
    expect(error.code).toBe('mt5.10019');
    expect(error.message).toMatch(/not enough money/i);
    expect(error.retryable).toBe(false);
  });

  it('lets the insufficient-funds CTA fire on a real rejection', () => {
    expect(isInsufficientFunds(tradeErrorFromRetcode('10019 No money'))).toBe(true);
    expect(isInsufficientFunds(tradeErrorFromRetcode('10018 Market closed'))).toBe(false);
  });

  it('falls back to MT5’s own words when there is no server comment', () => {
    expect(tradeErrorFromRetcode('19999 Something new').detail).toBe('Something new');
    expect(tradeErrorFromRetcode('19999 Something new', 'server said this').detail).toBe(
      'server said this',
    );
  });

  it('still shows an unmapped code rather than inventing friendly text', () => {
    expect(tradeErrorFromRetcode('19999 Unheard of').message).toContain('19999');
  });
});
