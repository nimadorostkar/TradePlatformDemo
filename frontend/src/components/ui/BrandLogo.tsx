import { useState, type ImgHTMLAttributes } from 'react';
import { brandLogoUrl, type BrandLogoVariant } from '@/app/config/brand';
import { useBrand } from '@/app/providers/brand-provider';
import { useResolvedTheme } from '@/app/providers/use-resolved-theme';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt' | 'onError'> & {
  variant: BrandLogoVariant;
  /** Called once if the asset fails to load, so the caller can show its text fallback. */
  onFail?: () => void;
};

/**
 * The broker's logo in the right colourway for the current theme.
 *
 * A broken brand asset must never leave a broken-image glyph in the header or
 * the middle of the loading screen: the element hides itself and tells the
 * caller, which falls back to the platform name.
 */
export function BrandLogo({ variant, onFail, className, ...rest }: Props) {
  const brand = useBrand();
  const theme = useResolvedTheme();
  const src = brandLogoUrl(brand, variant, theme);
  const [failed, setFailed] = useState<string | null>(null);

  if (failed === src) return null;

  return (
    <img
      {...rest}
      src={src}
      alt={brand.brokerName}
      className={className}
      onError={() => {
        setFailed(src);
        onFail?.();
      }}
    />
  );
}
