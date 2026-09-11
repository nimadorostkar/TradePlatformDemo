import { describe, expect, it } from 'vitest';
import {
  NO_CAPABILITIES,
  capabilitiesSchema,
  capabilityState,
  resolveCapabilities,
} from './capabilities';
import { widgetRegistry } from '@/workspace/widgets/registry';

/**
 * A feature the gateway cannot serve must be ABSENT, not present and broken.
 *
 * The Risk Calculator was the counter-example: position sizing needs a tick size
 * and a tick value, MT5 returns both as 0 on this feed, and the mapper
 * normalises a non-positive tick to null — so the panel rendered an explanation
 * of its own failure on every symbol while looking like a working feature. On a
 * trading terminal that is worse than an omission, because a trader reasonably
 * assumes a visible sizing tool works.
 */
/** Gateway JSON -> resolved capabilities, the way the app does it. */
function resolve(raw: unknown) {
  return resolveCapabilities(capabilitiesSchema.parse(raw));
}

describe('position-sizing capability', () => {
  it('is what the Risk Calculator declares it needs', () => {
    expect(widgetRegistry.get('risk-calculator')?.requiredCapability).toBe('position-sizing');
  });

  it('resolves from the gateway answer', () => {
    const capabilities = resolve({
      positionSizing: { enabled: true },
    });
    expect(capabilityState(capabilities, 'position-sizing').enabled).toBe(true);
  });

  it('carries the gateway reason through when disabled', () => {
    const reason = 'This trading server does not report tick size or tick value.';
    const capabilities = resolve({
      positionSizing: { enabled: false, reason },
    });
    const state = capabilityState(capabilities, 'position-sizing');

    expect(state.enabled).toBe(false);
    // The panel tells the trader what the SERVER said, not a generic apology.
    expect(state.reason).toBe(reason);
  });

  it('is off when a gateway predates the flag entirely', () => {
    // An older gateway omits the key. Defaulting to on would restore exactly the
    // broken-looking panel this gate exists to remove.
    const capabilities = resolve({ marketDepth: { enabled: true } });
    expect(capabilityState(capabilities, 'position-sizing').enabled).toBe(false);
  });

  it('starts off before any answer has arrived', () => {
    expect(capabilityState(NO_CAPABILITIES, 'position-sizing').enabled).toBe(false);
  });
});
