import { create } from 'zustand';
import {
  NO_CAPABILITIES,
  capabilityState,
  type ResolvedCapabilities,
} from '@/integrations/gateway/api/capabilities';
import type { Capability } from '@/workspace/registry/types';

/**
 * What this gateway deployment can actually do.
 *
 * Starts as "nothing optional available" so a feature is only ever offered
 * after the server has said it exists. Fetched once per session.
 */
interface CapabilitiesState {
  capabilities: ResolvedCapabilities;
  loaded: boolean;
  set: (capabilities: ResolvedCapabilities) => void;
  reset: () => void;
}

export const useCapabilities = create<CapabilitiesState>()((set) => ({
  capabilities: NO_CAPABILITIES,
  loaded: false,
  set: (capabilities) => set({ capabilities, loaded: true }),
  reset: () => set({ capabilities: NO_CAPABILITIES, loaded: false }),
}));

/** Resolves one widget's requirement against the gateway's answer. */
export function useCapability(required: Capability | undefined) {
  const capabilities = useCapabilities((s) => s.capabilities);
  const loaded = useCapabilities((s) => s.loaded);

  if (!required) return { enabled: true, reason: null, loaded };
  return { ...capabilityState(capabilities, required), loaded };
}
