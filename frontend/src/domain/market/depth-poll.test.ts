import { describe, expect, it } from 'vitest';
import type { MarketDepthDto } from '@/integrations/gateway/contracts/schemas';
import {
  DEPTH_POLL_BASE_MS,
  DEPTH_POLL_MAX_MS,
  isEmptyBook,
  nextDepthPollDelay,
} from './depth-poll';

function book(overrides: Partial<MarketDepthDto> = {}): MarketDepthDto {
  return {
    symbol: 'EURUSD',
    volumeUnit: 'lots',
    bids: [],
    asks: [],
    crossed: false,
    unclassified: 0,
    ...overrides,
  } as MarketDepthDto;
}

const level = { price: '1.1000', volume: '10', market: false };

describe('market-depth poll pacing', () => {
  it('holds the base cadence while the book has levels', () => {
    const full = book({ bids: [level], asks: [{ ...level, price: '1.1002' }] });
    expect(nextDepthPollDelay(DEPTH_POLL_BASE_MS, full)).toBe(DEPTH_POLL_BASE_MS);
  });

  it('counts a one-sided book as live', () => {
    // Liquidity on one side only is still a publishing feed.
    expect(isEmptyBook(book({ bids: [level] }))).toBe(false);
    expect(nextDepthPollDelay(12_000, book({ asks: [level] }))).toBe(DEPTH_POLL_BASE_MS);
  });

  it('backs off geometrically while the book stays empty', () => {
    // This is the whole point: a feed that publishes no depth was being asked
    // ~2x/second forever.
    let delay = DEPTH_POLL_BASE_MS;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      delay = nextDepthPollDelay(delay, book());
      seen.push(delay);
    }
    expect(seen).toEqual([3_000, 6_000, 12_000, 24_000, 30_000, 30_000]);
  });

  it('never exceeds the cap', () => {
    expect(nextDepthPollDelay(DEPTH_POLL_MAX_MS, book())).toBe(DEPTH_POLL_MAX_MS);
  });

  it('recovers immediately when depth appears', () => {
    // A symbol can start publishing mid-session (a market opening), so backoff
    // must be reversible without a reload.
    expect(nextDepthPollDelay(DEPTH_POLL_MAX_MS, book({ bids: [level] }))).toBe(DEPTH_POLL_BASE_MS);
  });

  it('treats a missing response as empty, so failures back off too', () => {
    expect(isEmptyBook(undefined)).toBe(true);
    expect(nextDepthPollDelay(DEPTH_POLL_BASE_MS, undefined)).toBe(3_000);
  });
});
