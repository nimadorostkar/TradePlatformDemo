import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, ErrorState, Field, Input, LoadingState } from '@/components/ui/primitives';
import { COUNTRIES } from '@/features/auth/countries';
import type { ClientUser } from '../api';
import { formatDateTime, paKeys, useClientAreaApi, useMe } from '../hooks';
import { Card, Notice, PageHeader, SectionTitle, Select } from '../components/ui';
import { errorMessage } from '../components/format';

const LANGUAGES = [
  ['en', 'English'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['pt', 'Português'],
  ['ar', 'العربية'],
  ['fa', 'فارسی'],
  ['tr', 'Türkçe'],
  ['zh', '中文'],
  ['ja', '日本語'],
] as const;

export default function SettingsPage() {
  const me = useMe();
  if (me.isPending) return <LoadingState label="Loading your profile…" />;
  if (me.isError || !me.data) {
    return (
      <ErrorState
        title="Could not load your profile"
        description={me.isError ? errorMessage(me.error) : undefined}
        onRetry={() => void me.refetch()}
      />
    );
  }
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <ProfileForm user={me.data} />
          <PasswordForm />
        </div>
        <Card className="h-fit p-5">
          <SectionTitle>Account</SectionTitle>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs text-text-secondary">Email</dt>
              <dd className="font-medium">{me.data.email}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-secondary">Client since</dt>
              <dd className="font-medium">{formatDateTime(me.data.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-secondary">Verification level</dt>
              <dd className="font-medium">{me.data.verificationLevel} of 3</dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}

function ProfileForm({ user }: { user: ClientUser }) {
  const api = useClientAreaApi();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: user.name,
    phone: user.phone,
    country: user.country,
    city: user.city,
    language: user.language || 'en',
    timezone: user.timezone || 'UTC',
  });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setForm({
      name: user.name,
      phone: user.phone,
      country: user.country,
      city: user.city,
      language: user.language || 'en',
      timezone: user.timezone || 'UTC',
    });
  }, [user]);

  const save = useMutation({
    mutationFn: () => api.updateProfile(form),
    onSuccess: (updated) => {
      queryClient.setQueryData(paKeys.me, updated);
      void queryClient.invalidateQueries({ queryKey: paKeys.verification });
      setSaved(true);
    },
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: event.target.value }));
  };
  const zones = timeZones(form.timezone);

  return (
    <Card
      as="form"
      className="p-5"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <SectionTitle>Personal details</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" htmlFor="pf-name">
          <Input
            id="pf-name"
            value={form.name}
            onChange={set('name')}
            className="h-9 text-sm"
            maxLength={80}
            required
          />
        </Field>
        <Field label="Phone" htmlFor="pf-phone" hint="With country code, e.g. +44 20 7946 0958">
          <Input
            id="pf-phone"
            type="tel"
            value={form.phone}
            onChange={set('phone')}
            className="h-9 text-sm"
            required
          />
        </Field>
        <Field label="Country" htmlFor="pf-country">
          <Select id="pf-country" value={form.country} onChange={set('country')} required>
            <option value="">—</option>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="City" htmlFor="pf-city">
          <Input
            id="pf-city"
            value={form.city}
            onChange={set('city')}
            className="h-9 text-sm"
            maxLength={80}
            required
          />
        </Field>
        <Field label="Language" htmlFor="pf-language">
          <Select id="pf-language" value={form.language} onChange={set('language')}>
            {LANGUAGES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Time zone" htmlFor="pf-timezone">
          <Select id="pf-timezone" value={form.timezone} onChange={set('timezone')}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {save.isError && (
        <Notice tone="error" className="mt-4">
          {errorMessage(save.error)}
        </Notice>
      )}
      {saved && (
        <Notice tone="success" className="mt-4">
          Profile saved.
        </Notice>
      )}
      <div className="mt-5">
        <Button type="submit" variant="primary" size="md" loading={save.isPending}>
          Save changes
        </Button>
      </div>
    </Card>
  );
}

function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones =
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
        'timeZone',
      ) ?? [];
  } catch {
    zones = [];
  }
  if (zones.length === 0)
    zones = [
      'UTC',
      'Europe/London',
      'Europe/Berlin',
      'Asia/Dubai',
      'Asia/Tehran',
      'Asia/Singapore',
      'America/New_York',
    ];
  if (current && !zones.includes(current)) zones = [current, ...zones];
  return zones;
}

function PasswordForm() {
  const api = useClientAreaApi();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    },
  });
  const mismatch = confirm !== '' && confirm !== next;
  return (
    <Card
      as="form"
      className="p-5"
      onSubmit={(event) => {
        event.preventDefault();
        setDone(false);
        if (!mismatch) change.mutate();
      }}
    >
      <SectionTitle>Change password</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Current password" htmlFor="pw-current">
          <Input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="h-9 text-sm"
            required
          />
        </Field>
        <Field label="New password" htmlFor="pw-new" hint="At least 8 characters.">
          <Input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="h-9 text-sm"
            required
            minLength={8}
          />
        </Field>
        <Field
          label="Repeat new password"
          htmlFor="pw-confirm"
          error={mismatch ? 'The passwords do not match.' : null}
        >
          <Input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="h-9 text-sm"
            required
          />
        </Field>
      </div>
      {change.isError && (
        <Notice tone="error" className="mt-4">
          {errorMessage(change.error)}
        </Notice>
      )}
      {done && (
        <Notice tone="success" className="mt-4">
          Password changed. Other sessions have been signed out.
        </Notice>
      )}
      <div className="mt-5">
        <Button type="submit" variant="primary" size="md" loading={change.isPending}>
          Change password
        </Button>
      </div>
    </Card>
  );
}
