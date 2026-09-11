import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_TYPE_SUFFIXES,
  stripKnownSuffix,
  suffixForAccountType,
  SymbolSuffixPolicy,
} from './symbol-suffix';

describe('suffixForAccountType', () => {
  it('maps the verified account types', () => {
    // Values verified against DEFAULT_ACCOUNT_TYPE_SUFFIXES in
    // broker-sample/src/AccountInitializer.class.ts.
    expect(suffixForAccountType(57)).toBe('.'); // ECN
    expect(suffixForAccountType(58)).toBe('!'); // Standard
    expect(suffixForAccountType(59)).toBe(''); // ECNPRO — no suffix
    expect(suffixForAccountType(60)).toBe('#'); // Social
  });

  it('returns null for an unknown type rather than guessing', () => {
    // Guessing would send the wrong symbol name to MT5.
    expect(suffixForAccountType(11)).toBeNull();
    expect(suffixForAccountType(999)).toBeNull();
    expect(suffixForAccountType(null)).toBeNull();
  });

  it('covers every type id in the supported set', () => {
    for (const id of Object.keys(ACCOUNT_TYPE_SUFFIXES).map(Number)) {
      expect(suffixForAccountType(id)).not.toBeNull();
    }
  });
});

describe('SymbolSuffixPolicy.toGateway', () => {
  const ecn = new SymbolSuffixPolicy('.');

  it('appends the suffix to symbols that require one', () => {
    expect(ecn.toGateway('EURUSD')).toBe('EURUSD.');
    expect(ecn.toGateway('XAUUSD')).toBe('XAUUSD.');
  });

  it('leaves symbols that do not require a suffix alone', () => {
    expect(ecn.toGateway('AAPL')).toBe('AAPL');
  });

  it('is idempotent', () => {
    expect(ecn.toGateway('EURUSD.')).toBe('EURUSD.');
  });

  it('strips an exchange prefix', () => {
    expect(ecn.toGateway('TradePlatform:EURUSD')).toBe('EURUSD.');
  });

  it('appends nothing when the account type has no suffix', () => {
    const ecnPro = new SymbolSuffixPolicy('');
    expect(ecnPro.toGateway('EURUSD')).toBe('EURUSD');
  });
});

describe('stripKnownSuffix', () => {
  it('removes each known delimiter', () => {
    expect(stripKnownSuffix('EURUSD.')).toBe('EURUSD');
    expect(stripKnownSuffix('EURUSD!')).toBe('EURUSD');
    expect(stripKnownSuffix('EURUSD#')).toBe('EURUSD');
  });

  it('leaves an unsuffixed symbol alone', () => {
    expect(stripKnownSuffix('EURUSD')).toBe('EURUSD');
  });

  it('only strips when the stem is a symbol that takes a suffix', () => {
    // The original implementation split on the first delimiter unconditionally,
    // which would mangle a symbol whose real name ends in one.
    expect(stripKnownSuffix('SOMETHING.')).toBe('SOMETHING.');
  });

  it('round-trips with toGateway', () => {
    const policy = new SymbolSuffixPolicy('!');
    for (const symbol of ['EURUSD', 'XAUUSD', 'SPXUSD', 'GBPJPY']) {
      expect(policy.toDisplay(policy.toGateway(symbol))).toBe(symbol);
    }
  });
});
