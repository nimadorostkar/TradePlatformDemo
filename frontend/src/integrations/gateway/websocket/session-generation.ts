/**
 * Session generations.
 *
 * The gateway streams periodic SNAPSHOTS with no sequence id and no version.
 * That rules out true duplicate/out-of-order protection — there is nothing to
 * compare. What we CAN guarantee is that a frame produced for a previous
 * account (or a previous login) never lands in the current account's state.
 *
 * Every login, account switch, and reconnect increments the generation. Frames
 * and in-flight REST responses carry the generation they were requested under
 * and are dropped if it no longer matches.
 *
 * Guarantees this provides — and the ones it does not — are documented in
 * docs/architecture/realtime-reconciliation.md.
 */

export type Generation = number & { readonly __brand: 'Generation' };

export class SessionGenerationTracker {
  private current = 1 as Generation;
  private readonly listeners = new Set<(generation: Generation) => void>();

  get generation(): Generation {
    return this.current;
  }

  /** Starts a new generation. Everything from the old one becomes invalid. */
  advance(): Generation {
    this.current = (this.current + 1) as Generation;
    for (const listener of this.listeners) listener(this.current);
    return this.current;
  }

  isCurrent(generation: Generation): boolean {
    return generation === this.current;
  }

  onAdvance(listener: (generation: Generation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Buffers frames that arrive while the authoritative REST snapshot is still
 * loading, so an early frame is not lost and a late frame does not overwrite a
 * newer snapshot.
 *
 * Order of application on (re)connect:
 *   1. open the subscription (frames start buffering here)
 *   2. fetch the REST snapshot
 *   3. apply the REST snapshot
 *   4. apply the newest buffered frame for the CURRENT generation, if any
 *   5. switch to live application
 */
export class SnapshotGate<TFrame> {
  private buffered: { frame: TFrame; receivedAt: number } | null = null;
  private open = false;

  /** Called for each frame while the gate is closed. Keeps only the newest. */
  buffer(frame: TFrame, receivedAt: number): void {
    if (this.buffered === null || receivedAt >= this.buffered.receivedAt) {
      this.buffered = { frame, receivedAt };
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Opens the gate and returns the newest buffered frame, if one exists. */
  release(): { frame: TFrame; receivedAt: number } | null {
    this.open = true;
    const buffered = this.buffered;
    this.buffered = null;
    return buffered;
  }

  /** Closes the gate again (used on reconnect). */
  reset(): void {
    this.open = false;
    this.buffered = null;
  }
}

/** Marks a snapshot stale after a multiple of the expected server cadence. */
export function isStale(
  lastUpdateAt: number | null,
  staleAfterMs: number,
  now = Date.now(),
): boolean {
  if (lastUpdateAt === null) return true;
  return now - lastUpdateAt > staleAfterMs;
}
