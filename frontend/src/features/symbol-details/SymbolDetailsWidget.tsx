import { Badge, LoadingState, Unavailable } from '@/components/ui/primitives';
import { cn } from '@/components/ui/cn';
import { useSessionSummary } from './useSessionSummary';
import { tickSize } from '@/domain/market/ladder';
import { useMarketState } from '@/features/order-ticket/useMarketState';
import { useQuote } from '@/stores/quote-store';
import { useSessionStore } from '@/stores/session-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { useSymbolMetadata } from '@/features/order-ticket/useSymbolMetadata';
import { SymbolLogo } from '@/features/watchlist/SymbolLogo';

/**
 * Symbol specification.
 *
 * Volume limits, contract size, tick size and tick value come from the RAW MT5
 * record, which the gateway only exposes via `source=mt5`. When that call fails
 * these fields are `Unavailable` — and the order ticket and risk calculator
 * degrade consistently, saying the same thing.
 */
export default function SymbolDetailsWidget() {
  const displaySymbol = useWorkspace((s) => s.workspace.activeSymbol);
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const { symbol, loading } = useSymbolMetadata(displaySymbol);
  const quote = useQuote(suffixPolicy.toGateway(displaySymbol));
  const { state: market, reopensIn } = useMarketState(symbol);

  if (loading) return <LoadingState label="Loading symbol details…" />;

  if (!symbol) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-text-muted">
        Symbol details are unavailable for {displaySymbol}.
      </div>
    );
  }

  const digits = symbol.digits;
  const spread =
    quote !== undefined ? (Number(quote.ask) - Number(quote.bid)) * 10 ** digits : null;

  return (
    <div className="widget-scroll h-full p-2">
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <SymbolLogo symbol={symbol.displayName} size={18} />
          <p className="text-sm font-semibold">{symbol.displayName}</p>
          {/* Derived from the instrument's own session, evaluated in ITS
              timezone. `unknown` is shown as such rather than guessed. */}
          {market === 'open' && <Badge tone="positive">Open</Badge>}
          {market === 'closed' && (
            <Badge tone="warning">Closed{reopensIn ? ` · ${reopensIn}` : ''}</Badge>
          )}
          {market === 'unknown' && <Badge tone="neutral">Hours unknown</Badge>}
        </div>
        <p className="text-2xs text-text-muted">{symbol.description}</p>
      </div>

      <SessionHeader displaySymbol={displaySymbol} digits={digits} />

      <dl className="space-y-1 text-2xs">
        <Row label="Type">{symbol.type || <Unavailable />}</Row>
        <Row label="Exchange">{symbol.exchange || <Unavailable />}</Row>
        <Row label="Bid">
          {quote ? (
            <span className="tabular">{Number(quote.bid).toFixed(digits)}</span>
          ) : (
            <Unavailable />
          )}
        </Row>
        <Row label="Ask">
          {quote ? (
            <span className="tabular">{Number(quote.ask).toFixed(digits)}</span>
          ) : (
            <Unavailable />
          )}
        </Row>
        <Row label="Spread">
          {spread !== null ? (
            <span className="tabular">{spread.toFixed(1)} points</span>
          ) : (
            <Unavailable />
          )}
        </Row>
        <Row label="Digits">
          <span className="tabular">{digits}</span>
        </Row>
        <Row label="Min volume">
          {symbol.volumeMin ? <span className="tabular">{symbol.volumeMin}</span> : <Unavailable />}
        </Row>
        <Row label="Max volume">
          {symbol.volumeMax ? <span className="tabular">{symbol.volumeMax}</span> : <Unavailable />}
        </Row>
        <Row label="Volume step">
          {symbol.volumeStep ? (
            <span className="tabular">{symbol.volumeStep}</span>
          ) : (
            <Unavailable />
          )}
        </Row>
        <Row label="Contract size">
          {symbol.contractSize ? (
            <span className="tabular">{symbol.contractSize}</span>
          ) : (
            <Unavailable />
          )}
        </Row>
        <Row label="Tick size">
          {/* MT5 reports TickSize as 0 to mean "not specified — use the point",
              and the domain model maps that live zero to null on purpose: a
              zero reaching TradingView's price math divides by zero and kills
              the order ticket. But the tick is not UNKNOWN — it is 10^-digits,
              which is what every consumer already falls back to. Showing "—"
              here said the trading server had withheld something it had
              actually stated in another field. */}
          {symbol.tickSize ? (
            <span className="tabular">{symbol.tickSize}</span>
          ) : (
            <span
              className="tabular"
              title="Not stated by the trading server; MT5 uses the point (10^-digits) when tick size is unset."
            >
              {tickSize(digits)}
            </span>
          )}
        </Row>
        <Row label="Tick value">
          {symbol.tickValue ? <span className="tabular">{symbol.tickValue}</span> : <Unavailable />}
        </Row>
        <Row label="Currency">{symbol.currencyCode || <Unavailable />}</Row>
        <Row label="Session">
          <span className="truncate" title={symbol.session}>
            {symbol.session || <Unavailable />}
          </span>
        </Row>
        <Row label="Timezone">{symbol.timezone}</Row>
      </dl>

      {/* Named, not "some". A trader cannot act on "some contract
          specifications" — and tick SIZE is not among them, since MT5's unset
          zero means the point rather than an absence. Tick value genuinely is
          missing, and it is the one position sizing needs: without the cash
          value of a tick there is no way to turn a risk in money into lots. */}
      {symbol.tickValue === null && (
        <p className="mt-2 rounded border border-[var(--border-default)] bg-[var(--background-tertiary)] p-1.5 text-2xs text-text-muted">
          This trading server does not report a tick value for {symbol.displayName}, so position
          sizing from a cash risk is unavailable. Every other specification here is the server’s
          own.
        </p>
      )}
    </div>
  );
}

/**
 * Where the price sits inside the day, drawn as a meter rather than a dot.
 *
 * A dot on a track encodes the position only by its x, which is the one channel
 * a 280px panel has least of and the one a glance reads worst. The track fills
 * from the low to the price and a marker under it points at the same spot: one
 * number said twice, so it survives both a narrow panel and a quick look.
 *
 * The fill is deliberately NOT the gain/loss colour. Distance up the day's
 * range and being up on the day are different facts, and a symbol down 2% while
 * trading near its high would have the second one stated wrongly by the first.
 *
 * `position` is null when the day has no width at all (`session-summary`
 * returns null rather than dividing by zero). A meter with no span has no
 * position to point at, so the bare track is drawn and nothing is claimed.
 */
export function DayRange({
  low,
  high,
  position,
}: {
  low: string;
  high: string;
  position: number | null;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-2xs">
        <span className="tabular">{low}</span>
        <span className="uppercase tracking-wider text-text-muted">Day’s range</span>
        <span className="tabular">{high}</span>
      </div>
      <div className="relative mt-1.5">
        <div
          className="h-1.5 overflow-hidden rounded-full bg-[var(--background-tertiary)]"
          role="img"
          aria-label={
            position === null
              ? `Day's range ${low} to ${high}`
              : `Day's range ${low} to ${high}, price ${Math.round(position)}% up the range`
          }
        >
          {position !== null ? (
            <span
              data-testid="day-range-fill"
              className="block h-full rounded-full bg-[var(--positive)]"
              style={{ width: `${position}%` }}
            />
          ) : null}
        </div>
        {position !== null ? (
          <span
            aria-hidden
            data-testid="day-range-marker"
            className="absolute top-full mt-0.5 h-0 w-0 -translate-x-1/2 border-x-4 border-b-4 border-x-transparent border-b-current text-text-muted"
            style={{ left: `${position}%` }}
          />
        ) : null}
      </div>
      {/* The marker hangs below the track, so the block owes it the room. */}
      <div className="h-1.5" />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-[var(--border-default)] pb-1">
      <dt className="shrink-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-text-primary">{children}</dd>
    </div>
  );
}

/**
 * The day's numbers: last price, move against the previous close, and where the
 * price sits in the session's range.
 *
 * All of it comes from the daily BAR. The quote carries no session data, which
 * is why the charting library's own Details widget renders 0.00 (0.00%) over a
 * range of a single point on this gateway — the panel was never broken, it was
 * never fed. Anything the bar does not support is left out rather than filled
 * with a zero that reads as "no movement".
 */
function SessionHeader({ displaySymbol, digits }: { displaySymbol: string; digits: number }) {
  const { summary, loading, unavailable } = useSessionSummary(displaySymbol);
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const quote = useQuote(suffixPolicy.toGateway(displaySymbol));

  if (loading && !summary) {
    return <p className="mb-2 text-2xs text-text-muted">Loading today’s range…</p>;
  }
  if (!summary) {
    // Never nothing. An empty space where the day's numbers belong reads as a
    // panel that has none, rather than as a request that did not answer.
    return (
      <p className="mb-2 text-2xs text-text-muted">
        {unavailable ? 'Today’s range is unavailable for this symbol.' : 'Loading today’s range…'}
      </p>
    );
  }

  const price = quote ? Number(quote.last ?? quote.bid) : null;
  const change = summary.change === null ? null : Number(summary.change);
  const changePercent = summary.changePercent === null ? null : Number(summary.changePercent);
  const tone =
    change === null || change === 0
      ? 'text-text-muted'
      : change > 0
        ? 'text-[var(--positive)]'
        : 'text-[var(--negative)]';

  return (
    <div className="mb-3 space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="tabular text-lg font-semibold">
          {price !== null ? price.toFixed(digits) : <Unavailable />}
        </span>
        {change !== null && changePercent !== null ? (
          <span className={cn('tabular text-2xs', tone)}>
            {change > 0 ? '+' : ''}
            {change.toFixed(digits)} ({changePercent > 0 ? '+' : ''}
            {changePercent.toFixed(2)}%)
          </span>
        ) : (
          // No previous close means no change to state. Showing 0.00 (0.00%)
          // would claim the market has not moved, which is a different fact.
          <span className="text-2xs text-text-muted">no previous close</span>
        )}
      </div>

      <DayRange
        low={Number(summary.low).toFixed(digits)}
        high={Number(summary.high).toFixed(digits)}
        position={summary.position}
      />

      <div className="flex justify-between text-2xs text-text-muted">
        <span>
          Open{' '}
          <span className="tabular text-text-primary">{Number(summary.open).toFixed(digits)}</span>
        </span>
        {/* MT5 reports 0 volume on quote-driven instruments — all of FX has no
            centralised volume to report. Rendering "Volume 0" states that
            nothing traded, which is a claim about the market rather than an
            absence of data. A string "0" is truthy, which is how it slipped
            through the first time. */}
        {quote?.volume && Number(quote.volume) > 0 ? (
          <span>
            Volume <span className="tabular text-text-primary">{quote.volume}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
