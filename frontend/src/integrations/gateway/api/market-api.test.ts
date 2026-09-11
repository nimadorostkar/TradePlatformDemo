import { describe, expect, it } from 'vitest';
import { maskFromSearchInput } from './market-api';

describe('maskFromSearchInput', () => {
  it('wraps plain text so MT5 matches it as a substring', () => {
    expect(maskFromSearchInput('USD')).toBe('*USD*');
    expect(maskFromSearchInput('xau')).toBe('*XAU*');
    expect(maskFromSearchInput('  eurusd ')).toBe('*EURUSD*');
  });

  it('leaves the default-list sentinels alone', () => {
    expect(maskFromSearchInput('')).toBe('');
    expect(maskFromSearchInput('  ')).toBe('');
    expect(maskFromSearchInput('*')).toBe('*');
  });

  it('passes explicit MT5 patterns through untouched', () => {
    expect(maskFromSearchInput('*USD')).toBe('*USD');
    expect(maskFromSearchInput('EUR*,GBP*')).toBe('EUR*,GBP*');
    expect(maskFromSearchInput('*,!EURUSD')).toBe('*,!EURUSD');
  });
});
