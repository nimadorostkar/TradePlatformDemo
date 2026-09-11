import { z } from 'zod';
import { TradingError } from '@/domain/common/errors';

/**
 * The gateway envelope, verified against
 * `internal/httpapi/response/response.go` in tradeplatform-mt-socket-new:
 *
 *   { data: any, errorMessage: string|null, message: string|null, success: bool }
 *
 * Status convention is success→200 / failure→400 (`response.Write`), with
 * 401/403 coming from the auth middleware and 200 with a bare `{token}` body
 * from the two Authentication routes.
 */
export const gatewayEnvelopeSchema = z.object({
  data: z.unknown(),
  errorMessage: z.string().nullish(),
  message: z.string().nullish(),
  success: z.boolean(),
});

export type GatewayEnvelope = z.infer<typeof gatewayEnvelopeSchema>;

/**
 * Decode the `data` field.
 *
 * Why this exists: `internal/domain/domain.go#toEnvelope` sets
 * `Data: string(body)` for every "RAW_STRING" endpoint, so `data` arrives as a
 * JSON *string* containing JSON. Endpoints that transform (source=tv) or that
 * assign `json.RawMessage(body)` return a real object/array instead.
 *
 * We therefore decode AT MOST ONE layer, and only when the value is a string
 * that looks like JSON. Recursively parsing arbitrary strings would corrupt
 * legitimate string fields (a comment of "[1,2]" is a comment, not an array).
 */
export function decodeGatewayData(data: unknown): unknown {
  if (typeof data !== 'string') return data;

  const trimmed = data.trim();
  if (trimmed === '') return null;

  const first = trimmed[0];
  if (first !== '{' && first !== '[') return data;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // A string that merely starts with a brace but is not JSON stays a string.
    return data;
  }
}

/**
 * Some MT5 passthrough payloads wrap the useful value in `{ answer: ... }`
 * (see `rawAnswer` in internal/domain/order.go). Unwrap exactly one level when
 * present, otherwise return the value untouched.
 */
export function unwrapAnswer(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'answer' in value) {
    return (value as { answer: unknown }).answer;
  }
  return value;
}

/**
 * Validate a decoded payload against a schema, converting a mismatch into a
 * `contract` TradingError rather than letting malformed data reach the UI.
 */
export function parseContract<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
  context: { endpoint: string; requestId: string },
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw new TradingError({
    kind: 'contract',
    code: `contract.${context.endpoint}`,
    message: 'The trading server returned data this app does not understand.',
    detail: `${describeIssues(result.error)} — received ${describeShape(value)}`,
    requestId: context.requestId,
    retryable: false,
  });
}

/**
 * Flattens a Zod error into something a support report can act on.
 *
 * A `z.union` reports one top-level issue — "Invalid input" — and buries what
 * each branch actually objected to in `unionErrors`. Every trade result goes
 * through a union, so the diagnostic for the one endpoint where it matters most
 * used to read "(root): Invalid input" and named nothing at all.
 */
function describeIssues(error: z.ZodError): string {
  const seen = new Set<string>();

  const walk = (issues: z.ZodIssue[]): void => {
    for (const issue of issues) {
      if (issue.code === 'invalid_union') {
        for (const branch of issue.unionErrors) walk(branch.issues);
        continue;
      }
      seen.add(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  };
  walk(error.issues);

  return [...seen].slice(0, 6).join('; ') || 'schema mismatch';
}

/**
 * The payload's shape — key NAMES only, never values. Which fields arrived is
 * what identifies the sender; what they contain is the trader's own position
 * data and has no place in a diagnostics feed.
 */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value !== 'object') return typeof value;

  const keys = Object.keys(value as Record<string, unknown>);
  const shown = keys.slice(0, 12).join(', ');
  return `object{${shown}${keys.length > 12 ? `, +${keys.length - 12} more` : ''}}`;
}
