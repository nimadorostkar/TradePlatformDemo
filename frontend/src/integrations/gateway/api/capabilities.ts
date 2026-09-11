import { z } from 'zod';
import type { GatewayHttpClient } from './http-client';
import type { Capability } from '@/workspace/registry/types';

/**
 * Gateway capability discovery.
 *
 * `GET /api/Capabilities` reports what this deployment can actually do, so the
 * terminal gates features on an answer instead of on a 404 or a hardcoded
 * assumption. A gateway that predates the endpoint reports nothing, and every
 * optional feature stays off — the safe default.
 */

const capabilitySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().nullish(),
});

/**
 * The gateway's trusted runtime identity (ENV-001). The live-money banner is
 * rendered from THIS — the deployment the app actually reached — never from a
 * build-time variable that may describe a different one.
 */
const environmentSchema = z.object({
  name: z.string(),
  tradingMode: z.string(),
  mt5Server: z.string().optional(),
  buildSha: z.string().optional(),
  apiVersion: z.string().optional(),
});

export const capabilitiesSchema = z
  .object({
    alerts: capabilitySchema.optional(),
    workspace: capabilitySchema.optional(),
    news: capabilitySchema.optional(),
    calendar: capabilitySchema.optional(),
    executions: capabilitySchema.optional(),
    marketDepth: capabilitySchema.optional(),
    positionSizing: capabilitySchema.optional(),
    leverage: capabilitySchema.optional(),
    tradeIdempotency: capabilitySchema.optional(),
    environment: environmentSchema.optional(),
    sessionCookies: capabilitySchema.optional(),
  })
  .passthrough();

export type GatewayCapabilities = z.infer<typeof capabilitiesSchema>;

export interface CapabilityState {
  enabled: boolean;
  /** Why it is unavailable, when the gateway explained. */
  reason: string | null;
}

/** The gateway-reported runtime identity, or null on an older gateway. */
export interface GatewayEnvironment {
  name: string;
  /** "live" | "demo" — anything unrecognised is treated as live. */
  tradingMode: string;
  mt5Server: string | null;
  buildSha: string | null;
}

/** Every optional feature, resolved to an explicit on/off with a reason. */
export interface ResolvedCapabilities {
  alerts: CapabilityState;
  workspace: CapabilityState;
  news: CapabilityState;
  calendar: CapabilityState;
  executions: CapabilityState;
  marketDepth: CapabilityState;
  positionSizing: CapabilityState;
  /** Whether this broker lets a trader change their own account leverage. */
  leverage: CapabilityState;
  tradeIdempotency: CapabilityState;
  /** Null when the gateway predates the environment block. */
  environment: GatewayEnvironment | null;
}

const UNAVAILABLE: CapabilityState = {
  enabled: false,
  reason: 'This trading server does not report the feature.',
};

export const NO_CAPABILITIES: ResolvedCapabilities = {
  alerts: UNAVAILABLE,
  workspace: UNAVAILABLE,
  news: UNAVAILABLE,
  calendar: UNAVAILABLE,
  executions: UNAVAILABLE,
  marketDepth: UNAVAILABLE,
  positionSizing: UNAVAILABLE,
  leverage: UNAVAILABLE,
  tradeIdempotency: UNAVAILABLE,
  environment: null,
};

function resolve(entry: { enabled: boolean; reason?: string | null } | undefined): CapabilityState {
  if (!entry) return UNAVAILABLE;
  return { enabled: entry.enabled, reason: entry.reason?.trim() || null };
}

export function resolveCapabilities(raw: GatewayCapabilities): ResolvedCapabilities {
  return {
    alerts: resolve(raw.alerts),
    workspace: resolve(raw.workspace),
    news: resolve(raw.news),
    calendar: resolve(raw.calendar),
    executions: resolve(raw.executions),
    marketDepth: resolve(raw.marketDepth),
    positionSizing: resolve(raw.positionSizing),
    leverage: resolve(raw.leverage),
    tradeIdempotency: resolve(raw.tradeIdempotency),
    environment: raw.environment
      ? {
          name: raw.environment.name,
          tradingMode: raw.environment.tradingMode,
          mt5Server: raw.environment.mt5Server ?? null,
          buildSha: raw.environment.buildSha ?? null,
        }
      : null,
  };
}

export class CapabilitiesApi {
  constructor(private readonly http: GatewayHttpClient) {}

  /**
   * Fetches the capability map.
   *
   * Never throws: an older gateway answers 404, and a terminal that refuses to
   * start because it could not ask about OPTIONAL features would be worse than
   * one that runs with them off.
   */
  async fetch(signal?: AbortSignal): Promise<ResolvedCapabilities> {
    try {
      const response = await this.http.request({
        endpoint: 'capabilities',
        path: '/api/Capabilities',
        schema: capabilitiesSchema,
        signal,
        timeoutMs: 8_000,
        // Discovering optional features must never end a valid session.
        tolerateUnauthorized: true,
      });
      return resolveCapabilities(response.data);
    } catch {
      return NO_CAPABILITIES;
    }
  }
}

/** Maps a widget's declared requirement onto the gateway's answer. */
export function capabilityState(
  capabilities: ResolvedCapabilities,
  required: Capability,
): CapabilityState {
  switch (required) {
    case 'market-depth':
      return capabilities.marketDepth;
    case 'position-sizing':
      return capabilities.positionSizing;
    case 'price-alerts':
      return capabilities.alerts;
    case 'news':
      return capabilities.news;
    case 'economic-calendar':
      return capabilities.calendar;
    // Trading and history are core, not optional add-ons; they are gated by the
    // account's own permissions rather than by a deployment flag.
    case 'trading':
    case 'history':
      return { enabled: true, reason: null };
    default:
      return UNAVAILABLE;
  }
}
