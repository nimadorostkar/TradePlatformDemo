import { z } from 'zod';
import type { GatewayHttpClient } from './http-client';
import type { SymbolSuffixPolicy } from '../mappers/symbol-suffix';

/**
 * Endpoints added alongside the core trading surface: price alerts, per-fill
 * executions, and server-side workspace persistence.
 *
 * Each is capability-gated — the gateway reports whether it serves them — so
 * nothing here is assumed to exist.
 */

// ── Alerts ───────────────────────────────────────────────────────────────────

export const alertSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((v) => String(v)),
  login: z.string(),
  symbol: z.string(),
  condition: z.enum(['above', 'below']),
  price: z.union([z.number(), z.string()]).transform((v) => String(v)),
  note: z.string().default(''),
  status: z.enum(['active', 'triggered']),
  createdAt: z.string().nullish(),
  triggeredAt: z.string().nullish(),
  triggeredPrice: z
    .union([z.number(), z.string(), z.null()])
    .nullish()
    .transform((v) => (v === null || v === undefined ? null : String(v))),
});

export const alertListSchema = z.array(alertSchema);
export type AlertDto = z.output<typeof alertSchema>;

export interface Alert {
  id: string;
  displaySymbol: string;
  gatewaySymbol: string;
  condition: 'above' | 'below';
  price: string;
  note: string;
  status: 'active' | 'triggered';
  createdAt: number | null;
  triggeredAt: number | null;
  /** The quote that crossed the level, not the level itself. */
  triggeredPrice: string | null;
}

function toEpoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapAlert(dto: AlertDto, suffix: SymbolSuffixPolicy): Alert {
  return {
    id: dto.id,
    gatewaySymbol: dto.symbol,
    displaySymbol: suffix.toDisplay(dto.symbol),
    condition: dto.condition,
    price: dto.price,
    note: dto.note,
    status: dto.status,
    createdAt: toEpoch(dto.createdAt),
    triggeredAt: toEpoch(dto.triggeredAt),
    triggeredPrice: dto.triggeredPrice,
  };
}

// ── Executions ───────────────────────────────────────────────────────────────

export const executionSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((v) => String(v)),
  orderId: z
    .union([z.number(), z.string()])
    .nullish()
    .transform((v) => (v === null || v === undefined ? null : String(v))),
  positionId: z
    .union([z.number(), z.string()])
    .nullish()
    .transform((v) => (v === null || v === undefined ? null : String(v))),
  symbol: z.string(),
  price: z.union([z.number(), z.string()]).transform((v) => String(v)),
  /** Already in LOTS; `qtyMt5` carries the raw unit value. */
  qty: z.union([z.number(), z.string()]).transform((v) => String(v)),
  qtyMt5: z.union([z.number(), z.string()]).nullish(),
  side: z.number(),
  /** Milliseconds; `timeSeconds` is the same instant in seconds. */
  time: z.number(),
  timeSeconds: z.number().nullish(),
  commission: z.union([z.number(), z.string()]).nullish(),
  swap: z.union([z.number(), z.string()]).nullish(),
  profit: z.union([z.number(), z.string()]).nullish(),
  entry: z.number().nullish(),
  comment: z.string().nullish(),
});

export const executionListSchema = z.array(executionSchema);
export type ExecutionDto = z.output<typeof executionSchema>;

// ── Workspace ────────────────────────────────────────────────────────────────

const workspaceResponseSchema = z.union([
  z.object({ document: z.unknown().nullish() }).passthrough(),
  z.null(),
  z.unknown(),
]);

export class FeaturesApi {
  constructor(private readonly http: GatewayHttpClient) {}

  async listAlerts(
    login: string,
    suffix: SymbolSuffixPolicy,
    signal?: AbortSignal,
  ): Promise<Alert[]> {
    const response = await this.http.request({
      endpoint: 'alert-list',
      path: '/api/Alert/list',
      query: { login },
      schema: alertListSchema,
      signal,
    });
    return response.data.map((dto) => mapAlert(dto, suffix));
  }

  async createAlert(
    input: {
      login: string;
      gatewaySymbol: string;
      condition: 'above' | 'below';
      price: string;
      note: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.request({
      endpoint: 'alert-create',
      path: '/api/Alert/create',
      method: 'POST',
      body: {
        login: input.login,
        symbol: input.gatewaySymbol,
        condition: input.condition,
        price: Number(input.price),
        note: input.note,
      },
      schema: z.unknown(),
      signal,
    });
  }

  async deleteAlert(login: string, id: string, signal?: AbortSignal): Promise<void> {
    await this.http.request({
      endpoint: 'alert-delete',
      path: '/api/Alert/delete',
      method: 'DELETE',
      // login is required as well as id: an id alone would let one trader
      // delete another's alert.
      query: { id, login },
      schema: z.unknown(),
      signal,
    });
  }

  /** Per-fill executions after a cursor, for the chart's execution markers. */
  async executionsSince(
    login: string,
    afterSeconds: number,
    limit = 200,
    signal?: AbortSignal,
  ): Promise<ExecutionDto[]> {
    const response = await this.http.request({
      endpoint: 'executions-since',
      path: '/api/Deal/since',
      query: { login, after: afterSeconds, limit },
      schema: executionListSchema,
      signal,
    });
    return response.data;
  }

  /** The stored workspace document, or null when none has been saved. */
  async getWorkspace(login: string, signal?: AbortSignal): Promise<unknown | null> {
    const response = await this.http.request({
      endpoint: 'workspace-get',
      path: '/api/Workspace/get',
      query: { login },
      schema: workspaceResponseSchema,
      signal,
      // Layout sync is a convenience; it must not sign the trader out.
      tolerateUnauthorized: true,
    });
    const data = response.data;
    if (data && typeof data === 'object' && 'document' in data) {
      return (data as { document: unknown }).document ?? null;
    }
    return data ?? null;
  }

  async saveWorkspace(login: string, document: unknown, signal?: AbortSignal): Promise<void> {
    await this.http.request({
      endpoint: 'workspace-save',
      path: '/api/Workspace/save',
      method: 'POST',
      body: { login, document },
      schema: z.unknown(),
      signal,
      tolerateUnauthorized: true,
    });
  }
}
