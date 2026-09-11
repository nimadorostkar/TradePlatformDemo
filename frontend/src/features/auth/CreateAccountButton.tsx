import { Button } from '@/components/ui/primitives';
import { useBrand } from '@/app/providers/brand-provider';

/**
 * The way out for someone the terminal cannot let in.
 *
 * Every screen that says "no account" is a dead end otherwise: the trader is
 * told what they do not have and given nothing to do about it. That is the
 * state a brand-new user reaches first, and the one an expired session drops an
 * existing user into.
 *
 * Renders nothing when the brand supplies no URL — a broker that has not said
 * where accounts are opened gets no button, rather than one pointing somewhere
 * invented. Opens in a new tab so a signed-in session is never navigated away
 * from, and always with `noopener` so the opened page cannot reach back into
 * the terminal through `window.opener`.
 */
export function CreateAccountButton({
  variant = 'secondary',
  size = 'md',
  className,
}: {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}) {
  const brand = useBrand();
  if (!brand.createAccountUrl) return null;

  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={() => window.open(brand.createAccountUrl, '_blank', 'noopener,noreferrer')}
    >
      Create Account
    </Button>
  );
}
