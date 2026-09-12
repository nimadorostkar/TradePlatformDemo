import { describe, expect, it } from 'vitest';
import { ROUTES, isClientAreaPath, resolveRoute, terminalUrl } from './router';

describe('client-area routing', () => {
  it('owns /pa and everything under it, and nothing else', () => {
    expect(isClientAreaPath('/pa')).toBe(true);
    expect(isClientAreaPath('/pa/')).toBe(true);
    expect(isClientAreaPath('/pa/payments/deposit')).toBe(true);
    expect(isClientAreaPath('/')).toBe(false);
    expect(isClientAreaPath('/party')).toBe(false);
  });

  it('resolves known routes exactly and lands unknown ones on Accounts', () => {
    expect(resolveRoute('/pa/payments/deposit')).toBe(ROUTES.deposit);
    expect(resolveRoute('/pa/payments/deposit/')).toBe(ROUTES.deposit);
    expect(resolveRoute('/pa')).toBe(ROUTES.accounts);
    expect(resolveRoute('/pa/nowhere')).toBe(ROUTES.accounts);
  });

  it('opens the terminal on a chosen account', () => {
    expect(terminalUrl('1010')).toBe('/?account=1010');
    expect(terminalUrl(null)).toBe('/');
  });
});
