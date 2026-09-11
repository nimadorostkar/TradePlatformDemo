import type { ComponentType, LazyExoticComponent } from 'react';

/**
 * Widget registry types.
 *
 * The workspace is data, not JSX. A widget declares where it may live and what
 * backend capability it needs; the layout engine decides where it actually is.
 * This is what makes layouts saveable, migratable, and capability-gated without
 * touching component code.
 */

export type RegionId = 'left' | 'right' | 'bottom' | 'center-overlay';

/**
 * Backend capabilities a widget can require. A widget whose capability is not
 * available renders a truthful "unavailable" state — it is never shown working
 * against fabricated data.
 */
export type Capability =
  | 'market-depth' // /api/Tick/get_marketdepth — shape unverified
  | 'position-sizing' // gateway supplies tick size AND tick value
  | 'price-alerts' // no persistence/execution API exists
  | 'economic-calendar' // no gateway endpoint
  | 'news' // no gateway endpoint
  | 'trading' // account is not investor/read-only
  | 'history'; // /api/Deal/get_page

export interface WidgetDefinition {
  id: string;
  title: string;
  /** Short label for narrow tab strips. */
  shortTitle?: string;
  icon: ComponentType<{ className?: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- widget props are heterogeneous by design; each widget validates its own.
  lazyComponent: LazyExoticComponent<ComponentType<any>>;
  allowedRegions: readonly RegionId[];
  defaultRegion: RegionId;
  /** Minimum size in px along the region's variable axis. */
  minimumSize?: number;
  requiredCapability?: Capability;
  /** Only one instance may exist across the whole workspace. */
  singleton?: boolean;
  /** Hidden from the "add widget" menu (e.g. the chart itself). */
  systemWidget?: boolean;
  description?: string;
}

export type WidgetRegistry = ReadonlyMap<string, WidgetDefinition>;

export function createRegistry(definitions: readonly WidgetDefinition[]): WidgetRegistry {
  const map = new Map<string, WidgetDefinition>();
  for (const definition of definitions) {
    if (map.has(definition.id)) {
      throw new Error(`Duplicate widget id in registry: ${definition.id}`);
    }
    if (!definition.allowedRegions.includes(definition.defaultRegion)) {
      throw new Error(
        `Widget ${definition.id}: defaultRegion "${definition.defaultRegion}" is not in allowedRegions`,
      );
    }
    map.set(definition.id, definition);
  }
  return map;
}
