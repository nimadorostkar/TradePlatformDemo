import type { Quote } from '@/domain/common/models';
import type { TvBarDto } from '@/integrations/gateway/contracts/schemas';

/**
 * Bars for the chart, independent of any charting library.
 *
 * `time` is the bucket START in unix SECONDS (UTC). The gateway speaks seconds
 * on the wire; keeping seconds end to end avoids the ms/s conversions that
 * produced off-by-1000 bars in the past.
 */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * Chart intervals, in the notation the workspace persists: minutes as a bare
 * number, then '1D' | '1W' | '1M'.
 */
export const INTERVALS = ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M'] as const;
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_LABELS: Record<Interval, string> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '30': '30m',
  '60': '1h',
  '240': '4h',
  '1D': '1D',
  '1W': '1W',
  '1M': '1M',
};

export function isInterval(value: string): value is Interval {
  return (INTERVALS as readonly string[]).includes(value);
}

/** Daily-and-up intervals come from the daily history endpoint and stream. */
export function isDailyInterval(interval: Interval): boolean {
  return interval === '1D' || interval === '1W' || interval === '1M';
}

/** Seconds per bucket; months are approximated (only used to size requests). */
export function intervalSeconds(interval: Interval): number {
  switch (interval) {
    case '1D':
      return 86_400;
    case '1W':
      return 7 * 86_400;
    case '1M':
      return 30 * 86_400;
    default:
      return Number(interval) * 60;
  }
}

/**
 * The start of the bucket containing `timeSeconds`, in UTC. Weeks start on
 * Monday and months on the 1st — the same rule the gateway applies when it
 * aggregates (transform.BucketStart), so a streamed daily bar lands in the
 * same weekly/monthly candle history put it in.
 */
export function bucketStart(timeSeconds: number, interval: Interval): number {
  const date = new Date(timeSeconds * 1000);
  switch (interval) {
    case '1D':
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
    case '1W': {
      const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
      const sinceMonday = (date.getUTCDay() + 6) % 7;
      return day - sinceMonday * 86_400;
    }
    case '1M':
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
    default: {
      const size = intervalSeconds(interval);
      return Math.floor(timeSeconds / size) * size;
    }
  }
}

/** Gateway DTO (numbers or numeric strings) → Bar. Drops rows that are not bars. */
export function fromDto(dto: TvBarDto): Bar | null {
  const bar: Bar = {
    time: Number(dto.time),
    open: Number(dto.open),
    high: Number(dto.high),
    low: Number(dto.low),
    close: Number(dto.close),
  };
  if (![bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) return null;
  if (bar.time <= 0) return null;
  if (dto.volume !== null && dto.volume !== undefined) {
    const volume = Number(dto.volume);
    if (Number.isFinite(volume)) bar.volume = volume;
  }
  return bar;
}

/**
 * Sorts by time and collapses duplicate timestamps (last wins) — a charting
 * library rejects unsorted or duplicated data outright, and the gateway can
 * hand back a forming bar twice across a page boundary.
 */
export function normalize(bars: readonly Bar[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of bars) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * True when intraday history came back as raw M1 rather than aggregated to the
 * interval — the shape a gateway without the `resolution` parameter returns.
 * Any two bars closer together than one bucket cannot both be bucket starts.
 */
export function looksLikeRawM1(bars: readonly Bar[], interval: Interval): boolean {
  if (isDailyInterval(interval) || interval === '1' || bars.length < 2) return false;
  const size = intervalSeconds(interval);
  for (let i = 1; i < bars.length; i += 1) {
    if (bars[i]!.time - bars[i - 1]!.time < size) return true;
  }
  return false;
}

/** Rolls chronologically ordered finer bars into `interval` buckets. */
export function aggregate(bars: readonly Bar[], interval: Interval): Bar[] {
  const result: Bar[] = [];
  for (const bar of bars) {
    const time = bucketStart(bar.time, interval);
    const current = result[result.length - 1];
    if (!current || current.time !== time) {
      result.push({ ...bar, time });
      continue;
    }
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
    if (current.volume !== undefined || bar.volume !== undefined) {
      current.volume = (current.volume ?? 0) + (bar.volume ?? 0);
    }
  }
  return result;
}

/**
 * Merges a streamed bar into the series' last candle: same bucket → the
 * candle is extended; a later bucket → a new candle; an earlier bucket →
 * ignored (a late frame must never rewrite drawn history).
 */
export function mergeStreamBar(
  last: Bar | undefined,
  incoming: Bar,
  interval: Interval,
): Bar | null {
  const time = bucketStart(incoming.time, interval);
  if (!last || time > last.time) return { ...incoming, time };
  if (time < last.time) return null;
  return {
    time,
    open: last.open,
    high: Math.max(last.high, incoming.high),
    low: Math.min(last.low, incoming.low),
    close: incoming.close,
    volume:
      last.volume === undefined && incoming.volume === undefined
        ? undefined
        : Math.max(last.volume ?? 0, incoming.volume ?? 0),
  };
}

/**
 * The price a quote contributes to the forming candle, or null when it carries
 * none. MT5 leaves `last` at 0 for most FX symbols (there is no last trade on a
 * quote-driven instrument), so bid — what the bars are built from upstream —
 * is the stand-in.
 */
export function formingPrice(quote: Pick<Quote, 'bid' | 'last'>): number | null {
  const last = Number(quote.last);
  if (Number.isFinite(last) && last > 0) return last;
  const bid = Number(quote.bid);
  if (Number.isFinite(bid) && bid > 0) return bid;
  return null;
}

/**
 * Applies a tick to the forming candle. Intraday only: a daily bucket's
 * boundary is a broker-timezone question the gateway owns, so daily candles
 * move only when the gateway streams them.
 */
export function applyTick(
  last: Bar | undefined,
  price: number,
  atSeconds: number,
  interval: Interval,
): Bar | null {
  if (isDailyInterval(interval)) return null;
  const time = bucketStart(atSeconds, interval);
  if (!last || time > last.time) {
    return { time, open: price, high: price, low: price, close: price };
  }
  if (time < last.time) return null;
  return {
    ...last,
    high: Math.max(last.high, price),
    low: Math.min(last.low, price),
    close: price,
  };
}
