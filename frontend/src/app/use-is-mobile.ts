import { useEffect, useState } from 'react';

/**
 * Media-query hook used by the app root to pick a shell.
 *
 * The threshold is 1024 px, NOT a phone width. Between 768 and 1024 px the
 * desktop shell degrades into the worst of both worlds — a watchlist with no
 * symbol names and a right column too narrow for the order ticket (BLK-03) —
 * so that band gets the single-column layout instead. 1023 px aligns exactly
 * with Tailwind's `lg:` breakpoint, which lets the header trim itself for the
 * mobile shell with pure CSS (`max-lg:`) and never disagree with this hook.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(max-width: 1023px)').matches,
  );

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(max-width: 1023px)');
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
