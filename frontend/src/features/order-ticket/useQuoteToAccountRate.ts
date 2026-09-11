import { useMemo } from 'react';
import { decimalStringOf, type DecimalString } from '@/domain/common/decimal';
import { conversionCandidates, rateFromQuote } from '@/domain/orders/order-info';
import { useQuote } from '@/stores/quote-store';
import { useSessionStore } from '@/stores/session-store';
import { useSymbolSubscription } from '@/features/watchlist/useSymbolSubscription';

/**
 * The live cross rate from a symbol's quote currency to the account currency,
 * sourced from the quotes feed — because this trading server does not report a
 * tick value for at least EURUSD, so conversion cannot lean on the symbol spec.
 *
 * Same currency → "1" with no subscription. Otherwise both orientations of the
 * conversion pair (JPYUSD, USDJPY) are subscribed; whichever the broker
 * actually lists delivers quotes, the direct one preferred, and the inverse's
 * price is inverted. No quote on either → null, which the UI renders as "—".
 */
export function useQuoteToAccountRate(
  quoteCurrency: string | null,
  accountCurrency: string | null,
): DecimalString | null {
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);

  const candidates = useMemo(
    () =>
      quoteCurrency && accountCurrency ? conversionCandidates(quoteCurrency, accountCurrency) : [],
    [quoteCurrency, accountCurrency],
  );

  const pairs = useMemo(() => candidates.map((c) => c.pair), [candidates]);
  useSymbolSubscription(pairs);

  const direct = useQuote(candidates[0] ? suffixPolicy.toGateway(candidates[0].pair) : null);
  const inverse = useQuote(candidates[1] ? suffixPolicy.toGateway(candidates[1].pair) : null);

  if (!quoteCurrency || !accountCurrency) return null;
  if (quoteCurrency === accountCurrency) return decimalStringOf(1);

  if (direct) {
    const rate = rateFromQuote(direct.bid, direct.ask, false);
    if (rate !== null) return rate;
  }
  if (inverse) {
    const rate = rateFromQuote(inverse.bid, inverse.ask, true);
    if (rate !== null) return rate;
  }
  return null;
}
