import { describe, expect, it } from 'vitest';
import { brokerZoneLabel, formatBrokerDate, formatBrokerTime, withZone } from './broker-time';

// The report's own trade: the table showed 8/24/2026, 7:13:11 PM in a
// browser-local zone, the export wrote 2026-08-24T15:43:11.000Z, and the
// filename was dated the 25th. All three are this instant.
const TRADE_MS = Date.UTC(2026, 7, 24, 15, 43, 11);
const BROKER_UTC_PLUS_3 = 3 * 3600;

describe('brokerZoneLabel', () => {
  it('names a whole-hour offset', () => {
    expect(brokerZoneLabel(BROKER_UTC_PLUS_3)).toBe('UTC+3');
    expect(brokerZoneLabel(-5 * 3600)).toBe('UTC-5');
  });

  it('names a half-hour offset without rounding it away', () => {
    expect(brokerZoneLabel(-4.5 * 3600)).toBe('UTC-4:30');
    expect(brokerZoneLabel(5.75 * 3600)).toBe('UTC+5:45');
  });

  it('says UTC when the gateway reports no offset', () => {
    expect(brokerZoneLabel(null)).toBe('UTC');
    expect(brokerZoneLabel(0)).toBe('UTC');
  });
});

describe('formatBrokerTime', () => {
  it('renders the broker wall clock, not the browser one', () => {
    expect(formatBrokerTime(TRADE_MS, BROKER_UTC_PLUS_3)).toBe('2026-08-24 18:43:11');
  });

  it('orders the date big-endian, so it cannot be read as 8 April', () => {
    expect(formatBrokerTime(TRADE_MS, null)).toBe('2026-08-24 15:43:11');
  });

  it('rolls the date when the offset crosses midnight', () => {
    const lateUtc = Date.UTC(2026, 7, 24, 22, 30, 0);
    expect(formatBrokerTime(lateUtc, BROKER_UTC_PLUS_3)).toBe('2026-08-25 01:30:00');
  });

  it('rolls backwards for a western broker', () => {
    const earlyUtc = Date.UTC(2026, 7, 24, 2, 0, 0);
    expect(formatBrokerTime(earlyUtc, -5 * 3600)).toBe('2026-08-23 21:00:00');
  });
});

describe('formatBrokerDate', () => {
  it('dates an export by the clock the interface showed', () => {
    // The report exported at 20:28 local and got a file dated the 25th while
    // the screen said the 24th. On the broker clock it is the 24th.
    expect(formatBrokerDate(TRADE_MS, BROKER_UTC_PLUS_3)).toBe('2026-08-24');
  });
});

describe('withZone', () => {
  it('makes a column header state its own zone', () => {
    expect(withZone('Opened', BROKER_UTC_PLUS_3)).toBe('Opened (UTC+3)');
  });
});
