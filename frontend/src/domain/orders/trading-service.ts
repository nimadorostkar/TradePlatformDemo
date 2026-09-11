import type { TradingApi } from '@/integrations/gateway/api/trading-api';
import type { MarketApi } from '@/integrations/gateway/api/market-api';
import type { SymbolSuffixPolicy } from '@/integrations/gateway/mappers/symbol-suffix';
import { TradingError } from '@/domain/common/errors';
import type { DecimalString } from '@/domain/common/decimal';
import { dec } from '@/domain/common/decimal';
import { digitsFromPrice } from '@/integrations/gateway/mappers/trade-codes';
import { volumeIssues } from './validation';
import type {
  OrderKind,
  Position,
  Side,
  TradeSubmissionResult,
  TradingOrder,
  TradingSymbol,
} from '@/domain/common/models';

/**
 * The single trading service.
 *
 * BOTH the custom order ticket and the TradingView Broker API adapter call
 * this. Two independent trade paths would eventually diverge — a validation
 * rule fixed in one, a volume conversion wrong in the other — and the failure
 * mode is a real trade for the wrong size.
 *
 * Everything here is decimal-safe and account-aware. `onStateChanged` is fired
 * after every accepted mutation so the caller can trigger reconciliation
 * instead of optimistically mutating local state.
 */

export interface TradingServiceDeps {
  trading: TradingApi;
  market: MarketApi;
  getLogin: () => string | null;
  getSuffixPolicy: () => SymbolSuffixPolicy;
  getSymbol: (displaySymbol: string) => TradingSymbol | undefined;
  isReadOnly: () => boolean;
  /** Called after any accepted or unknown-outcome mutation. */
  onStateChanged: (reason: string) => void;
  /**
   * Called when a mutation came back undecided for a technical reason (a reply
   * this app could not read). Reported here, once, rather than at each of the
   * seven call sites — one of which would inevitably be forgotten, and the
   * silent one is the dangerous one.
   */
  onDiagnostic?: (scope: string, error: TradingError) => void;
}

export interface OpenPositionInput {
  displaySymbol: string;
  side: Side;
  volumeLots: DecimalString;
  price: DecimalString;
  stopLoss?: DecimalString | null;
  takeProfit?: DecimalString | null;
}

export interface PlacePendingInput extends OpenPositionInput {
  kind: Exclude<OrderKind, 'market'>;
}

/**
 * The outcome of a resize, which is two operations rather than one. The
 * previous id is carried because the trader was told it would change and the
 * notification has to be able to say what it changed FROM.
 */
export interface ResizePendingResult {
  cancelled: TradeSubmissionResult;
  placed: TradeSubmissionResult;
  previousOrderId: string;
}

export class TradingService {
  constructor(private readonly deps: TradingServiceDeps) {}

  async openPosition(
    input: OpenPositionInput,
    signal?: AbortSignal,
  ): Promise<TradeSubmissionResult> {
    const context = this.requireTradingContext(input.displaySymbol);

    const result = await this.deps.trading.openPosition(
      {
        login: context.login,
        gatewaySymbol: context.gatewaySymbol,
        side: input.side,
        volumeLots: input.volumeLots,
        price: input.price,
        stopLoss: input.stopLoss ?? null,
        takeProfit: input.takeProfit ?? null,
        digits: context.digits ?? digitsFromPrice(input.price),
      },
      signal,
    );

    return this.settled(result, 'open-position');
  }

  async placePendingOrder(
    input: PlacePendingInput,
    signal?: AbortSignal,
  ): Promise<TradeSubmissionResult> {
    const context = this.requireTradingContext(input.displaySymbol);

    const result = await this.deps.trading.placePendingOrder(
      {
        login: context.login,
        gatewaySymbol: context.gatewaySymbol,
        side: input.side,
        kind: input.kind,
        volumeLots: input.volumeLots,
        price: input.price,
        stopLoss: input.stopLoss ?? null,
        takeProfit: input.takeProfit ?? null,
        digits: context.digits ?? digitsFromPrice(input.price),
      },
      signal,
    );

    return this.settled(result, 'place-pending');
  }

  async modifyPositionBrackets(
    position: Position,
    brackets: { stopLoss: DecimalString | null; takeProfit: DecimalString | null },
    signal?: AbortSignal,
  ): Promise<TradeSubmissionResult> {
    const context = this.requireTradingContext(position.displaySymbol);

    const result = await this.deps.trading.modifyPosition(
      {
        login: context.login,
        gatewaySymbol: position.symbol,
        positionId: position.id,
        side: position.side,
        stopLoss: brackets.stopLoss,
        takeProfit: brackets.takeProfit,
        digits: context.digits ?? digitsFromPrice(position.openPrice),
      },
      signal,
    );

    return this.settled(result, 'modify-position');
  }

  /**
   * Clears ONE bracket leg on a position or a pending order, leaving its
   * sibling exactly as it was.
   *
   * MT5 has no standalone bracket order to cancel, so "cancel this bracket" is
   * a modification of the parent with that level set to null (which the gateway
   * encodes as 0, MT5's "no stop"). Both callers — the chart, via the broker
   * adapter's synthetic bracket orders, and the Positions/Orders dock — go
   * through here, because getting the SURVIVING leg wrong silently removes a
   * live stop, and nothing on screen would say so.
   *
   * Both branches therefore NAME the surviving level explicitly, read from the
   * parent. The order branch could rely on `modifyOrder` treating `undefined` as
   * "leave this leg alone" — and did — but that was only correct because of a
   * defaulting rule three call frames away, and one frame below THAT the wire
   * mapper does `stopLoss === null ? 0 : Number(stopLoss)`, which turns an
   * `undefined` that ever reaches it into `NaN` and then, through
   * `JSON.stringify`, into `null`: a cleared bracket. Correct-by-accident is
   * not good enough for a protective stop, so neither branch relies on a
   * sentinel resolved elsewhere.
   */
  async cancelBracketLeg(
    parent: { kind: 'order'; order: TradingOrder } | { kind: 'position'; position: Position },
    leg: 'sl' | 'tp',
    signal?: AbortSignal,
  ): Promise<TradeSubmissionResult> {
    if (parent.kind === 'order') {
      const { order } = parent;
      return this.modifyOrder(
        order,
        {
          stopLoss: leg === 'sl' ? null : order.stopLoss,
          takeProfit: leg === 'tp' ? null : order.takeProfit,
        },
        signal,
      );
    }

    const { position } = parent;
    return this.modifyPositionBrackets(
      position,
      {
        stopLoss: leg === 'sl' ? null : position.stopLoss,
        takeProfit: leg === 'tp' ? null : position.takeProfit,
      },
      signal,
    );
  }

  /**
   * Closes a position, fully or partially.
   * A partial close sends a smaller volume on the opposite side; MT5 nets it
   * against the existing position rather than opening a new one.
   */
  async closePosition(
    position: Position,
    volumeLots?: DecimalString,
    signal?: AbortSignal,
  ): Promise<TradeSubmissionResult> {
    const context = this.requireTradingContext(position.displaySymbol);

    const result = await this.deps.trading.closePosition(
      {
        login: context.login,
        gatewaySymbol: position.symbol,
        positionId: position.id,
        side: position.side,
        volumeLots: volumeLots ?? position.volume,
      },
      signal,
    );

    return this.settled(result, 'close-position');
  }

  async modifyOrder(
    order: TradingOrder,
    changes: {
      price?: DecimalString;
      volumeLots?: DecimalString;
      stopLoss?: DecimalString | null;
      takeProfit?: DecimalString | null;
    },
    signal?: AbortSignal,
  ): Promise<TradeSubmissionResult> {
    const context = this.requireTradingContext(order.displaySymbol);

    if (order.kind === 'market') {
      throw new TradingError({
        kind: 'validation',
        message: 'A market order cannot be modified.',
        code: 'trade.modify-market',
      });
    }

    // MT5 cannot change a pending order's volume in place — that takes cancel
    // + re-place. The server does not reject a changed volume; it applies the
    // rest of the request, ignores the volume, and reports success, which the
    // UI then repeated as a silent lie: a trader shown "saved" while their
    // order stayed at its old size. Refusing here turns the silent drop into a
    // visible error on EVERY path, including any future caller that does not
    // know the rule. Compared numerically: "0.1" and "0.10" are the same size.
    if (changes.volumeLots !== undefined && !dec(changes.volumeLots).equals(dec(order.volume))) {
      throw new TradingError({
        kind: 'validation',
        message:
          'The order size cannot be changed on this server. Cancel the order and place a new one.',
        code: 'trade.no-volume-modify',
      });
    }

    const price = changes.price ?? order.price;
    if (price === null) {
      throw new TradingError({
        kind: 'validation',
        message: 'This order has no entry price to modify.',
        code: 'trade.no-price',
      });
    }

    const result = await this.deps.trading.modifyOrder(
      {
        login: context.login,
        gatewaySymbol: order.symbol,
        orderId: order.id,
        side: order.side,
        kind: order.kind,
        volumeLots: changes.volumeLots ?? order.volume,
        price,
        stopLoss: changes.stopLoss === undefined ? order.stopLoss : changes.stopLoss,
        takeProfit: changes.takeProfit === undefined ? order.takeProfit : changes.takeProfit,
        digits: context.digits ?? digitsFromPrice(price),
      },
      signal,
    );

    return this.settled(result, 'modify-order');
  }

  /**
   * Changes a pending order's SIZE, the only way this server permits.
   *
   * MT5 cannot resize a pending order in place: it applies the rest of a modify
   * request, ignores the volume and reports success (proven against the live
   * server; see `modifyOrder`'s guard, which stays in place so no caller can
   * recreate that silent lie). The size therefore changes the only way it can —
   * the order is cancelled and an equivalent one placed at the new volume.
   *
   * That is a materially different act from a modify and is treated as one. The
   * order leaves the book in between and comes back with a NEW ticket, so:
   *   - the volume is validated BEFORE anything is destroyed;
   *   - the replacement is placed only when the cancel is definitively
   *     ACCEPTED, never on an undecided one, which would risk two live orders
   *     for the same intent;
   *   - a failure after the cancel is raised as its own error carrying what was
   *     lost, because the one unacceptable outcome is a trader left with no
   *     order and no warning.
   */
  async resizePendingOrder(
    order: TradingOrder,
    volumeLots: DecimalString,
    changes: {
      price?: DecimalString;
      stopLoss?: DecimalString | null;
      takeProfit?: DecimalString | null;
    } = {},
    signal?: AbortSignal,
  ): Promise<ResizePendingResult> {
    this.requireTradingContext(order.displaySymbol);

    if (order.kind === 'market') {
      throw new TradingError({
        kind: 'validation',
        message: 'A market order cannot be resized.',
        code: 'trade.resize-market',
      });
    }
    if (order.status !== 'working') {
      // Filled, cancelled or rejected: there is nothing left to resize, and
      // cancelling something already gone would be the start of a mess.
      throw new TradingError({
        kind: 'validation',
        message: 'This order is no longer working, so its size cannot be changed.',
        code: 'trade.resize-not-working',
      });
    }
    if (dec(volumeLots).equals(dec(order.volume))) {
      throw new TradingError({
        kind: 'validation',
        message: 'That is the size the order already has.',
        code: 'trade.resize-unchanged',
      });
    }
    // A dialog can change size AND price/brackets in one submission, so the
    // replacement carries all of them. Dropping the others would quietly undo
    // edits the trader watched themselves make.
    const price = changes.price ?? order.price;
    const stopLoss = changes.stopLoss === undefined ? order.stopLoss : changes.stopLoss;
    const takeProfit = changes.takeProfit === undefined ? order.takeProfit : changes.takeProfit;
    if (price === null) {
      throw new TradingError({
        kind: 'validation',
        message: 'This order has no entry price to replace.',
        code: 'trade.no-price',
      });
    }

    // Checked BEFORE the cancel. A volume the broker would refuse must never
    // cost the trader the order they already had.
    const symbol = this.deps.getSymbol(order.displaySymbol);
    if (symbol) {
      const blocking = volumeIssues(volumeLots, symbol).find((issue) => issue.severity === 'error');
      if (blocking) {
        throw new TradingError({
          kind: 'validation',
          message: blocking.message,
          code: 'trade.resize-invalid-volume',
        });
      }
    }

    const cancelled = await this.cancelOrder(order, signal);
    if (cancelled.state !== 'accepted') {
      // Includes `unknown`. The order may still be live, so placing a second
      // one could double the trader's exposure — far worse than a refused
      // resize. Nothing has been lost here: the original stands.
      throw new TradingError({
        kind: 'validation',
        message:
          cancelled.state === 'unknown'
            ? 'The order could not be confirmed as cancelled, so its size was left unchanged. Check your orders before trying again.'
            : 'The order could not be cancelled, so its size was left unchanged.',
        code: 'trade.resize-cancel-failed',
      });
    }

    try {
      const placed = await this.placePendingOrder(
        {
          displaySymbol: order.displaySymbol,
          side: order.side,
          kind: order.kind as Exclude<OrderKind, 'market'>,
          volumeLots,
          price,
          stopLoss,
          takeProfit,
        },
        signal,
      );
      return { cancelled, placed, previousOrderId: order.id };
    } catch (error) {
      // The order is GONE and its replacement did not arrive. This is the one
      // outcome the trader must never discover for themselves, so it is raised
      // as its own code carrying everything needed to place it again.
      const cause = TradingError.from(error);
      throw new TradingError({
        kind: 'validation',
        message: `Order ${order.id} was cancelled but its replacement could not be placed: ${cause.message} You currently have no order for this symbol at that price.`,
        code: 'trade.resize-orphaned',
        // `payload`, not `cause`: TradingError stores payload and drops cause,
        // and this is the data a retry needs to put the order back.
        payload: {
          displaySymbol: order.displaySymbol,
          side: order.side,
          kind: order.kind,
          volumeLots,
          price,
          stopLoss,
          takeProfit,
        } satisfies PlacePendingInput,
      });
    }
  }

  async cancelOrder(order: TradingOrder, signal?: AbortSignal): Promise<TradeSubmissionResult> {
    const context = this.requireTradingContext(order.displaySymbol);

    if (order.kind === 'market') {
      throw new TradingError({
        kind: 'validation',
        message: 'A market order cannot be canceled.',
        code: 'trade.cancel-market',
      });
    }

    const result = await this.deps.trading.cancelOrder(
      {
        login: context.login,
        gatewaySymbol: order.symbol,
        orderId: order.id,
        side: order.side,
        kind: order.kind,
      },
      signal,
    );

    return this.settled(result, 'cancel-order');
  }

  /**
   * The one exit every mutation takes: trigger reconciliation, and record the
   * reason when the outcome came back undecided through no fault of the trader.
   */
  private settled(result: TradeSubmissionResult, reason: string): TradeSubmissionResult {
    this.deps.onStateChanged(reason);
    if (result.diagnostic) this.deps.onDiagnostic?.(reason, result.diagnostic);
    return result;
  }

  /**
   * Resolves the account + symbol context for a mutation, refusing early when
   * the session cannot legitimately trade. Read-only is enforced here rather
   * than only in the UI, so the TradingView Broker API path is covered too.
   */
  private requireTradingContext(displaySymbol: string): {
    login: string;
    gatewaySymbol: string;
    digits: number | null;
  } {
    const login = this.deps.getLogin();
    if (!login) {
      throw new TradingError({
        kind: 'validation',
        message: 'Select a trading account first.',
        code: 'trade.no-account',
      });
    }

    if (this.deps.isReadOnly()) {
      throw new TradingError({
        kind: 'forbidden',
        message: 'This account is read-only and cannot place trades.',
        code: 'trade.read-only',
        retryable: false,
      });
    }

    const symbol = this.deps.getSymbol(displaySymbol);
    return {
      login,
      gatewaySymbol: this.deps.getSuffixPolicy().toGateway(displaySymbol),
      digits: symbol?.digits ?? null,
    };
  }
}
