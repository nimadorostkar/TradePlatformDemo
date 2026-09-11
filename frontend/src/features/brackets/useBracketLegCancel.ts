import { useCallback, useState } from 'react';
import { reportError, useServices } from '@/app/providers/services';
import { TradingError } from '@/domain/common/errors';
import type { Position, TradingOrder } from '@/domain/common/models';
import { useSystemMessages } from '@/stores/system-messages-store';

/** The thing a bracket leg protects. */
export type BracketParent =
  { kind: 'order'; order: TradingOrder } | { kind: 'position'; position: Position };

/**
 * Cancels one bracket leg, with the shared outcome reporting.
 *
 * Extracted because two surfaces now offer the action — the × inside the S/L
 * and T/P cells, and the Cancel button on a bracket's own row — and a second
 * copy of the outcome handling is a second place for the messages to drift.
 * The sibling-preservation rule itself stays in
 * `TradingService.cancelBracketLeg`; this hook only reports.
 */
export function useBracketLegCancel(parent: BracketParent, leg: 'sl' | 'tp') {
  const services = useServices();
  const pushMessage = useSystemMessages((s) => s.push);
  const [canceling, setCanceling] = useState(false);

  const parentId = parent.kind === 'order' ? parent.order.id : parent.position.id;
  const legName = leg === 'sl' ? 'Stop loss' : 'Take profit';

  const cancel = useCallback(async () => {
    if (canceling) return;
    setCanceling(true);
    try {
      const result = await services.tradingService.cancelBracketLeg(parent, leg);
      pushMessage({
        level: result.state === 'unknown' ? 'warning' : 'success',
        scope: parent.kind === 'order' ? 'order' : 'position',
        text:
          result.state === 'unknown'
            ? `${legName} cancellation on ${parentId}: outcome unknown, reconciling.`
            : `${legName} canceled on ${parentId}.`,
        code: 'bracket.cancel',
        requestId: result.requestId,
      });
    } catch (error) {
      reportError(parent.kind === 'order' ? 'order' : 'position', TradingError.from(error));
    } finally {
      setCanceling(false);
    }
  }, [canceling, parent, leg, legName, parentId, services, pushMessage]);

  return { canceling, cancel, parentId, legName };
}
