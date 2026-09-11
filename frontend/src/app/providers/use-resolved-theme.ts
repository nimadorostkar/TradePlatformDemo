import { useEffect, useState } from 'react';

/**
 * The theme the document is actually painted in.
 *
 * Read from `<html data-theme>` rather than the workspace store: the sign-in
 * screen and the loader render before a workspace exists, and the attribute is
 * the single place every theme decision (index.html default, the terminal's
 * system/light/dark resolution) ends up. Observed so a theme switch re-picks
 * the logo without a remount.
 */
export function useResolvedTheme(): 'dark' | 'light' {
  const read = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const [theme, setTheme] = useState<'dark' | 'light'>(read);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    setTheme(read());
    return () => observer.disconnect();
  }, []);

  return theme;
}
