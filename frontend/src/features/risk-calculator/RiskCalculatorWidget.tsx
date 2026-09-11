import { useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { Badge, Button, Field, Input, Unavailable } from '@/components/ui/primitives';
import { toDecimalString } from '@/domain/common/decimal';
import { calculateRisk } from '@/domain/orders/risk';
import type { Side } from '@/domain/common/models';
import { useQuote } from '@/stores/quote-store';
import { useSessionStore } from '@/stores/session-store';
import { selectAccount, useTradingStore } from '@/stores/trading-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { useSymbolMetadata } from '@/features/order-ticket/useSymbolMetadata';
import { useOrderDraft } from '@/stores/order-draft-store';

/**
 * Risk-based position sizing.
 *
 * Every number here is an ESTIMATE and says so. When an input the maths depends
 * on is unavailable — most often tick size / tick value, which the gateway's
 * TradingView symbol shape does not carry — the calculator refuses to produce a
 * number and explains why. A lot size derived from a guessed tick value is a
 * real position at the wrong risk.
 */
export default function RiskCalculatorWidget() {
  const displaySymbol = useWorkspace((s) => s.workspace.activeSymbol);
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const account = useTradingStore(selectAccount);
  const { symbol } = useSymbolMetadata(displaySymbol);
  const quote = useQuote(suffixPolicy.toGateway(displaySymbol));

  const applyToTicket = useOrderDraft((s) => s.applyFrom);
  const activateWidget = useWorkspace((s) => s.activateWidget);

  const [side, setSide] = useState<Side>('buy');
  const [riskPercent, setRiskPercent] = useState('1');
  const [entry, setEntry] = useState('');
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');

  const entryPrice = useMemo(() => {
    const manual = toDecimalString(entry);
    if (manual) return manual;
    if (!quote) return null;
    return side === 'buy' ? quote.ask : quote.bid;
  }, [entry, quote, side]);

  const outputs = useMemo(
    () =>
      calculateRisk({
        symbol,
        equity: account?.equity ?? null,
        riskPercent,
        entryPrice,
        stopLossPrice: toDecimalString(stop),
        takeProfitPrice: toDecimalString(target),
        side,
      }),
    [symbol, account, riskPercent, entryPrice, stop, target, side],
  );

  const digits = symbol?.digits ?? 5;

  return (
    <div className="widget-scroll h-full space-y-2 p-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold">{displaySymbol}</span>
        <Badge tone="info">Estimate</Badge>
      </div>

      <div className="flex gap-1" role="group" aria-label="Trade direction">
        {(['buy', 'sell'] as const).map((option) => (
          <button
            key={option}
            aria-pressed={side === option}
            onClick={() => setSide(option)}
            className={`flex-1 rounded border px-2 py-1 text-2xs capitalize ${
              side === option
                ? option === 'buy'
                  ? 'border-[var(--positive)] bg-positive/12'
                  : 'border-[var(--negative)] bg-negative/12'
                : 'border-[var(--border-default)] text-text-muted'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <Field label="Risk (% of equity)" htmlFor="risk-percent">
        <Input
          id="risk-percent"
          inputMode="decimal"
          value={riskPercent}
          onChange={(event) => setRiskPercent(event.target.value)}
        />
      </Field>

      <Field
        label="Entry price"
        htmlFor="risk-entry"
        hint={entry === '' && quote ? 'Using the live price' : null}
      >
        <Input
          id="risk-entry"
          inputMode="decimal"
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          placeholder={quote ? Number(side === 'buy' ? quote.ask : quote.bid).toFixed(digits) : ''}
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Stop loss" htmlFor="risk-stop">
          <Input
            id="risk-stop"
            inputMode="decimal"
            value={stop}
            onChange={(event) => setStop(event.target.value)}
          />
        </Field>
        <Field label="Take profit" htmlFor="risk-target">
          <Input
            id="risk-target"
            inputMode="decimal"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </Field>
      </div>

      <dl className="space-y-1 border-t border-[var(--border-default)] pt-2 text-2xs">
        <Output label="Suggested volume">
          {outputs.suggestedVolume ? (
            <span className="tabular font-semibold">{outputs.suggestedVolume} lots</span>
          ) : (
            <Unavailable />
          )}
        </Output>
        <Output label="Risk amount">
          {outputs.riskAmount ? (
            <span className="tabular">
              {Number(outputs.riskAmount).toFixed(2)} {account?.currency ?? ''}
            </span>
          ) : (
            <Unavailable />
          )}
        </Output>
        <Output label="Stop distance">
          {outputs.stopDistance ? (
            <span className="tabular">{Number(outputs.stopDistance).toFixed(digits)}</span>
          ) : (
            <Unavailable />
          )}
        </Output>
        <Output label="Potential loss">
          {outputs.potentialLoss ? (
            <span className="tabular text-[var(--negative)]">
              −{Number(outputs.potentialLoss).toFixed(2)}
            </span>
          ) : (
            <Unavailable />
          )}
        </Output>
        <Output label="Potential profit">
          {outputs.potentialProfit ? (
            <span className="tabular text-[var(--positive)]">
              +{Number(outputs.potentialProfit).toFixed(2)}
            </span>
          ) : (
            <Unavailable />
          )}
        </Output>
        <Output label="Risk / reward">
          {outputs.riskRewardRatio ? (
            <span className="tabular">1 : {Number(outputs.riskRewardRatio).toFixed(2)}</span>
          ) : (
            <Unavailable />
          )}
        </Output>
      </dl>

      <Button
        variant="primary"
        size="md"
        className="w-full"
        disabled={outputs.suggestedVolume === null}
        onClick={() => {
          if (outputs.suggestedVolume === null) return;
          // Hand the sized position to the ticket as absolute PRICES, so the
          // trader is not retyping numbers between two panels.
          applyToTicket('the risk calculator', {
            volume: outputs.suggestedVolume,
            stopLoss: stop.trim(),
            stopLossUnit: 'price',
            takeProfit: target.trim(),
            takeProfitUnit: 'price',
            side,
          });
          activateWidget('order-ticket');
        }}
      >
        Apply to order ticket
      </Button>

      {outputs.suggestedVolume === null && (
        <p className="text-2xs text-text-muted">A volume is needed before this can be applied.</p>
      )}

      {outputs.unavailable.length > 0 && (
        <div className="flex items-start gap-1.5 rounded border border-[var(--border-default)] bg-[var(--background-tertiary)] p-1.5 text-2xs text-text-muted">
          <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <ul className="space-y-0.5">
            {outputs.unavailable.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-2xs text-text-muted">
        These figures are estimates. The trading server calculates the final margin, commission, and
        swap, and its values are authoritative.
      </p>
    </div>
  );
}

function Output({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text-primary">{children}</dd>
    </div>
  );
}
