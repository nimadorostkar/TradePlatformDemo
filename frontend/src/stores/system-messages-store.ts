import { create } from 'zustand';
import { env } from '@/app/config/env';
import type { TradingError } from '@/domain/common/errors';

/**
 * Client diagnostics feed backing the System Messages widget.
 *
 * REDACTION IS THE POINT: nothing here may contain an access token, a
 * credential, a full authenticated URL, or a complete account payload. Entries
 * carry a request id and a code so support can correlate with gateway logs
 * without the browser ever holding the sensitive value.
 */

export type MessageLevel = 'info' | 'success' | 'warning' | 'error';

export interface SystemMessage {
  id: string;
  at: number;
  level: MessageLevel;
  /** Short scope, e.g. `websocket`, `order`, `auth`. */
  scope: string;
  text: string;
  code: string | null;
  requestId: string | null;
  appVersion: string;
}

const MAX_MESSAGES = 300;

/** Defence in depth: strip anything token-shaped before it is ever stored. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /access_token=[^&\s]+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /eyJ[A-Za-z0-9._-]{20,}/g, // a bare JWT
];

export function redactText(input: string): string {
  let output = input;
  for (const pattern of TOKEN_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
  }
  return output;
}

interface SystemMessagesState {
  messages: SystemMessage[];
  unreadErrorCount: number;
  push: (message: Omit<SystemMessage, 'id' | 'at' | 'appVersion'>) => void;
  pushError: (scope: string, error: TradingError) => void;
  markRead: () => void;
  clear: () => void;
}

export const useSystemMessages = create<SystemMessagesState>()((set) => ({
  messages: [],
  unreadErrorCount: 0,

  push: (message) =>
    set((state) => {
      const entry: SystemMessage = {
        ...message,
        text: redactText(message.text),
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: Date.now(),
        appVersion: env().appVersion,
      };
      const messages = [entry, ...state.messages].slice(0, MAX_MESSAGES);
      return {
        messages,
        unreadErrorCount:
          message.level === 'error' ? state.unreadErrorCount + 1 : state.unreadErrorCount,
      };
    }),

  pushError: (scope, error) =>
    set((state) => {
      const entry: SystemMessage = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: Date.now(),
        level: 'error',
        scope,
        text: redactText(error.detail ? `${error.message} (${error.detail})` : error.message),
        code: error.code,
        requestId: error.requestId,
        appVersion: env().appVersion,
      };
      return {
        messages: [entry, ...state.messages].slice(0, MAX_MESSAGES),
        unreadErrorCount: state.unreadErrorCount + 1,
      };
    }),

  markRead: () => set({ unreadErrorCount: 0 }),
  clear: () => set({ messages: [], unreadErrorCount: 0 }),
}));

export const selectMessages = (s: SystemMessagesState) => s.messages;
export const selectUnreadErrors = (s: SystemMessagesState) => s.unreadErrorCount;
