import { useEffect, useState } from 'react';

/**
 * Notices when the deployed build is no longer the one this tab is running.
 *
 * A tab left open from before a deploy keeps running the bundle it loaded —
 * `index.html` is served `no-store`, so a RELOAD always gets the current one,
 * but a tab that is never reloaded never asks. That cost a full QA cycle: a
 * tester on a warm tab reported a shipped feature as "not implemented", and
 * nothing on screen could have told them otherwise.
 *
 * The check is a conditional GET of `index.html`; the hashed script it
 * references IS the build identity, so a change in that reference means a new
 * deployment. Failures are ignored — this is an informational nicety, and a
 * flaky network must never nag a trader mid-session.
 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const SCRIPT_REF = /assets\/(index-[A-Za-z0-9_-]+\.js)/;

async function deployedBuild(signal: AbortSignal): Promise<string | null> {
  const response = await fetch(`${import.meta.env.BASE_URL}?build-check=1`, {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) return null;
  return SCRIPT_REF.exec(await response.text())?.[1] ?? null;
}

export function useStaleBuildCheck(): boolean {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    // The bundle this tab is RUNNING, read from its own script tag rather than
    // a build-time constant, so it cannot drift from reality.
    const running = SCRIPT_REF.exec(
      [...document.querySelectorAll('script[src]')]
        .map((s) => s.getAttribute('src') ?? '')
        .join(' '),
    )?.[1];
    if (!running) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = async () => {
      try {
        const deployed = await deployedBuild(controller.signal);
        if (deployed && deployed !== running) setStale(true);
      } catch {
        /* offline, blocked, or aborted — say nothing */
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void check(), CHECK_INTERVAL_MS);
    };

    timer = setTimeout(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);

  return stale;
}
