import { defineConfig, loadEnv } from 'vite';
import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const config = loadEnv(mode, process.cwd(), '');
  const gatewayProxyTarget = config.DEV_GATEWAY_PROXY_TARGET;
  const crmProxyTarget = config.DEV_CRM_PROXY_TARGET;

  // Mirror the production edge (deploy/edge/nginx.conf at the repository root): the gateway
  // is served same-origin under /gateway and the CRM under /crm, so the dev
  // server needs no CORS widening on either upstream. Each proxy is only
  // installed when its target is configured.
  const proxy: Record<string, ProxyOptions> = {};
  if (gatewayProxyTarget) {
    proxy['/gateway'] = {
      target: gatewayProxyTarget,
      changeOrigin: true,
      secure: true,
      // The /ws stream rides the same prefix, so upgrade requests must be
      // forwarded too — otherwise quotes silently never arrive in dev.
      ws: true,
      rewrite: (requestPath) => requestPath.replace(/^\/gateway/, ''),
    };
  }
  if (crmProxyTarget) {
    proxy['/crm'] = {
      target: crmProxyTarget,
      changeOrigin: true,
      secure: true,
      rewrite: (requestPath) => requestPath.replace(/^\/crm/, ''),
    };
  }

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 3100,
      strictPort: true,
      proxy: Object.keys(proxy).length > 0 ? proxy : undefined,
    },
    // Bind explicitly so Playwright's 127.0.0.1 health poll succeeds; the
    // default `localhost` can resolve to ::1 only.
    preview: { port: 3100, strictPort: true, host: '127.0.0.1' },
    build: {
      target: 'es2022',
      sourcemap: mode !== 'production',
      rollupOptions: {
        output: {
          // Keep heavy reusable dependencies separate from application code so
          // their cache lifetime and bundle cost remain measurable.
          manualChunks: {
            query: ['@tanstack/react-query', '@tanstack/react-table', '@tanstack/react-virtual'],
            decimal: ['decimal.js'],
          },
        },
      },
    },
    publicDir: 'public',
  };
});
