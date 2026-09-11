/**
 * A REST snapshot requested before a live frame arrived must not overwrite it.
 * Equality is treated conservatively: browser timestamps have millisecond
 * precision, so a frame observed in the same millisecond may still be newer.
 */
export function shouldApplyRestSnapshot(
  lastLiveFrameAt: number | null,
  requestStartedAt: number,
): boolean {
  return lastLiveFrameAt === null || lastLiveFrameAt < requestStartedAt;
}
