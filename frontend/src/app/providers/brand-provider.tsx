import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { env } from '@/app/config/env';
import {
  applyBrandToDocument,
  DEFAULT_BRAND,
  loadBrandConfig,
  type BrandConfig,
} from '@/app/config/brand';
import { useSystemMessages } from '@/stores/system-messages-store';

/**
 * Runtime branding.
 *
 * Fetched once at startup and validated before anything reaches the DOM. A
 * fetch or validation failure falls back to the neutral default and records the
 * reason — an unbranded terminal is a truthful failure, a wrongly-branded one
 * is not.
 */

const BrandContext = createContext<BrandConfig>(DEFAULT_BRAND);

export function useBrand(): BrandConfig {
  return useContext(BrandContext);
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState<BrandConfig>(DEFAULT_BRAND);

  useEffect(() => {
    const controller = new AbortController();

    void loadBrandConfig(env().brandConfigUrl, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setBrand(result.brand);
      applyBrandToDocument(result.brand);

      if (result.usedFallback && env().brandConfigUrl) {
        useSystemMessages.getState().push({
          level: 'warning',
          scope: 'branding',
          text: `Broker branding could not be loaded (${result.reason ?? 'unknown'}); using defaults.`,
          code: 'brand.fallback',
          requestId: null,
        });
      }
    });

    return () => controller.abort();
  }, []);

  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}
