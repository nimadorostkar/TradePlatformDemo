/**
 * A lazy chunk that 404s because a deploy replaced the hashed assets under a
 * running tab. Not a crash — a version skew.
 */
export function isStaleChunkError(error: Error): boolean {
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
    error.message,
  );
}

/**
 * Reloads once to pick up the current shell, and reports whether it did.
 *
 * The stamp stops a genuinely broken deploy from reload-looping: a second
 * failure inside a minute falls through to whatever error surface called this.
 */
export function reloadForStaleChunk(): boolean {
  const KEY = 'opotrade.chunk-reload-at';
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY) ?? 0);
  } catch {
    /* storage may be blocked; the reload is still worth attempting */
  }
  if (Date.now() - last <= 60_000) return false;
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* as above */
  }
  window.location.reload();
  return true;
}
