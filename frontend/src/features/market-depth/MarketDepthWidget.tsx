import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { Badge, Button, EmptyState, ErrorState, LoadingState } from '@/components/ui/primitives';
import { useServices } from '@/app/providers/services';
import { useSessionStore } from '@/stores/session-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { useSymbolMetadata } from '@/features/order-ticket/useSymbolMetadata';
import { useOrderDraft } from '@/stores/order-draft-store';
import { useQuote } from '@/stores/quote-store';
import { DEPTH_POLL_BASE_MS, nextDepthPollDelay } from '@/domain/market/depth-poll';
import {
  buildLadder,
  ladderIntent,
  ladderOrder,
  spreadPoints,
  volumesByPrice,
} from '@/domain/market/ladder';
import type { LadderRow } from '@/domain/market/ladder';
import { splitPrice } from '@/domain/market/price-format';
import type { DecimalString } from '@/domain/common/decimal';
import type { MarketDepthDto } from '@/integrations/gateway/contracts/schemas';
import type { Side } from '@/domain/common/models';
import { SymbolLogo } from '@/features/watchlist/SymbolLogo';

/**
 * The trading ladder.
 *
 * Rows come from the live BID/ASK, not from the order book. A ladder is a price
 * ladder first and a volume ladder second — cTrader, NinjaTrader, ATAS and
 * Sierra Chart all draw rows stepped around the market and let a trader work
 * orders on them, with Level 2 volume enriching those rows where the venue
 * publishes it. Building the rows out of the book instead meant the whole
 * surface disappeared on a broker that publishes none: this MT5 answers
 * `book/subscribe` with 504 for every symbol, so there was nothing to click and
 * no way to place an order from here at all.
 *
 * Clicking works an order in the order TICKET; it never places one. The ticket
 * keeps its two explicit BUY and SELL buttons, which are the last checkpoint
 * before real money moves and not something a click on a ladder should skip.
 */

/** Price levels drawn on each side of the spread. */
const LADDER_DEPTH = 8;

export default function MarketDepthWidget() {
  const services = useServices();
  const displaySymbol = useWorkspace((s) => s.workspace.activeSymbol);
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const { symbol } = useSymbolMetadata(displaySymbol);
  const applyFrom = useOrderDraft((s) => s.applyFrom);
  const quote = useQuote(suffixPolicy.toGateway(displaySymbol));
  const [menu, setMenu] = useState<{ price: DecimalString; x: number; y: number } | null>(null);

  // Current poll delay, held per polled symbol. A ref rather than state: it
  // paces the timer and must never trigger a render of its own. It is scoped by
  // symbol so switching charts starts the new instrument at the base rate
  // instead of inheriting a backed-off delay it did nothing to earn.
  const pollKey = `${displaySymbol}|${suffixPolicy.suffix}`;
  const poll = useRef({ key: pollKey, delay: DEPTH_POLL_BASE_MS });
  if (poll.current.key !== pollKey) {
    poll.current = { key: pollKey, delay: DEPTH_POLL_BASE_MS };
  }

  const query = useQuery<MarketDepthDto>({
    queryKey: ['market-depth', displaySymbol, suffixPolicy.suffix],
    // The book moves constantly; poll rather than hold a socket open for a
    // panel the trader may not be looking at. An empty book backs the loop off
    // instead of hammering a feed that publishes no depth — see depth-poll.ts.
    refetchInterval: (query) => {
      if (query.state.status === 'pending') return poll.current.delay;
      poll.current.delay = nextDepthPollDelay(poll.current.delay, query.state.data);
      return poll.current.delay;
    },
    staleTime: 0,
    retry: 1,
    queryFn: ({ signal }) =>
      services.market.marketDepth(suffixPolicy.toGateway(displaySymbol), signal),
  });

  const digits = symbol?.digits ?? 5;
  const depth = query.data;

  const rows = useMemo(() => {
    if (!quote) return [];
    return buildLadder({
      bid: quote.bid,
      ask: quote.ask,
      digits,
      depth: LADDER_DEPTH,
      bidVolumes: depth ? volumesByPrice(depth.bids, digits) : undefined,
      askVolumes: depth ? volumesByPrice(depth.asks, digits) : undefined,
    });
  }, [quote, depth, digits]);

  const spread = quote ? spreadPoints(quote.bid, quote.ask, digits) : null;

  // The market sits in the MIDDLE of the ladder, so a panel that opens scrolled
  // to the top opens showing the rows furthest from anything a trader wants.
  // Centred once per instrument, not per tick: re-centring under a moving
  // market would drag the rows out from under a cursor mid-click.
  const scrollRef = useRef<HTMLDivElement>(null);
  const marketRef = useRef<HTMLDivElement>(null);
  const centredFor = useRef<string | null>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    // Centring needs a height to centre WITHIN, and this widget can render
    // before its pane has given it one — seen on production, where the ladder
    // came up with the spread pinned to the top and every ask row scrolled out
    // of sight, because clientHeight was still 0 when the maths ran. Waiting
    // for the observer rather than guessing: the first non-zero height is the
    // first moment the answer means anything.
    const centre = () => {
      const market = marketRef.current;
      if (!market || scroller.clientHeight === 0) return;
      if (centredFor.current === displaySymbol) return;
      // Measured against the SCROLLER, not against offsetParent. offsetTop is
      // relative to the nearest positioned ancestor, and this scroller is not
      // one — so the offset version answered in the wrong coordinate space and
      // was only ever accidentally close.
      const marketBox = market.getBoundingClientRect();
      const scrollerBox = scroller.getBoundingClientRect();
      const offsetWithin = marketBox.top - scrollerBox.top + scroller.scrollTop;
      scroller.scrollTop = Math.max(
        0,
        offsetWithin - scroller.clientHeight / 2 + marketBox.height / 2,
      );
      centredFor.current = displaySymbol;
    };

    centre();
    // Reads sizes and sets scrollTop, which changes no layout — this cannot
    // feed itself the way an observer that writes a size can.
    const observer = new ResizeObserver(centre);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [displaySymbol, rows.length]);

  const maxVolume = useMemo(() => {
    const volumes = rows.flatMap((row) =>
      [row.bidVolume, row.askVolume].filter((v): v is DecimalString => v !== null).map(Number),
    );
    return volumes.length > 0 ? Math.max(...volumes) : 0;
  }, [rows]);

  /** Works a pending order in the ticket from a ladder click. */
  const workOrder = (side: Side, price: DecimalString, forceStop: boolean) => {
    if (!quote) return;
    const order = ladderOrder({ side, price, bid: quote.bid, ask: quote.ask, forceStop });
    // Null means the click asks for an order the server would refuse — a buy
    // stop below the market, say. Nothing is applied, rather than silently
    // substituting a different order from the one the trader asked for.
    if (!order) return;
    applyFrom(`the ladder (${ladderIntent(order)})`, {
      kind: order.kind,
      price: order.price,
      side: order.side,
    });
    setMenu(null);
  };

  const workMarket = (side: Side) => {
    applyFrom(`the ladder (${ladderIntent({ side, kind: 'market' })})`, {
      kind: 'market',
      price: '',
      side,
    });
  };

  if (query.isLoading && !quote) return <LoadingState label="Loading order book…" />;
  if (query.isError && !quote) {
    return <ErrorState title="Order book unavailable" onRetry={() => void query.refetch()} />;
  }
  if (!quote) {
    // Without a quote there is no market to draw a ladder around. This is the
    // only genuinely empty state left — an empty BOOK is no longer one.
    return (
      <EmptyState
        title="Waiting for a price"
        description="The ladder is drawn around the current bid and ask, which have not arrived yet."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" onClick={() => setMenu(null)}>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-default)] px-2 py-1 text-2xs">
        <SymbolLogo symbol={displaySymbol} size={14} />
        <span className="font-medium">{displaySymbol}</span>
        {depth?.subscribed === false ? (
          // The reason lives in a tooltip, but the chip itself has to read as a
          // statement about the FEED rather than as a fault in this panel: the
          // ladder below it is fully live and fully tradable without a book.
          <span
            className="rounded-sm border border-[var(--border-default)] px-1 py-px text-text-muted"
            title={
              depth.subscribeError ??
              'The trading server did not accept a market-depth subscription, so no resting volume is available. Prices and trading are unaffected.'
            }
          >
            no Level 2
          </span>
        ) : (
          <span className="text-text-muted">volume in {depth?.volumeUnit ?? 'lots'}</span>
        )}
        {depth?.crossed ? (
          <Badge tone="negative" className="ml-auto">
            Crossed
          </Badge>
        ) : null}
      </div>

      {depth?.crossed ? (
        <p className="flex items-start gap-1.5 border-b border-[var(--border-default)] bg-[var(--negative-notice)] px-2 py-1 text-2xs text-[var(--negative)]">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          The best bid is at or above the best ask. The book is momentarily inconsistent — treat
          these levels with caution.
        </p>
      ) : null}

      <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] gap-1 border-b border-[var(--border-default)] px-2 py-1 text-2xs font-medium text-text-muted">
        <span>Buy</span>
        <span className="text-center">Price</span>
        <span className="text-right">Sell</span>
      </div>

      <div ref={scrollRef} className="widget-scroll min-h-0 flex-1">
        {rows.map((row, index) => (
          <Fragment key={row.price}>
            {/* The spread is the one place on a ladder a trader looks first,
                and it was the only place with nothing drawn on it. Marking it
                splits the two halves apart and puts the number that decides
                whether a trade is worth taking where the eye already is. */}
            {row.band === 'bid' && rows[index - 1]?.band === 'ask' ? (
              <div ref={marketRef} className="flex items-center gap-1.5 px-2 py-0.5">
                <span className="h-px flex-1 bg-[var(--border-strong)]" />
                <span
                  className="tabular text-2xs text-text-muted"
                  title="The spread: what it costs to cross this market right now"
                >
                  {spread === null ? 'spread' : `${spread.toFixed(1)} pts`}
                </span>
                <span className="h-px flex-1 bg-[var(--border-strong)]" />
              </div>
            ) : null}
            <LadderRowView
              row={row}
              digits={digits}
              max={maxVolume}
              bid={quote.bid}
              ask={quote.ask}
              onWork={workOrder}
              onMenu={(price, x, y) => setMenu({ price, x, y })}
            />
          </Fragment>
        ))}
      </div>

      <UnclassifiedNotice count={depth?.unclassified ?? null} />

      {/* Market execution, which every ladder carries at its foot. Like every
          other control here it works the ticket rather than placing a trade. */}
      <div className="flex shrink-0 gap-1 border-t border-[var(--border-default)] p-1.5">
        <Button size="xs" variant="secondary" className="flex-1" onClick={() => workMarket('buy')}>
          Buy Market
        </Button>
        <Button size="xs" variant="secondary" className="flex-1" onClick={() => workMarket('sell')}>
          Sell Market
        </Button>
      </div>

      {menu ? (
        <LadderMenu
          price={menu.price}
          x={menu.x}
          y={menu.y}
          onPick={(side, forceStop) => workOrder(side, menu.price, forceStop)}
        />
      ) : null}
    </div>
  );
}

/**
 * What the ladder is not showing, and why.
 *
 * Said in the trader's terms, not the parser's: "could not be classified as bid
 * or ask" described what our code failed to do, which tells a trader nothing
 * about the market or about the ladder in front of them. What happened is that
 * the server sent a level with no side on it, so the ladder cannot place it in
 * either column and leaves it out.
 */
export function UnclassifiedNotice({ count }: { count: number | null }) {
  if (count === null || count <= 0) return null;
  return (
    <p className="shrink-0 border-t border-[var(--border-default)] px-2 py-1 text-2xs text-[var(--warning)]">
      {count === 1
        ? 'The trading server sent 1 price level without saying whether it was a buy or a sell, so it is left out of the ladder above.'
        : `The trading server sent ${count} price levels without saying whether they were buys or sells, so they are left out of the ladder above.`}
    </p>
  );
}

function LadderRowView({
  row,
  digits,
  max,
  bid,
  ask,
  onWork,
  onMenu,
}: {
  row: LadderRow;
  digits: number;
  max: number;
  bid: DecimalString;
  ask: DecimalString;
  onWork: (side: Side, price: DecimalString, forceStop: boolean) => void;
  onMenu: (price: DecimalString, x: number, y: number) => void;
}) {
  const price = splitPrice(row.price, digits);
  // What a click on each side would actually work. Computed here so the cell
  // can SAY it on hover: the rule (below the market rests, above it arms) is
  // the one thing about a ladder nobody can infer from looking at one.
  const buy = ladderOrder({ side: 'buy', price: row.price, bid, ask });
  const sell = ladderOrder({ side: 'sell', price: row.price, bid, ask });

  return (
    <div
      className={cn(
        'group grid grid-cols-[1fr_auto_1fr] items-center gap-1 px-2 text-2xs',
        // Which half of the market a row is on, carried by the faintest tint
        // that still reads: above the market is where selling rests, below it
        // is where buying does, and a ladder that says so needs no legend.
        row.band === 'ask' ? 'bg-[var(--negative-wash)]' : 'bg-[var(--positive-wash)]',
        row.isBest && 'border-y border-[var(--border-default)] font-semibold',
      )}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(row.price, event.clientX, event.clientY);
      }}
    >
      <LadderCell
        side="buy"
        price={row.price}
        volume={row.bidVolume}
        max={max}
        intent={buy ? ladderIntent(buy) : null}
        onClick={(forceStop) => onWork('buy', row.price, forceStop)}
      />
      <span className="tabular text-center">
        {price ? (
          <>
            <span className="text-text-muted">{price.lead}</span>
            <span className={cn(row.isBest && 'text-text-primary')}>{price.pip}</span>
            {price.fraction ? (
              <span className="text-[0.85em] text-text-muted">{price.fraction}</span>
            ) : null}
          </>
        ) : (
          '—'
        )}
      </span>
      <LadderCell
        side="sell"
        price={row.price}
        volume={row.askVolume}
        max={max}
        intent={sell ? ladderIntent(sell) : null}
        onClick={(forceStop) => onWork('sell', row.price, forceStop)}
      />
    </div>
  );
}

/**
 * One side's cell on a ladder row.
 *
 * The whole cell is the target, not just its text: a ladder is clicked at
 * speed, and a trader aiming at a price should not have to hit a number.
 *
 * With no Level 2 the cell has no volume to draw, which left two thirds of the
 * panel blank and reading as broken. The order the click would work goes there
 * instead — the same information the tooltip carried, at the speed a ladder is
 * actually used. Where volume DOES exist it keeps the column, and the label
 * gives way to it on hover only.
 */
function LadderCell({
  side,
  price,
  volume,
  max,
  intent,
  onClick,
}: {
  side: Side;
  price: DecimalString;
  volume: DecimalString | null;
  max: number;
  intent: string | null;
  onClick: (forceStop: boolean) => void;
}) {
  const share = max > 0 && volume !== null ? Math.min(100, (Number(volume) / max) * 100) : 0;
  const tone = side === 'buy' ? 'var(--positive)' : 'var(--negative)';

  return (
    <button
      type="button"
      // Ctrl (or ⌘ on a Mac) asks for the stop variant explicitly.
      onClick={(event) => onClick(event.ctrlKey || event.metaKey)}
      disabled={intent === null}
      aria-label={intent ? `${intent} at ${price}` : `No order available at ${price}`}
      title={
        intent
          ? `${intent} at ${price} — hold Ctrl for a stop order`
          : `Neither a limit nor a stop is meaningful at ${price}`
      }
      className={cn(
        // MED-03: a 16px-tall row cannot be a compliant click target and
        // negative margins would overlap the NEXT price's button — the one
        // place a stolen click is a wrong-price order. The ladder trades a
        // third of its density for rows a pointer can actually hit.
        'relative h-6 w-full overflow-hidden text-left tabular',
        'enabled:hover:bg-[var(--surface-raised)] disabled:cursor-default',
        side === 'sell' && 'text-right',
      )}
    >
      {share > 0 ? (
        <span
          aria-hidden
          className="absolute inset-y-0 opacity-25"
          style={{ width: `${share}%`, background: tone, [side === 'buy' ? 'left' : 'right']: 0 }}
        />
      ) : null}
      <span className={cn('relative', intent && 'group-hover:hidden')}>{volume ?? ''}</span>
      {intent ? (
        <span
          aria-hidden
          className="relative hidden truncate text-text-muted group-hover:inline"
          style={{ color: tone }}
        >
          {intent}
        </span>
      ) : null}
    </button>
  );
}

/** The explicit order-type menu, for a trader who would rather not infer. */
function LadderMenu({
  price,
  x,
  y,
  onPick,
}: {
  price: DecimalString;
  x: number;
  y: number;
  onPick: (side: Side, forceStop: boolean) => void;
}) {
  const items: { label: string; side: Side; forceStop: boolean }[] = [
    { label: 'Buy Limit', side: 'buy', forceStop: false },
    { label: 'Buy Stop', side: 'buy', forceStop: true },
    { label: 'Sell Limit', side: 'sell', forceStop: false },
    { label: 'Sell Stop', side: 'sell', forceStop: true },
  ];

  return (
    <div
      role="menu"
      aria-label={`Order types at ${price}`}
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
      className="fixed z-50 min-w-36 rounded border border-[var(--border-strong)] bg-[var(--surface-overlay)] py-1 shadow-[var(--shadow-panel)]"
    >
      <p className="px-2 pb-1 text-2xs text-text-muted">
        at <span className="tabular">{price}</span>
      </p>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => onPick(item.side, item.forceStop)}
          className="block w-full px-2 py-1 text-left text-2xs hover:bg-[var(--surface-raised)]"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
