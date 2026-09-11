import type { RegionState } from '../persistence/schema';
import type { WidgetRegistry } from '../registry/types';

/**
 * How much room a region's groups actually need.
 *
 * Widgets have always declared `minimumSize` — 260px for the order ticket, for
 * instance — and nothing read it. Every panel got a flat 8% floor instead, so
 * stacking Order + Risk + Alerts in the right rail squeezed each below what it
 * needs: the volume-lot buttons clipped mid-row and the tab strip was cut off.
 * A clipped volume selector on a live-money order form is a safety problem, not
 * a cosmetic one — the trader can still submit, just not see what they picked.
 */

/** Fallback for a widget that declares no minimum. Enough for a header and a row. */
const DEFAULT_WIDGET_MINIMUM_PX = 120;

/**
 * What one group needs.
 *
 * Widgets in a group are TABS — one is visible at a time — so the group needs
 * the largest of its members, not their sum. Summing would reserve room for
 * panels nobody can see.
 */
export function groupMinimumPx(
  widgetIds: readonly string[],
  registry: WidgetRegistry,
  isAvailable: (widgetId: string) => boolean = () => true,
): number {
  let required = 0;
  for (const id of widgetIds) {
    const definition = registry.get(id);
    if (!definition) continue; // unknown id: not rendered, so it needs nothing
    // Nor does a widget the gateway cannot serve: it is filtered out of the
    // render, so reserving room for it would shrink the panels that DO show —
    // the opposite of the point.
    if (!isAvailable(id)) continue;
    required = Math.max(required, definition.minimumSize ?? DEFAULT_WIDGET_MINIMUM_PX);
  }
  return required;
}

/**
 * What a whole region needs along its variable axis.
 *
 * Groups STACK, so their minimums add up — this is the number that decides
 * whether the region can honour every panel at once.
 */
export function regionMinimumPx(
  state: RegionState,
  registry: WidgetRegistry,
  isAvailable: (widgetId: string) => boolean = () => true,
): number {
  let required = 0;
  for (const group of state.groups) {
    if (group.widgetIds.length === 0) continue;
    required += groupMinimumPx(group.widgetIds, registry, isAvailable);
  }
  return required;
}

/**
 * A group's floor as a PERCENTAGE, which is the only unit this version of
 * react-resizable-panels accepts.
 *
 * Returns 0 when the container has not been measured yet: a floor computed
 * against a zero height would be meaningless, and briefly having no floor is
 * better than pinning every panel to 100% on the first paint.
 */
export function groupMinSizePercent(groupMinPx: number, containerPx: number): number {
  if (containerPx <= 0 || groupMinPx <= 0) return 0;
  // Never let one group's floor exceed the whole region, which would make the
  // layout unsatisfiable and let the library fall back to its own defaults.
  return Math.min(100, (groupMinPx / containerPx) * 100);
}

/**
 * The height the panel stack should actually occupy.
 *
 * Equal to the container while everything fits — the normal case, unchanged.
 * When the declared minimums do not fit, the stack grows past the container and
 * the wrapper scrolls, so panels stay legible instead of being squeezed into
 * clipping. Scrolling a dock is a mild inconvenience; a half-visible volume
 * selector is a trade placed at a size the trader could not read.
 */
export function regionContentPx(requiredPx: number, containerPx: number): number {
  if (containerPx <= 0) return 0;
  return Math.max(containerPx, requiredPx);
}

/** True when the region cannot show every group at its declared minimum. */
export function regionOverflows(requiredPx: number, containerPx: number): boolean {
  return containerPx > 0 && requiredPx > containerPx;
}
