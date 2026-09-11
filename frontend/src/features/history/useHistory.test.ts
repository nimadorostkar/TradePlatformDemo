import { describe, expect, it } from 'vitest';
import { brokerDayStartSeconds } from './useHistory';

describe('brokerDayStartSeconds', () => {
  // 2026-08-17T06:30:00Z on a UTC+3 broker: the broker's calendar already
  // reads 09:30 on the 17th, so its day began at 2026-08-16T21:00:00Z.
  it('cuts the day on the BROKER midnight, not UTC midnight', () => {
    const now = Date.UTC(2026, 7, 17, 6, 30, 0) / 1000;
    const start = brokerDayStartSeconds(now, 3 * 3600);
    expect(start).toBe(Date.UTC(2026, 7, 16, 21, 0, 0) / 1000);
  });

  it('degrades to the UTC day when no offset is known', () => {
    const now = Date.UTC(2026, 7, 17, 6, 30, 0) / 1000;
    expect(brokerDayStartSeconds(now, 0)).toBe(Date.UTC(2026, 7, 17, 0, 0, 0) / 1000);
  });

  it('handles the hours where broker and UTC dates differ', () => {
    // 22:30Z on the 16th is already 01:30 on the 17th for a +3 broker: the
    // broker day started half past one hours ago, at 21:00Z.
    const now = Date.UTC(2026, 7, 16, 22, 30, 0) / 1000;
    expect(brokerDayStartSeconds(now, 3 * 3600)).toBe(Date.UTC(2026, 7, 16, 21, 0, 0) / 1000);
  });

  it('supports negative offsets (a UTC-5 broker)', () => {
    // 02:00Z on the 17th is still 21:00 on the 16th for a -5 broker.
    const now = Date.UTC(2026, 7, 17, 2, 0, 0) / 1000;
    expect(brokerDayStartSeconds(now, -5 * 3600)).toBe(Date.UTC(2026, 7, 16, 5, 0, 0) / 1000);
  });

  it('is idempotent at the boundary itself', () => {
    const start = brokerDayStartSeconds(Date.UTC(2026, 7, 17, 6, 30, 0) / 1000, 3 * 3600);
    expect(brokerDayStartSeconds(start, 3 * 3600)).toBe(start);
  });
});
