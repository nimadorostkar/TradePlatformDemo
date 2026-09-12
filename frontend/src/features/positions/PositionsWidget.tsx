import { Fragment, memo, useCallback, useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Badge, Button, EmptyState, Money, Unavailable } from '@/components/ui/primitives';
import { formatBrokerTime, withZone } from '@/domain/common/broker-time';
import { useBrokerOffsetSeconds } from '@/app/providers/use-broker-clock';
import { reportError, useServices } from '@/app/providers/services';
import { TradingError } from '@/domain/common/errors';
import type { Position } from '@/domain/common/models';
import { selectPositions, useTradingStore } from '@/stores/trading-store';
import { useSessionStore } from '@/stores/session-store';
import { useSystemMessages } from '@/stores/system-messages-store';
import { FALLBACK_DIGITS, useSymbolDigits } from '@/features/watchlist/useSymbolDigits';
import { SymbolLogo } from '@/features/watchlist/SymbolLogo';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { Td, Th } from '@/components/ui/table';
import { sortRows, useTableSort, type SortValue } from '@/components/ui/table-sort';
import { StalenessBadge } from '@/features/system-messages/StalenessBadge';
import { ModifyBracketsDialog } from './ModifyBracketsDialog';
import { ClosePositionDialog } from './ClosePositionDialog';
import { BulkActionDialog, type BulkTarget } from './BulkActionDialog';
import { ColumnMenu, type ColumnDefinition } from '@/components/ui/ColumnMenu';
import { useTableColumns } from '@/components/ui/use-table-columns';
import { BracketCell } from '@/features/brackets/BracketCell';
import { formatPrice } from '@/domain/market/price-format';
import { PositionBracketRow } from './PositionBracketRow';

/** Columns offered by this table. `required` ones cannot be hidden. */
const COLUMNS: readonly ColumnDefinition[] = [
  { id: 'symbol', label: 'Symbol', required: true },
  { id: 'side', label: 'Side', required: true },
  { id: 'volume', label: 'Volume', required: true },
  { id: 'open', label: 'Open price' },
  { id: 'current', label: 'Current price' },
  { id: 'sl', label: 'Stop loss' },
  { id: 'tp', label: 'Take profit' },
  { id: 'swap', label: 'Swap' },
  { id: 'profit', label: 'Profit', required: true },
  { id: 'opened', label: 'Opened' },
];

/**
 * Open positions.
 *
 * Reads from the shared normalised store, which is also what the TradingView
 * Broker API renders from — the chart and this table cannot disagree.
 *
 * Fields the gateway does not supply (swap, commission on the streamed shape)
 * render as `Unavailable`, never as 0.
 */

export default function PositionsWidget() {
  const brokerOffsetSeconds = useBrokerOffsetSeconds();
  const openPositions = useTradingStore(selectPositions);
  const freshness = useTradingStore((s) => s.positionsFreshness);
  const initialLoading = useTradingStore((s) => s.initialLoadPending);
  const readOnly = useSessionStore((s) => s.readOnly);
  const setActiveSymbol = useWorkspace((s) => s.setActiveSymbol);

  const [modifying, setModifying] = useState<Position | null>(null);
  const [closing, setClosing] = useState<Position | null>(null);
  const [bulk, setBulk] = useState<'all' | 'profitable' | null>(null);
  const services = useServices();
  const account = useTradingStore((s) => s.account);

  // Lifted out of the bulk memo so the BUTTON can say how many it will act on
  // before it is pressed — the filter used to run only after the click.
  const profitable = useMemo(
    () => openPositions.filter((p) => p.profit !== null && Number(p.profit) > 0),
    [openPositions],
  );

  const bulkTargets = useMemo(() => {
    const selected = bulk === 'profitable' ? profitable : openPositions;
    return selected.map<BulkTarget>((p) => ({
      id: p.id,
      label: `${p.displaySymbol} ${p.side === 'buy' ? 'buy' : 'sell'} ${p.volume}${
        p.profit === null
          ? ''
          : ` (${Number(p.profit) >= 0 ? '+' : ''}${Number(p.profit).toFixed(2)})`
      }`,
    }));
  }, [bulk, openPositions, profitable]);

  const { sort, toggle } = useTableSort();
  const positions = useMemo(
    () => sortRows(openPositions, sort, positionSortValue, (position) => position.id),
    [openPositions, sort],
  );

  const { isVisible } = useTableColumns('positions', COLUMNS);
  // Prices come off MT5 as floats, so 4506.80 arrives as 4506.8; each
  // instrument states its own precision.
  const digitsBySymbol = useSymbolDigits(
    useMemo(() => [...new Set(positions.map((p) => p.displaySymbol))], [positions]),
  );

  const bulkNetProfit = useMemo(() => {
    const ids = new Set(bulkTargets.map((t) => t.id));
    const total = positions
      .filter((p) => ids.has(p.id))
      .reduce((sum, p) => sum + Number(p.profit ?? 0), 0);
    return total.toFixed(2);
  }, [bulkTargets, positions]);

  if (initialLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        Loading positions…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-2 py-1">
        <span className="text-2xs font-medium text-text-secondary">
          {positions.length} open position{positions.length === 1 ? '' : 's'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {positions.length > 0 && !readOnly && (
            <>
              {/* Both close real trades, so both read as destructive — the
                  profitable one used to be a quiet ghost button. And both say
                  what they will actually affect: "Close all" alone tells a
                  screen-reader user nothing about the scale of it. */}
              <Button
                size="xs"
                variant="danger"
                onClick={() => setBulk('profitable')}
                disabled={profitable.length === 0}
                aria-label={`Close ${profitable.length} profitable position${
                  profitable.length === 1 ? '' : 's'
                }`}
              >
                Close profitable ({profitable.length})
              </Button>
              <Button
                size="xs"
                variant="danger"
                onClick={() => setBulk('all')}
                aria-label={`Close all ${positions.length} position${
                  positions.length === 1 ? '' : 's'
                }`}
              >
                Close all ({positions.length})
              </Button>
            </>
          )}
          <ColumnMenu tableId="positions" columns={COLUMNS} />
          <StalenessBadge freshness={freshness} />
        </div>
      </div>

      {positions.length === 0 ? (
        <EmptyState title="No open positions" description="Positions appear here once you trade." />
      ) : (
        <div className="widget-scroll min-h-0 flex-1">
          <table className="w-full border-collapse text-2xs">
            <thead className="sticky top-0 z-10 bg-[var(--background-tertiary)]">
              <tr className="text-text-muted">
                <Th sortKey="symbol" sort={sort} onSort={toggle}>
                  Symbol
                </Th>
                <Th sortKey="side" sort={sort} onSort={toggle}>
                  Side
                </Th>
                <Th align="right" sortKey="volume" sort={sort} onSort={toggle}>
                  Volume
                </Th>
                {isVisible('open') && (
                  <Th align="right" sortKey="open" sort={sort} onSort={toggle}>
                    Open
                  </Th>
                )}
                {isVisible('current') && (
                  <Th align="right" sortKey="current" sort={sort} onSort={toggle}>
                    Current
                  </Th>
                )}
                {isVisible('sl') && <Th align="right">S/L</Th>}
                {isVisible('tp') && <Th align="right">T/P</Th>}
                {isVisible('swap') && (
                  <Th align="right" sortKey="swap" sort={sort} onSort={toggle}>
                    Swap
                  </Th>
                )}
                <Th align="right" sortKey="profit" sort={sort} onSort={toggle}>
                  P/L
                </Th>
                {isVisible('opened') && (
                  <Th sortKey="opened" sort={sort} onSort={toggle}>
                    {withZone('Opened', brokerOffsetSeconds)}
                  </Th>
                )}
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => {
                const digits = digitsBySymbol.get(position.displaySymbol) ?? FALLBACK_DIGITS;
                return (
                  <Fragment key={position.id}>
                    <PositionRow
                      position={position}
                      digits={digits}
                      readOnly={readOnly}
                      onSelect={setActiveSymbol}
                      onModify={setModifying}
                      onClosePosition={setClosing}
                      isVisible={isVisible}
                    />
                    {/* Live protective legs get their own rows, exactly as an
                        order's do — these are the ones that can trigger now. */}
                    {position.stopLoss !== null && (
                      <PositionBracketRow
                        position={position}
                        leg="sl"
                        level={position.stopLoss}
                        digits={digits}
                        readOnly={readOnly}
                        isVisible={isVisible}
                      />
                    )}
                    {position.takeProfit !== null && (
                      <PositionBracketRow
                        position={position}
                        leg="tp"
                        level={position.takeProfit}
                        digits={digits}
                        readOnly={readOnly}
                        isVisible={isVisible}
                      />
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modifying && (
        <ModifyBracketsDialog position={modifying} onClose={() => setModifying(null)} />
      )}

      {closing && <ClosePositionDialog position={closing} onClose={() => setClosing(null)} />}

      {bulk && (
        <BulkActionDialog
          title={bulk === 'profitable' ? 'Close profitable positions' : 'Close all positions'}
          actionLabel={bulk === 'profitable' ? 'Close profitable' : 'Close all'}
          targets={bulkTargets}
          netProfit={bulkNetProfit}
          currency={account?.currency ?? null}
          run={async (target) => {
            const position = useTradingStore.getState().positionsById.get(target.id);
            if (!position) return;
            return services.tradingService.closePosition(position);
          }}
          onClose={() => setBulk(null)}
        />
      )}
    </div>
  );
}

function positionSortValue(position: Position, key: string): SortValue {
  switch (key) {
    case 'symbol':
      return position.displaySymbol;
    case 'side':
      return position.side;
    case 'volume':
      return position.volume;
    case 'open':
      return position.openPrice;
    case 'current':
      return position.currentPrice;
    case 'swap':
      return position.swap;
    case 'profit':
      return position.profit;
    case 'opened':
      return position.openTime;
    default:
      return null;
  }
}

const PositionRow = memo(function PositionRow({
  position,
  digits,
  readOnly,
  onSelect,
  onModify,
  onClosePosition,
  isVisible,
}: {
  position: Position;
  digits: number;
  readOnly: boolean;
  onSelect: (symbol: string) => void;
  onModify: (position: Position) => void;
  onClosePosition: (position: Position) => void;
  isVisible: (id: string) => boolean;
}) {
  const services = useServices();
  const pushMessage = useSystemMessages((s) => s.push);
  const offsetSeconds = useBrokerOffsetSeconds();
  const [busy, setBusy] = useState(false);

  /**
   * Moves the stop to the entry price, removing downside on an open trade.
   *
   * Sent as-is: if price has not travelled far enough, MT5 rejects it with an
   * invalid-stops retcode, which is more truthful than guessing the broker's
   * stop-level here.
   */
  const moveToBreakEven = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await services.tradingService.modifyPositionBrackets(position, {
        stopLoss: position.openPrice,
        takeProfit: position.takeProfit,
      });
      pushMessage({
        level: result.state === 'unknown' ? 'warning' : 'success',
        scope: 'position',
        text:
          result.state === 'unknown'
            ? `Break-even on position ${position.id}: outcome unknown, reconciling.`
            : `Stop moved to break-even on position ${position.id}.`,
        code: 'position.break-even',
        requestId: result.requestId,
      });
    } catch (error) {
      reportError('position', TradingError.from(error));
    } finally {
      setBusy(false);
    }
  }, [busy, position, services, pushMessage]);

  return (
    <tr className="border-b border-[var(--border-default)] hover:bg-[var(--surface-raised)]">
      <Td>
        <button
          onClick={() => onSelect(position.displaySymbol)}
          className="flex items-center gap-1.5 font-medium hover:text-[var(--brand-primary)]"
        >
          <SymbolLogo symbol={position.displaySymbol} size={13} />
          {position.displaySymbol}
        </button>
      </Td>
      <Td>
        <Badge tone={position.side === 'buy' ? 'positive' : 'negative'}>
          {position.side === 'buy' ? 'Buy' : 'Sell'}
        </Badge>
      </Td>
      <Td align="right">
        <span className="tabular">{position.volume}</span>
      </Td>
      {isVisible('open') && (
        <Td align="right">
          <span className="tabular">{formatPrice(position.openPrice, digits)}</span>
        </Td>
      )}
      {isVisible('current') && (
        <Td align="right">
          {position.currentPrice ? (
            <span className="tabular">{formatPrice(position.currentPrice, digits)}</span>
          ) : (
            <Unavailable />
          )}
        </Td>
      )}
      {isVisible('sl') && (
        <Td align="right">
          <BracketCell
            value={position.stopLoss}
            digits={digits}
            leg="sl"
            parent={{ kind: 'position', position }}
            readOnly={readOnly}
          />
        </Td>
      )}
      {isVisible('tp') && (
        <Td align="right">
          <BracketCell
            value={position.takeProfit}
            digits={digits}
            leg="tp"
            parent={{ kind: 'position', position }}
            readOnly={readOnly}
          />
        </Td>
      )}
      {isVisible('swap') && (
        <Td align="right">
          <Money value={position.swap} digits={2} />
        </Td>
      )}
      <Td align="right">
        <Money value={position.profit} digits={2} colorBySign />
      </Td>
      {isVisible('opened') && (
        <Td>
          {position.openTime ? (
            <span className="tabular text-text-muted">
              {formatBrokerTime(position.openTime, offsetSeconds)}
            </span>
          ) : (
            <Unavailable />
          )}
        </Td>
      )}
      <Td align="right">
        <div className="flex justify-end gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={readOnly}
            onClick={() => onModify(position)}
            aria-label={`Modify stop loss and take profit for position ${position.id}`}
          >
            S/L T/P
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={readOnly || busy}
            loading={busy}
            onClick={() => void moveToBreakEven()}
            title="Move the stop-loss to the open price"
            aria-label={`Move stop to break-even for position ${position.id}`}
          >
            B/E
          </Button>
          <Button
            size="xs"
            variant="danger"
            disabled={readOnly}
            onClick={() => onClosePosition(position)}
            aria-label={`Close position ${position.id}`}
          >
            <X className="h-2.5 w-2.5" aria-hidden />
            Close
          </Button>
        </div>
      </Td>
    </tr>
  );
});
