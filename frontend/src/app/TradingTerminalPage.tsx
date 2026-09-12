import { useEffect, useState } from 'react';
import { useAccountSync } from '@/app/providers/use-account-sync';
import { useTradeNotifications } from '@/app/providers/use-trade-notifications';
import { useAlertNotifications } from '@/app/providers/use-alert-notifications';
import { Toaster } from '@/components/ui/Toaster';
import { ResizeOrderConfirm } from '@/features/pending-orders/ResizeOrderConfirm';
import { CommandPalette } from '@/app/CommandPalette';
import { MobileTerminal } from '@/app/MobileTerminal';
import { useIsMobile } from '@/app/use-is-mobile';
import { useUrlStateSync, type MobileTab } from '@/app/url-state';
import { TerminalHeader } from '@/app/TerminalHeader';
import { TerminalShell } from '@/workspace/layout/TerminalShell';
import { widgetRegistry } from '@/workspace/widgets/registry';
import { useWorkspace } from '@/workspace/layout/workspace-store';

/**
 * The authenticated terminal.
 *
 * Owns the account synchronisation lifecycle and picks between the desktop
 * shell and the mobile navigation model.
 */
export function TradingTerminalPage() {
  useAccountSync();
  useTradeNotifications();
  useAlertNotifications();

  const isMobile = useIsMobile();
  const theme = useWorkspace((s) => s.workspace.theme);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>('chart');

  // Symbol and (on the phone shell) tab live in the query string, so Back
  // walks recent views instead of ejecting to about:blank and a symbol can be
  // shared by pasting the address bar (HGH-03).
  useUrlStateSync(isMobile ? mobileTab : null, setMobileTab);

  // Theme is applied to the document root so the token layer and the chart
  // palette stay in step.
  useEffect(() => {
    const resolved =
      theme === 'system'
        ? typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : theme;
    document.documentElement.dataset.theme = resolved;
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--background-primary)]">
      {/* MED-12: a keyboard user's first Tab offers a way past the header's
          controls, and the content region is a real landmark. */}
      <a
        href="#terminal-main"
        className="sr-only rounded bg-[var(--brand-primary)] px-2 py-1 text-2xs text-white focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        Skip to terminal
      </a>
      <TerminalHeader onOpenCommandPalette={() => setPaletteOpen(true)} />

      <main id="terminal-main" aria-label="Trading terminal" className="min-h-0 flex-1">
        {isMobile ? (
          <MobileTerminal tab={mobileTab} onTabChange={setMobileTab} />
        ) : (
          <TerminalShell registry={widgetRegistry} />
        )}
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Toaster />
      {/* Raised from the broker adapter, which the charting library's own
          modify dialog calls into and which has nowhere to render itself. */}
      <ResizeOrderConfirm />
    </div>
  );
}
