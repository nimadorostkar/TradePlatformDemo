import { useEffect } from 'react';
import { useServices } from '@/app/providers/services';
import { tvQuoteListSchema } from '@/integrations/gateway/contracts/schemas';
import { mapTvQuote } from '@/integrations/gateway/mappers/to-domain';
import { quoteStore } from '@/stores/quote-store';
import { useSessionStore } from '@/stores/session-store';

/**
 * Subscribes to live quotes for a set of DISPLAY symbols.
 *
 * Only the symbols passed in are subscribed — a virtualised watchlist passes
 * its VISIBLE rows, so scrolling a 500-symbol list does not open 500 sockets.
 * The pool deduplicates by canonical key, so the chart and the watchlist
 * watching the same symbol share one connection.
 */
export function useSymbolSubscription(displaySymbols: readonly string[]): void {
  const services = useServices();
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);

  // Join into a stable dependency so a re-render with an equal list does not
  // tear down and rebuild every subscription.
  const key = displaySymbols.join(',');

  useEffect(() => {
    if (displaySymbols.length === 0) return;

    const unsubscribers = displaySymbols.map((displaySymbol) => {
      const gatewaySymbol = suffixPolicy.toGateway(displaySymbol);
      return services.pool.subscribe({ family: 'quote', symbol: gatewaySymbol }, (frame, meta) => {
        const parsed = tvQuoteListSchema.safeParse(frame);
        if (!parsed.success || parsed.data.length === 0) return;
        const dto = parsed.data[0];
        if (!dto) return;
        // A tick with no prices is not a quote; leave the last real one in
        // place rather than replacing it with zeros.
        const quote = mapTvQuote(
          dto,
          quoteStore.get(gatewaySymbol),
          meta.receivedAt,
          gatewaySymbol,
        );
        if (quote !== null) quoteStore.apply(quote);
      });
    });

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, suffixPolicy, services]);
}
