import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DEFAULT_BRAND, type BrandConfig } from '@/app/config/brand';
import { CreateAccountButton } from './CreateAccountButton';

// The brand arrives over the network at runtime; stubbing the hook keeps this
// about the button rather than about branding.
// The built-in brand has no portal, so the button's happy path needs a brand
// that says where accounts are opened — as a deployment's brand document would.
const BROKER_BRAND: BrandConfig = {
  ...DEFAULT_BRAND,
  createAccountUrl: 'https://portal.broker.test/accounts',
};
let brand: BrandConfig = BROKER_BRAND;
vi.mock('@/app/providers/brand-provider', () => ({ useBrand: () => brand }));

/**
 * Every screen that says "no account" was a dead end: the trader was told what
 * they do not have and given nothing to do about it. That is the first screen a
 * brand-new visitor reaches, and where an expired session drops an existing one.
 */

afterEach(() => {
  vi.restoreAllMocks();
  brand = BROKER_BRAND;
});

function renderWith(config: BrandConfig = BROKER_BRAND) {
  brand = config;
  return render(<CreateAccountButton />);
}

describe('the Create Account button', () => {
  it('offers a way out of a no-account screen', () => {
    renderWith();
    expect(screen.getByRole('button', { name: 'Create Account' })).toBeTruthy();
  });

  it('opens the broker in a new tab, severed from the terminal', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderWith();
    screen.getByRole('button', { name: 'Create Account' }).click();

    // `noopener` matters beyond convention here: without it the opened page can
    // reach back through `window.opener` into a signed-in trading terminal.
    expect(open).toHaveBeenCalledWith(
      BROKER_BRAND.createAccountUrl,
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('renders nothing when the broker has not said where accounts are opened', () => {
    // A missing URL yields no button rather than one pointing somewhere
    // invented — a wrong destination on this button sends real people to the
    // wrong place to hand over their identity documents.
    const { container } = renderWith(DEFAULT_BRAND);
    expect(container.textContent).toBe('');
  });

  it('refuses a non-http destination from a brand config', async () => {
    const { brandConfigSchema } = await import('@/app/config/brand');
    const parsed = brandConfigSchema.safeParse({
      ...DEFAULT_BRAND,
      createAccountUrl: 'javascript:alert(1)',
    });
    expect(parsed.success).toBe(false);
  });
});
