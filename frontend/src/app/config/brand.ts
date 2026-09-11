import { z } from 'zod';

/**
 * Runtime broker branding.
 *
 * The same build serves multiple brokers/environments: branding is fetched
 * from `VITE_BRAND_CONFIG_URL` at startup and validated before any of it
 * touches the DOM. If the fetch or validation fails we fall back to the safe
 * built-in TradePlatform identity rather than rendering a half-branded terminal.
 */

/** Only http(s) links are accepted; `javascript:` and `data:` are rejected. */
const safeUrl = z
  .string()
  .url()
  .refine((v) => /^https?:\/\//i.test(v), { message: 'must be an http(s) URL' });

/** A same-origin path or an http(s) URL — logos may be self-hosted. */
const assetRef = z.union([
  safeUrl,
  z.string().regex(/^\/[^/\\]/, 'must be an absolute same-origin path like /logo.svg'),
]);

const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'must be a hex colour');

export const brandConfigSchema = z.object({
  brokerName: z.string().min(1).max(80),
  platformName: z.string().min(1).max(80),
  logoUrl: assetRef,
  compactLogoUrl: assetRef.optional(),
  faviconUrl: assetRef.optional(),
  primaryColor: hexColor,
  secondaryColor: hexColor,
  legalLinks: z
    .array(z.object({ label: z.string().min(1).max(60), href: safeUrl }))
    .max(12)
    .default([]),
  /**
   * Where a visitor with no tradable account goes to open one. Optional like
   * every other outbound link: a broker that does not set it simply gets no
   * button, rather than one pointing somewhere invented.
   */
  createAccountUrl: safeUrl.optional(),
  /**
   * The sign-in page's escape routes (HGH-01). A login form with no way
   * forward for a forgotten password converts directly into support tickets.
   */
  forgotPasswordUrl: safeUrl.optional(),
  signUpUrl: safeUrl.optional(),
  supportUrl: safeUrl.optional(),
  depositUrl: safeUrl.optional(),
  withdrawalUrl: safeUrl.optional(),
  defaultTheme: z.enum(['dark', 'light', 'system']).default('dark'),
});

export type BrandConfig = z.infer<typeof brandConfigSchema>;

/**
 * Production fallback used when no runtime brand document is configured.
 */
export const DEFAULT_BRAND: BrandConfig = {
  brokerName: 'TradePlatform',
  platformName: 'TradePlatform',
  logoUrl: '/brand/tradeplatform-logo.svg',
  compactLogoUrl: '/brand/tradeplatform-logo.svg',
  faviconUrl: '/brand/tradeplatform-logo.svg',
  // #3366ee, not the old #3772ff: white button text on this colour measures
  // 4.91:1 where the old value sat at 4.19:1, below WCAG AA on the primary
  // call to action in both themes (HGH-04). Matches the token default.
  primaryColor: '#3366ee',
  secondaryColor: '#6c8cff',
  legalLinks: [],
  // No outbound links by default: the built-in identity belongs to no broker,
  // so there is nowhere truthful to send a visitor. A deployment enables
  // "Open an account", "Forgot password?" and "Contact support" by serving a
  // brand document (VITE_BRAND_CONFIG_URL) with its own portal URLs — the UI
  // hides each link whose URL is absent.
  defaultTheme: 'dark',
};

export async function loadBrandConfig(
  url: string | undefined,
  signal?: AbortSignal,
): Promise<{ brand: BrandConfig; usedFallback: boolean; reason?: string }> {
  if (!url) return { brand: DEFAULT_BRAND, usedFallback: true, reason: 'no VITE_BRAND_CONFIG_URL' };

  try {
    const response = await fetch(url, { signal, credentials: 'omit' });
    if (!response.ok) {
      return { brand: DEFAULT_BRAND, usedFallback: true, reason: `HTTP ${response.status}` };
    }
    const parsed = brandConfigSchema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        brand: DEFAULT_BRAND,
        usedFallback: true,
        reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
    }
    return { brand: parsed.data, usedFallback: false };
  } catch (error) {
    return {
      brand: DEFAULT_BRAND,
      usedFallback: true,
      reason: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

/** Pushes the validated brand colours into the token layer. */
export function applyBrandToDocument(brand: BrandConfig, doc: Document = document): void {
  const root = doc.documentElement;
  root.style.setProperty('--brand-primary', brand.primaryColor);
  root.style.setProperty('--brand-secondary', brand.secondaryColor);
  // The channel form feeds Tailwind's alpha-modified colours (bg-brand/10 and
  // friends). Overriding only the flat token would leave every tinted brand
  // surface on the PREVIOUS broker's colour.
  const hex = brand.primaryColor.replace('#', '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const channels = full
    .match(/../g)
    ?.map((pair) => parseInt(pair, 16))
    .join(' ');
  if (channels) root.style.setProperty('--brand-primary-rgb', channels);

  if (brand.faviconUrl) {
    const link =
      doc.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? doc.createElement('link');
    link.rel = 'icon';
    link.href = brand.faviconUrl;
    if (!link.parentNode) doc.head.appendChild(link);
  }
  doc.title = brand.platformName;
}
