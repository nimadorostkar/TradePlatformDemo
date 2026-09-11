import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import { env, EnvValidationError } from '@/app/config/env';
import { loadTradingView } from '@/integrations/tradingview/types';
import '@/styles/global.css';

/**
 * Entry point.
 *
 * Configuration is validated FIRST. A misconfigured build fails loudly here
 * with the exact problem, rather than surfacing later as a confusing network
 * error against a wrong or insecure endpoint.
 */
function bootstrap(): void {
  const container = document.getElementById('root');
  if (!container) throw new Error('#root element is missing from index.html');

  try {
    env();
  } catch (error) {
    container.innerHTML = '';
    const pre = document.createElement('pre');
    pre.style.cssText =
      'padding:24px;font:13px/1.5 ui-monospace,monospace;color:#ea3943;white-space:pre-wrap';
    pre.textContent =
      error instanceof EnvValidationError ? error.message : `Configuration error: ${String(error)}`;
    container.appendChild(pre);
    return;
  }

  // Start executing the chart library NOW, while the session bootstrap runs.
  // The preload hint in index.html fetches the bytes; this parses them and
  // resolves the module-level singleton that ChartWorkspace later awaits, so
  // by the time the terminal mounts the library is simply already there.
  // Fire-and-forget: a failure here surfaces exactly as before, when the
  // chart itself awaits the same promise and shows its error state.
  void loadTradingView(env().tradingViewLibraryPath).catch(() => {});

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

bootstrap();
