import { useCallback, useSyncExternalStore } from 'react';

/**
 * The client area's own theme. It is a different product from the terminal
 * — a light, page-like site, as a broker's personal area is — so it does not
 * share the terminal's workspace theme (dark by default) and starts light.
 * The choice is a per-browser convenience kept in localStorage.
 */

export type ClientAreaTheme = 'light' | 'dark';

const KEY = 'pa.theme';
const DEFAULT: ClientAreaTheme = 'light';
const listeners = new Set<() => void>();

export function readClientAreaTheme(): ClientAreaTheme {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'dark' || stored === 'light' ? stored : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** Paints the theme onto the document so the token layer follows. */
export function applyClientAreaTheme(theme: ClientAreaTheme = readClientAreaTheme()): void {
  document.documentElement.dataset.theme = theme;
}

export function setClientAreaTheme(theme: ClientAreaTheme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* per-browser convenience only */
  }
  applyClientAreaTheme(theme);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useClientAreaTheme(): [ClientAreaTheme, (theme: ClientAreaTheme) => void] {
  const theme = useSyncExternalStore(subscribe, readClientAreaTheme, () => DEFAULT);
  const set = useCallback((next: ClientAreaTheme) => setClientAreaTheme(next), []);
  return [theme, set];
}
