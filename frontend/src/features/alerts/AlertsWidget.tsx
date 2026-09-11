import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Trash2 } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
} from '@/components/ui/primitives';
import { formatBrokerTime } from '@/domain/common/broker-time';
import { useBrokerOffsetSeconds } from '@/app/providers/use-broker-clock';
import { reportError, useServices } from '@/app/providers/services';
import { toDecimalString } from '@/domain/common/decimal';
import { TradingError } from '@/domain/common/errors';
import { useQuote } from '@/stores/quote-store';
import { useSessionStore } from '@/stores/session-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { useSymbolMetadata } from '@/features/order-ticket/useSymbolMetadata';
import { FALLBACK_DIGITS, useSymbolDigits } from '@/features/watchlist/useSymbolDigits';
import { SymbolLogo } from '@/features/watchlist/SymbolLogo';

/**
 * Price alerts.
 *
 * Persisted and evaluated SERVER-SIDE, so an alert keeps working after the tab
 * closes. That is the whole reason this panel exists now and did not before —
 * an alert that only lives in a browser tab is worse than no alert, because a
 * trader believes it is watching for them.
 */
export default function AlertsWidget() {
  const brokerOffsetSeconds = useBrokerOffsetSeconds();
  const services = useServices();
  const queryClient = useQueryClient();
  const login = useSessionStore((s) => s.activeLogin);
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const displaySymbol = useWorkspace((s) => s.workspace.activeSymbol);
  const { symbol } = useSymbolMetadata(displaySymbol);
  const quote = useQuote(suffixPolicy.toGateway(displaySymbol));

  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The precision of the symbol the FORM is aimed at — the ticket above the
  // list, which always concerns the active symbol.
  const digits = symbol?.digits ?? 5;
  const queryKey = useMemo(() => ['alerts', login, suffixPolicy.suffix], [login, suffixPolicy]);

  const query = useQuery({
    queryKey,
    enabled: login !== null,
    refetchInterval: 15_000,
    queryFn: ({ signal }) => services.features.listAlerts(login!, suffixPolicy, signal),
  });

  const invalidate = useCallback(
    () => void queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey],
  );

  const create = useMutation({
    mutationFn: async (condition: 'above' | 'below') => {
      const parsed = toDecimalString(price);
      if (parsed === null || Number(parsed) <= 0) throw new Error('Enter a valid price.');
      await services.features.createAlert({
        login: login!,
        gatewaySymbol: suffixPolicy.toGateway(displaySymbol),
        condition,
        price: parsed,
        note: note.trim(),
      });
    },
    onSuccess: () => {
      setPrice('');
      setNote('');
      setError(null);
      invalidate();
    },
    onError: (caught) => {
      const tradingError = TradingError.from(caught);
      setError(tradingError.message);
      reportError('alerts', tradingError);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => services.features.deleteAlert(login!, id),
    onSuccess: invalidate,
    onError: (caught) => reportError('alerts', TradingError.from(caught)),
  });

  const alerts = useMemo(() => query.data ?? [], [query.data]);

  // Every alert is priced in ITS OWN instrument's precision.
  //
  // The list used the active symbol's digits for every row, so with gold
  // selected a EURUSD alert set at 1.10125 was displayed as "1.10" — not a
  // rounding nicety but a different number from the one the trader set, on the
  // panel whose entire job is to state a level (2026-08-26).
  //
  // Above the early returns because these are HOOKS: below them they run only
  // on some renders, which is a crash rather than a bug.
  const alertSymbols = useMemo(
    () => [...new Set(alerts.map((alert) => alert.displaySymbol))],
    [alerts],
  );
  const digitsBySymbol = useSymbolDigits(alertSymbols);
  const digitsFor = (displaySymbol: string) =>
    digitsBySymbol.get(displaySymbol) ?? symbol?.digits ?? FALLBACK_DIGITS;

  if (!login) {
    return <EmptyState title="No account selected" description="Choose a trading account." />;
  }
  if (query.isLoading) return <LoadingState label="Loading alerts…" />;
  if (query.isError) {
    return <ErrorState title="Alerts unavailable" onRetry={() => void query.refetch()} />;
  }

  // The market price decides which direction a level implies, so the two
  // buttons are labelled with what will actually happen.
  const reference = quote ? Number(quote.last) : null;
  const typed = Number(price);
  const impliedAbove = reference !== null && Number.isFinite(typed) ? typed > reference : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-[var(--border-default)] p-2">
        <div className="flex items-center gap-2">
          <SymbolLogo symbol={displaySymbol} size={16} />
          <span className="text-xs font-semibold">{displaySymbol}</span>
          {quote ? (
            <span className="tabular text-2xs text-text-muted">
              now {Number(quote.last).toFixed(digits)}
            </span>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Price" htmlFor="alert-price">
            <Input
              id="alert-price"
              inputMode="decimal"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              placeholder={quote ? Number(quote.last).toFixed(digits) : ''}
            />
          </Field>
          <Field label="Note (optional)" htmlFor="alert-note">
            <Input
              id="alert-note"
              value={note}
              maxLength={120}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Why this level?"
            />
          </Field>
        </div>

        <div className="flex gap-1">
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            disabled={create.isPending || price.trim() === ''}
            onClick={() => create.mutate('above')}
          >
            Alert above
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            disabled={create.isPending || price.trim() === ''}
            onClick={() => create.mutate('below')}
          >
            Alert below
          </Button>
        </div>

        {impliedAbove !== null && price.trim() !== '' && (
          <p className="text-2xs text-text-muted">
            {impliedAbove
              ? 'That level is above the current price — "Alert above" will fire on a rise.'
              : 'That level is below the current price — "Alert below" will fire on a fall.'}
          </p>
        )}

        {error && (
          <p role="alert" className="text-2xs text-[var(--negative)]">
            {error}
          </p>
        )}

        <p className="text-2xs text-text-muted">
          Alerts are stored on the trading server and keep working after you close this tab.
        </p>
      </div>

      {alerts.length === 0 ? (
        <EmptyState
          title="No alerts"
          description="Set a level above to be notified when the market reaches it."
          icon={Bell}
        />
      ) : (
        <ul className="widget-scroll min-h-0 flex-1 divide-y divide-[var(--border-default)]">
          {alerts.map((alert) => (
            <li key={alert.id} className="group flex items-center gap-2 px-2 py-1.5 text-2xs">
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  alert.status === 'triggered' ? 'bg-[var(--warning)]' : 'bg-[var(--positive)]',
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="flex items-center gap-1.5 font-medium">
                    <SymbolLogo symbol={alert.displaySymbol} size={13} />
                    {alert.displaySymbol}
                  </span>
                  <span className="text-text-secondary">
                    {alert.condition === 'above' ? '≥' : '≤'}{' '}
                    <span className="tabular">
                      {Number(alert.price).toFixed(digitsFor(alert.displaySymbol))}
                    </span>
                  </span>
                  <Badge tone={alert.status === 'triggered' ? 'warning' : 'positive'}>
                    {alert.status === 'triggered' ? 'Triggered' : 'Active'}
                  </Badge>
                </div>
                {alert.note ? <p className="text-text-muted">{alert.note}</p> : null}
                {alert.status === 'triggered' && alert.triggeredAt ? (
                  <p className="text-text-muted">
                    {formatBrokerTime(alert.triggeredAt, brokerOffsetSeconds)}
                    {/* The crossing quote, not the level — it shows how far
                        past the level the market actually went. */}
                    {alert.triggeredPrice
                      ? ` at ${Number(alert.triggeredPrice).toFixed(digitsFor(alert.displaySymbol))}`
                      : ''}
                  </p>
                ) : null}
              </div>
              {/* Always rendered at partial opacity rather than hidden until
                  hover: a touch device has no hover state at all, so a
                  hover-only control is simply unreachable there. */}
              <button
                aria-label={`Delete alert on ${alert.displaySymbol}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(alert.id)}
                className="hit-target shrink-0 justify-center rounded text-text-muted opacity-60 transition-opacity hover:text-[var(--negative)] focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="h-2.5 w-2.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
