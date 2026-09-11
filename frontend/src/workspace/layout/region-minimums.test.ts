import { describe, expect, it } from 'vitest';
import {
  groupMinSizePercent,
  groupMinimumPx,
  regionContentPx,
  regionMinimumPx,
  regionOverflows,
} from './region-minimums';
import { widgetRegistry } from '@/workspace/widgets/registry';
import type { RegionState } from '../persistence/schema';
import type { WidgetDefinition, WidgetRegistry } from '../registry/types';

/**
 * Widgets declared `minimumSize` and nothing read it. Every panel got a flat 8%
 * floor, so stacking Order + Risk + Alerts in the right rail squeezed each below
 * what it needs: the volume-lot buttons clipped mid-row and the tab strip was
 * cut off. On a live-money order form that is a safety problem — the trader can
 * still submit, they just cannot see the size they picked.
 */

function fakeRegistry(sizes: Record<string, number | undefined>): WidgetRegistry {
  return new Map(
    Object.entries(sizes).map(([id, minimumSize]) => [
      id,
      { id, minimumSize } as unknown as WidgetDefinition,
    ]),
  );
}

function region(groups: { id: string; widgetIds: string[] }[]): RegionState {
  return {
    collapsed: false,
    groups: groups.map((g) => ({ ...g, size: 50, activeWidgetId: g.widgetIds[0] })),
  } as unknown as RegionState;
}

describe('region minimums', () => {
  it('takes the LARGEST minimum within a group, not the sum', () => {
    // Widgets in a group are tabs — one visible at a time. Summing would
    // reserve room for panels nobody can see.
    const registry = fakeRegistry({ a: 260, b: 120, c: 180 });
    expect(groupMinimumPx(['a', 'b', 'c'], registry)).toBe(260);
  });

  it('adds group minimums across a region, because groups stack', () => {
    const registry = fakeRegistry({ order: 260, risk: 180, alerts: 160 });
    const state = region([
      { id: 'g1', widgetIds: ['order'] },
      { id: 'g2', widgetIds: ['risk'] },
      { id: 'g3', widgetIds: ['alerts'] },
    ]);
    expect(regionMinimumPx(state, registry)).toBe(600);
  });

  it('gives an undeclared widget a usable floor rather than zero', () => {
    const registry = fakeRegistry({ mystery: undefined });
    expect(groupMinimumPx(['mystery'], registry)).toBeGreaterThan(0);
  });

  it('ignores ids the registry does not know', () => {
    // A stale layout can name a widget this build no longer ships. It is not
    // rendered, so it must not reserve space.
    const registry = fakeRegistry({ real: 200 });
    expect(groupMinimumPx(['real', 'removed-in-a-later-build'], registry)).toBe(200);
  });

  // The case from the report, against the REAL registry.
  it('detects that Order + Risk + Alerts do not fit a short right rail', () => {
    const state = region([
      { id: 'g1', widgetIds: ['order-ticket'] },
      { id: 'g2', widgetIds: ['risk-calculator'] },
      { id: 'g3', widgetIds: ['alerts'] },
    ]);
    const required = regionMinimumPx(state, widgetRegistry);

    // The order ticket alone declares 260, which is most of the requirement —
    // and it is the panel whose volume-lot buttons were clipping.
    expect(required).toBeGreaterThanOrEqual(widgetRegistry.get('order-ticket')?.minimumSize ?? 0);

    // A right rail shorter than the stack needs — a laptop viewport with three
    // panels open, which is exactly the reported configuration.
    const shortRail = required - 80;
    expect(regionOverflows(required, shortRail)).toBe(true);
    // Scrolls instead of squeezing: the stack keeps its full height.
    expect(regionContentPx(required, shortRail)).toBe(required);

    // And the order ticket's own floor survives that, which is the whole point:
    // it can no longer be dragged or squeezed below what it declared.
    const orderFloor = groupMinSizePercent(
      groupMinimumPx(['order-ticket'], widgetRegistry),
      regionContentPx(required, shortRail),
    );
    expect((orderFloor / 100) * required).toBeCloseTo(
      widgetRegistry.get('order-ticket')?.minimumSize ?? 0,
      6,
    );
  });

  it('leaves a region that fits completely alone', () => {
    const registry = fakeRegistry({ a: 100, b: 100 });
    const state = region([
      { id: 'g1', widgetIds: ['a'] },
      { id: 'g2', widgetIds: ['b'] },
    ]);
    const tallRail = 900;

    expect(regionOverflows(regionMinimumPx(state, registry), tallRail)).toBe(false);
    // Height unchanged, so nothing about the common case shifts.
    expect(regionContentPx(regionMinimumPx(state, registry), tallRail)).toBe(tallRail);
  });

  describe('percentage floors', () => {
    it('converts a px minimum against the measured container', () => {
      expect(groupMinSizePercent(260, 1040)).toBeCloseTo(25, 10);
    });

    it('never exceeds the whole region', () => {
      // An unsatisfiable floor makes the library fall back to its own defaults,
      // which is exactly the flat-percentage behaviour being replaced.
      expect(groupMinSizePercent(900, 400)).toBe(100);
    });

    it('claims nothing before the container has been measured', () => {
      // Dividing by a zero height would pin every panel to 100% on first paint.
      expect(groupMinSizePercent(260, 0)).toBe(0);
      expect(regionContentPx(600, 0)).toBe(0);
      expect(regionOverflows(600, 0)).toBe(false);
    });

    it('stacked minimums each keep their share once the stack has room to scroll', () => {
      // Three groups needing 260/180/160 in a 500px rail: the stack grows to
      // 600, and each floor is its true share of THAT — so none is squeezed
      // below what it declared.
      const required = 600;
      const floors = [260, 180, 160].map((px) => groupMinSizePercent(px, required));

      expect(floors.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
      for (const floor of floors) expect(floor).toBeGreaterThan(0);
    });
  });
});

describe('unavailable widgets reserve no space', () => {
  // A layout persists widget ids. A panel whose feature the gateway stopped
  // serving is filtered out of the render, so counting it toward the region's
  // minimum would shrink the panels that DO show — the opposite of the point.
  const registry = fakeRegistry({ order: 260, risk: 180, alerts: 160 });
  const state = region([
    { id: 'g1', widgetIds: ['order'] },
    { id: 'g2', widgetIds: ['risk'] },
    { id: 'g3', widgetIds: ['alerts'] },
  ]);

  it('counts everything when all are available', () => {
    expect(regionMinimumPx(state, registry)).toBe(600);
  });

  it('drops a gated widget from the requirement', () => {
    const available = (id: string) => id !== 'risk';
    expect(regionMinimumPx(state, registry, available)).toBe(420);
  });

  it('lets a group fall to zero when every member is gated', () => {
    const available = (id: string) => id === 'order';
    expect(groupMinimumPx(['risk', 'alerts'], registry, available)).toBe(0);
    expect(regionMinimumPx(state, registry, available)).toBe(260);
  });

  it('can turn an overflowing region back into one that fits', () => {
    // The concrete win: hiding the gated panel can remove the scroll entirely.
    const rail = 500;
    expect(regionOverflows(regionMinimumPx(state, registry), rail)).toBe(true);
    expect(
      regionOverflows(
        regionMinimumPx(state, registry, (id) => id !== 'risk'),
        rail,
      ),
    ).toBe(false);
  });
});

/**
 * MED-08 residual (retest 2026-08-26): panel heights were usable in the
 * measured layout, but the improvement came from flex sizing — computed
 * min-height was 0 on every panel, so a column holding more panels could
 * squeeze one back below usability.
 *
 * The floor is real: a region that cannot honour every declared minimum sizes
 * its content to the SUM and scrolls, so each panel keeps its height instead
 * of every panel shrinking. These pin the two halves of that.
 */
describe('every panel declares a usable floor', () => {
  it('no widget silently inherits the fallback minimum', () => {
    // Six panels declared nothing and inherited 120px — the very number the
    // launch-readiness report called unusable for Details and DOM.
    const missing = [...widgetRegistry.values()]
      .filter((definition) => definition.minimumSize === undefined)
      .map((definition) => definition.id);

    expect(missing).toEqual([]);
  });

  it('every declared minimum is worth opening the panel for', () => {
    for (const definition of widgetRegistry.values()) {
      expect.soft(definition.minimumSize ?? 0).toBeGreaterThanOrEqual(160);
    }
  });

  it('a column of every panel needs more room than it has, and says so', () => {
    // The acceptance condition: with everything stacked at a 900px viewport,
    // the region reports that it cannot honour the minimums — which is what
    // makes it scroll at full height rather than compress each panel.
    const groups = [...widgetRegistry.values()].map((definition, index) => ({
      id: `g${index}`,
      widgetIds: [definition.id],
      activeWidgetId: definition.id,
      size: 100 / widgetRegistry.size,
    }));
    const state = { collapsed: false, size: 100, groups } as unknown as RegionState;

    const required = regionMinimumPx(state, widgetRegistry);
    const viewport = 900;

    expect(required).toBeGreaterThan(viewport);
    expect(regionOverflows(required, viewport)).toBe(true);
    // Content is sized to the requirement, so no panel is squeezed below its
    // own floor — the column scrolls instead.
    expect(regionContentPx(required, viewport)).toBe(required);
  });
});
