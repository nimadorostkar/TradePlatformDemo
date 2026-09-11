import { useCallback, useState, type FormEvent } from 'react';
import { Button, Field, Input } from '@/components/ui/primitives';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { cn } from '@/components/ui/cn';
import { useBrand } from '@/app/providers/brand-provider';
import { useServices } from '@/app/providers/services';
import { TradingError } from '@/domain/common/errors';
import { useSessionStore } from '@/stores/session-store';

/**
 * Sign-in.
 *
 * Uses the verified CRM flow: crmlogin → JWT exchange.
 *
 * "Keep me signed in" never persists a token in browser storage — that is
 * exactly the risk the in-memory token store exists to avoid. It opts into the
 * gateway's HttpOnly restore cookies (SESSION_RESTORE_TTL) instead, and rides
 * along to the CRM so the CRM token those cookies carry lives as long as the
 * cookies do. Unchecked, every one of them is browser-session-only.
 */
export function SignInScreen() {
  const brand = useBrand();
  const services = useServices();
  const setStatus = useSessionStore((s) => s.setStatus);
  const setUsername = useSessionStore((s) => s.setUsername);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  // Registration lives on the same screen: a new visitor creates a demo
  // account (user + funded account in the CRM's user store) and is signed in
  // with it immediately.
  const [mode, setMode] = useState<'sign-in' | 'register'>('sign-in');
  // Off by default (MED-02): a 30-day session is an opt-in, not a surprise.
  const [remember, setRemember] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (submitting) return;

      setSubmitting(true);
      setError(null);

      const trimmedEmail = email.trim();
      try {
        if (mode === 'register') {
          await services.auth.register({ email: trimmedEmail, password, name: name.trim() });
        }
        setStatus('signing-in');
        await services.auth.signIn(trimmedEmail, password, { remember });
        setUsername(trimmedEmail);
        setStatus('signed-in');
      } catch (caught) {
        const tradingError = TradingError.from(caught);
        setError(tradingError.message);
        setStatus('signed-out', tradingError.message);
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, services, mode, email, password, name, remember, setStatus, setUsername],
  );

  return (
    <div className="flex h-full items-center justify-center bg-[var(--background-primary)] p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          {/* The full lockup (wordmark + tagline). It already spells the
              platform name, so the heading is only shown when the asset
              could not load. */}
          <BrandLogo
            variant="full"
            className="mx-auto mb-3 h-11 w-auto"
            onFail={() => setLogoFailed(true)}
          />
          <h1 className={cn('text-lg font-semibold', !logoFailed && 'sr-only')}>
            {brand.platformName}
          </h1>
          <p className="mt-1 text-xs text-text-muted">
            {mode === 'register'
              ? `Create your ${brand.brokerName} demo account`
              : `Sign in with your ${brand.brokerName} account`}
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-3 rounded-lg border border-[var(--border-default)] bg-[var(--background-secondary)] p-4"
        >
          {mode === 'register' && (
            <Field label="Name" htmlFor="signin-name">
              <Input
                id="signin-name"
                type="text"
                autoComplete="name"
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-9 text-sm max-lg:h-11"
              />
            </Field>
          )}

          <Field label="Email" htmlFor="signin-email">
            <Input
              id="signin-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-9 text-sm max-lg:h-11"
            />
          </Field>

          <Field
            label="Password"
            htmlFor="signin-password"
            hint={mode === 'register' ? 'At least 8 characters.' : undefined}
          >
            <Input
              id="signin-password"
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
              minLength={mode === 'register' ? 8 : undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-9 text-sm max-lg:h-11"
            />
          </Field>

          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="h-4 w-4"
            />
            Keep me signed in for 30 days
          </label>

          {error && (
            <p role="alert" className="text-xs text-[var(--negative)]">
              {error}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={submitting}
            className="w-full"
            disabled={email.trim() === '' || password === ''}
          >
            {mode === 'register' ? 'Create demo account' : 'Sign in'}
          </Button>

          {/* Registration is self-service against the CRM's user store: a new
              user gets one funded demo account and is signed in with it. */}
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'register' ? 'sign-in' : 'register');
              setError(null);
            }}
            className="block w-full text-center text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
          >
            {mode === 'register'
              ? 'Already have an account? Sign in'
              : 'New here? Create a demo account'}
          </button>

          {/* HGH-01: a login form with no links is a dead end — a client who
              has forgotten their password had no route except a support
              ticket. The reset lives in the CRM, same as the credentials. */}
          {brand.forgotPasswordUrl && (
            <a
              href={brand.forgotPasswordUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-center text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
            >
              Forgot password?
            </a>
          )}
        </form>

        {(brand.signUpUrl || brand.supportUrl) && (
          <nav
            aria-label="Account help"
            className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1"
          >
            {brand.signUpUrl && (
              <a
                href={brand.signUpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
              >
                Open an account
              </a>
            )}
            {brand.supportUrl && (
              <a
                href={brand.supportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
              >
                Contact support
              </a>
            )}
          </nav>
        )}

        {brand.legalLinks.length > 0 && (
          <nav className="mt-4 flex flex-wrap justify-center gap-3">
            {brand.legalLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-2xs text-text-muted hover:text-text-secondary"
              >
                {link.label}
              </a>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
