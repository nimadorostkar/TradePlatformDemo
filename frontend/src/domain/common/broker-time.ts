/**
 * One clock for every broker-stamped time in the interface, and it says which.
 *
 * The same trade used to appear as two different times: the table rendered
 * `toLocaleString()` — the browser's zone, in whatever order the browser's
 * locale prefers — while the CSV wrote ISO UTC, and neither said which zone it
 * was in. A trader in Tehran reconciling against the broker's own platform saw
 * three clocks for one fill, and the export was even dated a day ahead of the
 * screen.
 *
 * Broker server time is the one traders expect, because it is the clock the
 * trading server stamps deals with and the one every other MetaTrader client
 * shows. It is used here for anything the SERVER timestamped. Client-side
 * things — the journal the user types, the session log — stay on the user's
 * own clock, because those are events in the room they are sitting in.
 *
 * The format is `YYYY-MM-DD HH:mm:ss`, deliberately not locale-ordered: the
 * client base is international and `8/24/2026` reads as 8 April to most of it.
 */

const SECOND_MS = 1000;

/** Names the zone for a column header or a filename: "UTC+3", "UTC-4:30". */
export function brokerZoneLabel(offsetSeconds: number | null): string {
  if (offsetSeconds === null || offsetSeconds === 0) return 'UTC';
  const sign = offsetSeconds < 0 ? '-' : '+';
  const total = Math.abs(Math.trunc(offsetSeconds / 60));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${String(minutes).padStart(2, '0')}`;
}

/** The wall-clock fields the broker's clock would be showing at `msEpoch`. */
function brokerParts(msEpoch: number, offsetSeconds: number | null) {
  const shifted = new Date(msEpoch + (offsetSeconds ?? 0) * SECOND_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** `2026-08-24 18:13:11` on the broker's clock. */
export function formatBrokerTime(msEpoch: number, offsetSeconds: number | null): string {
  const p = brokerParts(msEpoch, offsetSeconds);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** `2026-08-24` on the broker's clock — for export filenames. */
export function formatBrokerDate(msEpoch: number, offsetSeconds: number | null): string {
  const p = brokerParts(msEpoch, offsetSeconds);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** `Opened (UTC+3)` — a column header that states its own zone. */
export function withZone(label: string, offsetSeconds: number | null): string {
  return `${label} (${brokerZoneLabel(offsetSeconds)})`;
}
