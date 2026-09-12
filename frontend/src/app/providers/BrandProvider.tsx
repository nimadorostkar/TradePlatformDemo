import { useEffect, useState, type ReactNode } from 'react';
import { env } from '@/app/config/env';
import {
  applyBrandToDocument,
  DEFAULT_BRAND,
  loadBrandConfig,
  type BrandConfig,
} from '@/app/config/brand';
import { BrandContext } from '@/app/providers/brand-provider';
import { useSystemMessages } from '@/stores/system-messages-store';

/** Loads the runtime branding once at startup; see brand-provider.ts. */
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
