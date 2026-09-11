import { describe, expect, it } from 'vitest';
import { shouldApplyRestSnapshot } from './reconciliation-policy';

describe('shouldApplyRestSnapshot', () => {
  it('accepts a snapshot when no live frame has arrived', () => {
    expect(shouldApplyRestSnapshot(null, 1_000)).toBe(true);
  });

  it('accepts a snapshot when the last frame predates the request', () => {
    expect(shouldApplyRestSnapshot(999, 1_000)).toBe(true);
  });

  it('preserves a frame received during or after the request', () => {
    expect(shouldApplyRestSnapshot(1_000, 1_000)).toBe(false);
    expect(shouldApplyRestSnapshot(1_001, 1_000)).toBe(false);
  });
});
