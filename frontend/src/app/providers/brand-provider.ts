import { createContext, useContext } from 'react';
import { DEFAULT_BRAND, type BrandConfig } from '@/app/config/brand';

/**
 * Runtime branding.
 *
 * Fetched once at startup and validated before anything reaches the DOM. A
 * fetch or validation failure falls back to the neutral default and records the
 * reason — an unbranded terminal is a truthful failure, a wrongly-branded one
 * is not.
 */

/** Provided by <BrandProvider> (BrandProvider.tsx); read with useBrand. */
export const BrandContext = createContext<BrandConfig>(DEFAULT_BRAND);

export function useBrand(): BrandConfig {
  return useContext(BrandContext);
}
