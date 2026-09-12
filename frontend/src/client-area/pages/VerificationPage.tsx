import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, CircleUser, Clock } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { Button, ErrorState, Field, Input, LoadingState } from '@/components/ui/primitives';
import { COUNTRIES } from '@/features/auth/countries';
import type { VerificationStep } from '../api';
import { formatMoney, paKeys, useClientAreaApi, useVerification } from '../hooks';
import { ROUTES, useLinkClick } from '../router';
import { Card, Notice, PageHeader, SectionTitle, Select } from '../components/ui';
import { errorMessage } from '../components/format';

export default function VerificationPage() {
  const verification = useVerification();
  const [open, setOpen] = useState<string | null>(null);

  if (verification.isPending) return <LoadingState label="Loading verification…" />;
  if (verification.isError || !verification.data) {
    return (
      <ErrorState
        title="Could not load verification"
        description={verification.isError ? errorMessage(verification.error) : undefined}
        onRetry={() => void verification.refetch()}
      />
    );
  }
  const { user, verification: v } = verification.data;
  const current = v.steps.find((s) => s.status !== 'verified')?.id ?? null;
  const expanded = open ?? current;

  return (
    <>
      <PageHeader title="Verification" />
      <SectionTitle>Account</SectionTitle>
      <div className="mb-8 grid gap-4 md:grid-cols-2">
        <Card className="flex items-center gap-4 p-5">
          <span
            className={cn(
              'flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-4',
              v.verified
                ? 'border-[var(--positive)] text-[var(--positive)]'
                : 'border-[var(--border-strong)] text-text-secondary',
            )}
          >
            <CircleUser className="h-6 w-6" aria-hidden />
          </span>
          <div>
            <div className="text-xs text-text-secondary">Status</div>
            <div
              className={cn(
                'text-2xl font-semibold',
                v.verified ? 'text-[var(--positive)]' : 'text-[var(--negative)]',
              )}
            >
              {v.verified ? 'Verified' : 'Not verified'}
            </div>
            <div className="text-xs text-text-muted">
              {v.stepsComplete}/{v.stepsTotal} steps complete
            </div>
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-xs text-text-secondary">Deposit limit</div>
          <div className="text-2xl font-semibold tabular-nums">
            {v.depositLimit === null ? 'Unlimited' : formatMoney(v.depositLimit)}
          </div>
          <div className="text-xs text-text-muted">
            {v.verified
              ? 'Every limit is unlocked.'
              : v.depositLimit === 0
                ? 'Verify your account to unlock limits'
                : `${formatMoney(v.depositRemaining ?? 0)} remaining at this level`}
          </div>
        </Card>
      </div>

      <SectionTitle>Verification steps</SectionTitle>
      <Card className="divide-y divide-[var(--border-default)]">
        {v.steps.map((step, index) => {
          const isOpen = expanded === step.id;
          const locked =
            step.status !== 'verified' &&
            v.steps.slice(0, index).some((s) => s.status !== 'verified');
          return (
            <div key={step.id}>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? '' : step.id)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-4 px-5 py-4 text-left"
              >
                <StepBadge index={index + 1} status={step.status} locked={locked} />
                <span
                  className={cn(
                    'flex-1 text-base',
                    locked ? 'text-text-muted' : 'text-text-primary',
                  )}
                >
                  {step.title}
                </span>
                <StatusText status={step.status} />
                <ChevronDown
                  className={cn(
                    'h-4 w-4 text-text-secondary transition-transform',
                    isOpen && 'rotate-180',
                  )}
                  aria-hidden
                />
              </button>
              {isOpen && (
                <div className="px-5 pb-6 pl-[4.25rem]">
                  {step.id === 'profile' && (
                    <ProfileStep step={step} email={user.email} phone={user.phone} />
                  )}
                  {step.id === 'identity' && <IdentityStep step={step} locked={locked} />}
                  {step.id === 'address' && (
                    <AddressStep step={step} locked={locked} defaults={user} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </>
  );
}

function StepBadge({ index, status, locked }: { index: number; status: string; locked: boolean }) {
  return (
    <span
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        status === 'verified'
          ? 'bg-[var(--positive)] text-white'
          : status === 'pending'
            ? 'bg-[var(--warning)] text-white'
            : locked
              ? 'bg-[var(--surface-raised)] text-text-muted'
              : 'bg-[var(--brand-primary)] text-[var(--brand-primary-contrast)]',
      )}
    >
      {status === 'verified' ? (
        <Check className="h-4 w-4" />
      ) : status === 'pending' ? (
        <Clock className="h-4 w-4" />
      ) : (
        index
      )}
    </span>
  );
}

function StatusText({ status }: { status: string }) {
  if (status === 'verified')
    return <span className="text-xs font-medium text-[var(--positive)]">Verified</span>;
  if (status === 'pending')
    return <span className="text-xs font-medium text-[var(--warning)]">Under review</span>;
  return null;
}

function Unlocks({ items }: { items: string[] }) {
  return (
    <div className="mt-4">
      <div className="text-xs text-text-secondary">Features and limits</div>
      <ul className="mt-1 space-y-0.5 text-sm">
        {items.map((item) => (
          <li key={item} className="flex items-center gap-2">
            <span className="h-1 w-1 rounded-full bg-text-muted" aria-hidden />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProfileStep({
  step,
  email,
  phone,
}: {
  step: VerificationStep;
  email: string;
  phone: string;
}) {
  const goSettings = useLinkClick(ROUTES.settings);
  const missing = step.missing ?? [];
  const items = [
    { label: maskEmail(email), done: true },
    { label: phone ? phone : 'Phone number', done: !missing.includes('phone') },
    { label: 'Add profile information', done: !missing.some((m) => m !== 'phone') },
  ];
  return (
    <>
      <div className="text-xs text-text-secondary">Required to confirm</div>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {items.map((item) => (
          <li key={item.label} className="flex items-center gap-1.5">
            {item.done ? (
              <Check className="h-3.5 w-3.5 text-[var(--positive)]" aria-hidden />
            ) : (
              <span className="h-1 w-1 rounded-full bg-text-muted" aria-hidden />
            )}
            <span
              className={item.done ? 'text-text-secondary line-through decoration-transparent' : ''}
            >
              {item.label}
            </span>
          </li>
        ))}
      </ul>
      <Unlocks items={step.unlocks} />
      {step.status !== 'verified' && (
        <a
          href={ROUTES.settings}
          onClick={goSettings}
          className="mt-5 inline-flex h-11 items-center rounded bg-[var(--brand-primary)] px-5 text-sm font-medium text-[var(--brand-primary-contrast)] hover:brightness-110"
        >
          Complete now
        </a>
      )}
    </>
  );
}

function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  if (user.length <= 2) return `${user[0] ?? ''}***@${domain}`;
  return `${user[0]}****${user[user.length - 1]}@${domain}`;
}

function IdentityStep({ step, locked }: { step: VerificationStep; locked: boolean }) {
  const api = useClientAreaApi();
  const queryClient = useQueryClient();
  const [documentType, setDocumentType] = useState('passport');
  const [documentNumber, setDocumentNumber] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const submit = useMutation({
    mutationFn: () => api.submitIdentity({ documentType, documentNumber, dateOfBirth }),
    onSuccess: (data) => {
      queryClient.setQueryData(paKeys.verification, data);
      void queryClient.invalidateQueries({ queryKey: paKeys.me });
    },
  });

  if (step.status === 'verified' || step.status === 'pending') {
    const s = step.submitted ?? {};
    return (
      <>
        {step.status === 'pending' ? (
          <Notice tone="info">
            Your document is being reviewed. On this demo platform the review takes about half a
            minute; the page updates by itself.
          </Notice>
        ) : (
          <Notice tone="success">Your identity is verified.</Notice>
        )}
        <dl className="mt-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <Detail label="Document" value={docLabel(s.documentType)} />
          <Detail label="Number" value={s.documentNumber || '—'} />
          <Detail label="Date of birth" value={s.dateOfBirth || '—'} />
        </dl>
        <Unlocks items={step.unlocks} />
      </>
    );
  }
  if (locked) {
    return (
      <>
        <p className="text-sm text-text-secondary">Complete the previous step first.</p>
        <Unlocks items={step.unlocks} />
      </>
    );
  }
  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit.mutate();
      }}
      className="max-w-xl space-y-4"
    >
      <p className="text-sm text-text-secondary">
        Enter the details of a government-issued identity document. A real broker would ask for a
        photo of it; this demo checks the details and reviews them automatically.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Document type" htmlFor="id-type">
          <Select
            id="id-type"
            value={documentType}
            onChange={(e) => setDocumentType(e.target.value)}
          >
            <option value="passport">Passport</option>
            <option value="id_card">National ID card</option>
            <option value="driving_licence">Driving licence</option>
          </Select>
        </Field>
        <Field label="Document number" htmlFor="id-number">
          <Input
            id="id-number"
            value={documentNumber}
            onChange={(e) => setDocumentNumber(e.target.value)}
            className="h-9 text-sm"
            required
            minLength={4}
            maxLength={32}
          />
        </Field>
        <Field label="Date of birth" htmlFor="id-dob" hint="You must be at least 18.">
          <Input
            id="id-dob"
            type="date"
            value={dateOfBirth}
            onChange={(e) => setDateOfBirth(e.target.value)}
            className="h-9 text-sm"
            required
          />
        </Field>
      </div>
      {submit.isError && <Notice tone="error">{errorMessage(submit.error)}</Notice>}
      <Unlocks items={step.unlocks} />
      <Button type="submit" variant="primary" size="lg" loading={submit.isPending}>
        Submit for verification
      </Button>
    </form>
  );
}

function docLabel(type: string | undefined): string {
  switch (type) {
    case 'passport':
      return 'Passport';
    case 'id_card':
      return 'National ID card';
    case 'driving_licence':
      return 'Driving licence';
    default:
      return '—';
  }
}

function AddressStep({
  step,
  locked,
  defaults,
}: {
  step: VerificationStep;
  locked: boolean;
  defaults: { address: string; city: string; postalCode: string; country: string };
}) {
  const api = useClientAreaApi();
  const queryClient = useQueryClient();
  const [address, setAddress] = useState(defaults.address);
  const [city, setCity] = useState(defaults.city);
  const [postalCode, setPostalCode] = useState(defaults.postalCode);
  const [country, setCountry] = useState(defaults.country);
  const submit = useMutation({
    mutationFn: () => api.submitAddress({ address, city, postalCode, country }),
    onSuccess: (data) => {
      queryClient.setQueryData(paKeys.verification, data);
      void queryClient.invalidateQueries({ queryKey: paKeys.me });
    },
  });

  if (step.status === 'verified') {
    const s = step.submitted ?? {};
    return (
      <>
        <Notice tone="success">Your residential address is verified.</Notice>
        <dl className="mt-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Detail label="Address" value={s.address || '—'} />
          <Detail label="City" value={s.city || '—'} />
          <Detail label="Postal code" value={s.postalCode || '—'} />
          <Detail
            label="Country"
            value={COUNTRIES.find((c) => c.code === s.country)?.name ?? s.country ?? '—'}
          />
        </dl>
        <Unlocks items={step.unlocks} />
      </>
    );
  }
  if (locked) {
    return (
      <>
        <p className="text-sm text-text-secondary">Complete the previous steps first.</p>
        <Unlocks items={step.unlocks} />
      </>
    );
  }
  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit.mutate();
      }}
      className="max-w-xl space-y-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Street address" htmlFor="addr-line" className="sm:col-span-2">
          <Input
            id="addr-line"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="h-9 text-sm"
            required
            minLength={3}
            maxLength={160}
          />
        </Field>
        <Field label="City" htmlFor="addr-city">
          <Input
            id="addr-city"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className="h-9 text-sm"
            required
            maxLength={80}
          />
        </Field>
        <Field label="Postal code" htmlFor="addr-postal">
          <Input
            id="addr-postal"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            className="h-9 text-sm"
            required
          />
        </Field>
        <Field label="Country" htmlFor="addr-country">
          <Select
            id="addr-country"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            required
          >
            <option value="">—</option>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {submit.isError && <Notice tone="error">{errorMessage(submit.error)}</Notice>}
      <Unlocks items={step.unlocks} />
      <Button type="submit" variant="primary" size="lg" loading={submit.isPending}>
        Confirm address
      </Button>
    </form>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
