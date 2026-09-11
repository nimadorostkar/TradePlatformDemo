/**
 * Trading-session parsing and market-open evaluation.
 *
 * Format produced by the gateway (`transform.ConvertSessionsMt5ToTv`):
 *
 *     0000-2359:1|0100-0200,1000-1100:3
 *
 *   - segments separated by `|`
 *   - each segment is one or more `HHMM-HHMM` ranges separated by `,`
 *   - followed by `:` and a day mask, where **1 = Sunday … 7 = Saturday**
 *   - the literal `24x7` means always open
 *
 * The gateway emits a single day digit per segment, but the wider TradingView
 * convention allows a mask like `:23456`, so both are accepted.
 *
 * Times are in the SYMBOL'S timezone, not the browser's — evaluating them
 * locally would put the open/close boundary hours off for most users.
 */

export interface SessionRange {
  /** Minutes from midnight, inclusive. */
  startMinute: number;
  /** Minutes from midnight, exclusive. Greater than 1440 when it wraps. */
  endMinute: number;
}

export interface SessionDay {
  /** 0 = Sunday … 6 = Saturday, matching `Date.getDay()`. */
  day: number;
  ranges: SessionRange[];
}

export interface ParsedSession {
  alwaysOpen: boolean;
  days: SessionDay[];
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * Parses a session string. Returns null when it cannot be understood — the
 * caller then treats market state as UNKNOWN rather than guessing "closed",
 * which would wrongly block trading.
 */
export function parseSession(session: string | null | undefined): ParsedSession | null {
  if (!session) return null;

  const trimmed = session.trim();
  if (trimmed === '') return null;
  if (/^24x7$/i.test(trimmed)) return { alwaysOpen: true, days: [] };

  const byDay = new Map<number, SessionRange[]>();

  for (const segment of trimmed.split('|')) {
    const part = segment.trim();
    if (part === '') continue;

    const [rangesText, daysText] = splitOnLastColon(part);
    const ranges = parseRanges(rangesText);
    if (ranges.length === 0) return null;

    // No day mask means the ranges apply to every day.
    const days = daysText === null ? [0, 1, 2, 3, 4, 5, 6] : parseDayMask(daysText);
    if (days === null) return null;

    for (const day of days) {
      const existing = byDay.get(day) ?? [];
      byDay.set(day, [...existing, ...ranges]);
    }
  }

  if (byDay.size === 0) return null;

  return {
    alwaysOpen: false,
    days: [...byDay.entries()]
      .map(([day, ranges]) => ({ day, ranges }))
      .sort((a, b) => a.day - b.day),
  };
}

function splitOnLastColon(part: string): [string, string | null] {
  const index = part.lastIndexOf(':');
  if (index === -1) return [part, null];
  return [part.slice(0, index), part.slice(index + 1)];
}

function parseRanges(text: string): SessionRange[] {
  const ranges: SessionRange[] = [];

  for (const chunk of text.split(',')) {
    const match = /^(\d{4})-(\d{4})$/.exec(chunk.trim());
    if (!match) return [];

    const start = toMinutes(match[1]!);
    const end = toMinutes(match[2]!);
    if (start === null || end === null) return [];

    // A range that ends at or before it starts runs past midnight into the
    // next day (e.g. 2200-0600). Represented by extending past 1440 so the
    // containment check stays a simple comparison.
    ranges.push({ startMinute: start, endMinute: end > start ? end : end + MINUTES_PER_DAY });
  }

  return ranges;
}

function toMinutes(hhmm: string): number | null {
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2, 4));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** `1` = Sunday in the TradingView convention; we normalise to 0 = Sunday. */
function parseDayMask(text: string): number[] | null {
  const days: number[] = [];
  for (const character of text.trim()) {
    const digit = Number(character);
    if (!Number.isInteger(digit) || digit < 1 || digit > 7) return null;
    days.push(digit - 1);
  }
  return days.length > 0 ? days : null;
}

export type MarketState = 'open' | 'closed' | 'unknown';

/** Wall-clock position within a timezone. */
interface ZonedNow {
  day: number; // 0 = Sunday
  minute: number; // minutes from midnight
}

/**
 * Reads the current weekday and minute-of-day in an IANA timezone.
 * Returns null if the timezone is not recognised by the runtime.
 */
export function zonedNow(timezone: string, now: Date = new Date()): ZonedNow | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);

    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);

    const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday ?? '');
    if (dayIndex === -1 || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;

    // `hour12: false` yields 24 for midnight in some runtimes.
    return { day: dayIndex, minute: (hour % 24) * 60 + minute };
  } catch {
    return null;
  }
}

/**
 * Whether the market is open for a symbol right now.
 *
 * Returns `unknown` — never `closed` — when the session or timezone cannot be
 * understood. Blocking a trade on a guess would be worse than letting the
 * server decide, and MT5 rejects genuinely-closed markets with retcode 10018.
 */
export function marketState(
  session: string | null | undefined,
  timezone: string | null | undefined,
  now: Date = new Date(),
): MarketState {
  const parsed = parseSession(session);
  if (!parsed) return 'unknown';
  if (parsed.alwaysOpen) return 'open';

  const zoned = zonedNow(timezone || 'Etc/UTC', now);
  if (!zoned) return 'unknown';

  for (const { day, ranges } of parsed.days) {
    for (const range of ranges) {
      // Same-day match.
      if (
        day === zoned.day &&
        zoned.minute >= range.startMinute &&
        zoned.minute < range.endMinute
      ) {
        return 'open';
      }
      // A range that wrapped past midnight also covers the START of the
      // following day.
      if (range.endMinute > MINUTES_PER_DAY) {
        const nextDay = (day + 1) % 7;
        if (nextDay === zoned.day && zoned.minute < range.endMinute - MINUTES_PER_DAY) {
          return 'open';
        }
      }
    }
  }

  return 'closed';
}

/**
 * Minutes until the next session opens, for a "reopens in…" hint.
 * Null when unknown or already open.
 */
export function minutesUntilOpen(
  session: string | null | undefined,
  timezone: string | null | undefined,
  now: Date = new Date(),
): number | null {
  const parsed = parseSession(session);
  if (!parsed || parsed.alwaysOpen) return null;

  const zoned = zonedNow(timezone || 'Etc/UTC', now);
  if (!zoned) return null;
  if (marketState(session, timezone, now) === 'open') return null;

  let best: number | null = null;

  // Scan the coming week; a symbol always reopens within it or never does.
  for (let offset = 0; offset < 8; offset++) {
    const day = (zoned.day + offset) % 7;
    const entry = parsed.days.find((d) => d.day === day);
    if (!entry) continue;

    for (const range of entry.ranges) {
      const absoluteOpen = offset * MINUTES_PER_DAY + range.startMinute;
      const delta = absoluteOpen - zoned.minute;
      if (delta > 0 && (best === null || delta < best)) best = delta;
    }
  }

  return best;
}

/** Human-readable "in 2h 15m" for the reopen hint. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
