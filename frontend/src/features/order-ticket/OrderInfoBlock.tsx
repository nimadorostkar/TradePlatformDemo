import { useMemo } from 'react';
import { Money, Unavailable } from '@/components/ui/primitives';
import { dec, toDecimalString, type DecimalString } from '@/domain/common/decimal';
import type { TradingSymbol } from '@/domain/common/models';
import { computeOrderInfo } from '@/domain/orders/order-info';
import { useTradingStore } from '@/stores/trading-store';
import { useQuoteToAccountRate } from './useQuoteToAccountRate';

/**
 * The "Order info" / "Position info" block: pip value, trade value, margin
 * used, margin available and leverage, all in the account currency.
 *
 * One component for both places on purpose — the broker-integration spec
 * requires a position opened at the order's price to show exactly the figures
 * the ticket showed, and two implementations of the same maths is how they
 * drift apart. Only the title and the reference price differ.
 *
 * A value whose inputs are unavailable renders "—", never 0 or NaN.
 */
export function OrderInfoBlock({
  title,
  symbol,
  volumeLots,
  volumeInvalid = false,
  price,
}: {
  title: 'Order info' | 'Position info';
  symbol: TradingSymbol | undefined;
  /** Lots, as typed — parsed here so callers can pass the raw input value. */
  volumeLots: string;
  /**
   * True while the ticket's own validation rejects the volume (HGH-06). The
   * block then shows "—" instead of computing figures for an order that can
   * never execute — 0.015 lots produced a precise-looking Trade Value for a
   * volume the server would refuse.
   */
  volumeInvalid?: boolean;
  /**
   * Reference price: ask/bid for a market order, the typed entry for a
   * pending order, the OPEN price for a position. Null while unknown.
   */
  price: DecimalString | null;
}) {
  const account = useTradingStore((s) => s.account);

  const rate = useQuoteToAccountRate(symbol?.currencyCode ?? null, account?.currency ?? null);

  const volume = volumeInvalid ? null : toDecimalString(volumeLots);
  const info = useMemo(
    () =>
      computeOrderInfo({
        symbol,
        volumeLots: volume,
        price,
        quoteToAccountRate: rate,
        leverage: account?.leverage ?? null,
        marginFree: account?.marginFree ?? null,
      }),
    [symbol, volume, price, rate, account?.leverage, account?.marginFree],
  );

  const currency = account?.currency ?? null;

  // The one comparison that turns an estimate into a warning: an order whose
  // required margin exceeds what the account has free can only end in a
  // server-side rejection, and the block must say so BEFORE the attempt —
  // at 50 lots it reported 233,400 required against 0.00 available in the
  // same calm grey as every other row (HGH-06).
  const insufficientMargin =
    info.marginUsed !== null &&
    info.marginAvailable !== null &&
    dec(info.marginUsed).greaterThan(dec(info.marginAvailable));

  return (
    <section
      aria-label={title}
      className="rounded border border-[var(--border-default)] p-1.5 text-2xs"
    >
      <h2 className="mb-1 font-medium text-text-secondary">{title}</h2>
      <dl className="space-y-0.5">
        <InfoRow label="Pip Value">
          <Money value={info.pipValue} currency={currency} />
        </InfoRow>
        <InfoRow label="Trade Value">
          <Money value={info.tradeValue} currency={currency} />
        </InfoRow>
        <InfoRow label="Margin Used">
          {insufficientMargin ? (
            <span className="font-medium text-[var(--negative)]">
              <Money value={info.marginUsed} currency={currency} />
            </span>
          ) : (
            <Money value={info.marginUsed} currency={currency} />
          )}
        </InfoRow>
        <InfoRow
          label="Margin Available"
          // "Available" alone is ambiguous between before and after this
          // trade; this block shows the account's free margin as it stands
          // NOW, which is the number the Account Summary calls "Free margin".
          hint="Current account free margin, before this order executes."
        >
          <Money value={info.marginAvailable} currency={currency} />
        </InfoRow>
        <InfoRow label="Leverage">
          {info.leverage === null ? (
            <Unavailable />
          ) : (
            <span className="tabular">1:{Number(info.leverage)}</span>
          )}
        </InfoRow>
      </dl>
      {insufficientMargin && (
        <p role="alert" className="mt-1 font-medium text-[var(--negative)]">
          Not enough free margin for this order — it would be rejected.
        </p>
      )}
    </section>
  );
}

function InfoRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-text-muted" title={hint}>
        {label}
      </dt>
      <dd className="truncate text-right">{children}</dd>
    </div>
  );
}
