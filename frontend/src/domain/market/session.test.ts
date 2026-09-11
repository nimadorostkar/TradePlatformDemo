import { describe, expect, it } from 'vitest';
import { formatDuration, marketState, minutesUntilOpen, parseSession } from './session';

/**
 * Session strings come from `transform.ConvertSessionsMt5ToTv` in the gateway,
 * whose own test pins the format:
 *
 *     "0000-2359:1|0100-0200,1000-1100:3"
 *
 * Day digits are 1 = Sunday … 7 = Saturday.
 */

/** Builds an instant at a given weekday/time in a timezone, via a known UTC date. */
function at(iso: string): Date {
  return new Date(iso);
}

describe('parseSession', () => {
  it('parses the exact format the gateway emits', () => {
    const parsed = parseSession('0000-2359:1|0100-0200,1000-1100:3');
    expect(parsed).not.toBeNull();
    expect(parsed?.alwaysOpen).toBe(false);

    // Digit 1 → Sunday (0), digit 3 → Tuesday (2).
    expect(parsed?.days.map((d) => d.day)).toEqual([0, 2]);
    expect(parsed?.days[1]?.ranges).toHaveLength(2);
  });

  it('recognises 24x7', () => {
    expect(parseSession('24x7')?.alwaysOpen).toBe(true);
    expect(parseSession('24X7')?.alwaysOpen).toBe(true);
  });

  it('accepts a multi-day mask', () => {
    // Standard TradingView form, wider than what the gateway emits today.
    const parsed = parseSession('0930-1600:23456');
    expect(parsed?.days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5]);
  });

  it('applies ranges to every day when no mask is given', () => {
    expect(parseSession('0900-1700')?.days).toHaveLength(7);
  });

  it('represents an overnight range as wrapping past midnight', () => {
    const parsed = parseSession('2200-0600:2');
    const range = parsed?.days[0]?.ranges[0];
    expect(range?.startMinute).toBe(22 * 60);
    // 06:00 next day == 1800 minutes from the session's own midnight.
    expect(range?.endMinute).toBe(30 * 60);
  });

  it('returns null for input it cannot understand', () => {
    // Unknown must never be silently treated as closed.
    expect(parseSession('')).toBeNull();
    expect(parseSession(null)).toBeNull();
    expect(parseSession('not-a-session')).toBeNull();
    expect(parseSession('0930:2')).toBeNull();
    expect(parseSession('0930-1600:9')).toBeNull();
    expect(parseSession('9999-8888:2')).toBeNull();
  });
});

describe('marketState', () => {
  it('reports open for a 24x7 symbol at any time', () => {
    expect(marketState('24x7', 'Etc/UTC', at('2026-08-01T03:14:00Z'))).toBe('open');
  });

  it('reports open inside the session window', () => {
    // 2026-07-29 is a Wednesday → TradingView digit 4.
    expect(marketState('0900-1700:4', 'Etc/UTC', at('2026-07-29T12:00:00Z'))).toBe('open');
  });

  it('reports closed outside the session window', () => {
    expect(marketState('0900-1700:4', 'Etc/UTC', at('2026-07-29T18:00:00Z'))).toBe('closed');
  });

  it('reports closed on a day the session does not cover', () => {
    // Sunday, session only lists Wednesday.
    expect(marketState('0900-1700:4', 'Etc/UTC', at('2026-08-02T12:00:00Z'))).toBe('closed');
  });

  it('evaluates in the SYMBOL timezone, not the browser one', () => {
    // 22:00 UTC on Wednesday is 01:00 Thursday in Istanbul (UTC+3), which is
    // outside a Wednesday 09:00–17:00 session in that zone.
    const session = '0900-1700:4';
    expect(marketState(session, 'Europe/Istanbul', at('2026-07-29T22:00:00Z'))).toBe('closed');
    // 09:00 UTC is 12:00 Istanbul on Wednesday — open.
    expect(marketState(session, 'Europe/Istanbul', at('2026-07-29T09:00:00Z'))).toBe('open');
  });

  it('handles an overnight session spilling into the next day', () => {
    // Monday 22:00 → Tuesday 06:00. Digit 2 = Monday.
    const session = '2200-0600:2';
    // Monday 23:00 UTC — inside.
    expect(marketState(session, 'Etc/UTC', at('2026-07-27T23:00:00Z'))).toBe('open');
    // Tuesday 03:00 UTC — still inside, via the wrap.
    expect(marketState(session, 'Etc/UTC', at('2026-07-28T03:00:00Z'))).toBe('open');
    // Tuesday 08:00 UTC — after the wrap ends.
    expect(marketState(session, 'Etc/UTC', at('2026-07-28T08:00:00Z'))).toBe('closed');
  });

  it('handles several ranges in one day', () => {
    const session = '0100-0200,1000-1100:3'; // Tuesday
    expect(marketState(session, 'Etc/UTC', at('2026-07-28T01:30:00Z'))).toBe('open');
    expect(marketState(session, 'Etc/UTC', at('2026-07-28T05:00:00Z'))).toBe('closed');
    expect(marketState(session, 'Etc/UTC', at('2026-07-28T10:30:00Z'))).toBe('open');
  });

  it('returns unknown — never closed — when it cannot tell', () => {
    // Guessing "closed" would block a trade the server would have accepted.
    expect(marketState(null, 'Etc/UTC')).toBe('unknown');
    expect(marketState('nonsense', 'Etc/UTC')).toBe('unknown');
    expect(marketState('0900-1700:4', 'Not/AZone')).toBe('unknown');
  });

  it('treats the boundary as inclusive of open and exclusive of close', () => {
    expect(marketState('0900-1700:4', 'Etc/UTC', at('2026-07-29T09:00:00Z'))).toBe('open');
    expect(marketState('0900-1700:4', 'Etc/UTC', at('2026-07-29T17:00:00Z'))).toBe('closed');
  });
});

describe('minutesUntilOpen', () => {
  it('reports the wait until the next session', () => {
    // Wednesday 07:00 UTC, session opens 09:00 → 120 minutes.
    expect(minutesUntilOpen('0900-1700:4', 'Etc/UTC', at('2026-07-29T07:00:00Z'))).toBe(120);
  });

  it('crosses into a later day when needed', () => {
    // Wednesday 18:00, next session is the following Wednesday 09:00.
    const minutes = minutesUntilOpen('0900-1700:4', 'Etc/UTC', at('2026-07-29T18:00:00Z'));
    expect(minutes).toBe(6 * 24 * 60 + 15 * 60);
  });

  it('returns null while open or when unknown', () => {
    expect(minutesUntilOpen('0900-1700:4', 'Etc/UTC', at('2026-07-29T12:00:00Z'))).toBeNull();
    expect(minutesUntilOpen('24x7', 'Etc/UTC')).toBeNull();
    expect(minutesUntilOpen('nonsense', 'Etc/UTC')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats minutes, hours and days', () => {
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(120)).toBe('2h');
    expect(formatDuration(135)).toBe('2h 15m');
    expect(formatDuration(60 * 30)).toBe('1d 6h');
  });
});
