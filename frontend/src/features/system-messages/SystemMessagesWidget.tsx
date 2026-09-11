import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { Badge, Button, EmptyState } from '@/components/ui/primitives';
import { env } from '@/app/config/env';
import { useServices } from '@/app/providers/services';
import {
  selectMessages,
  useSystemMessages,
  type MessageLevel,
} from '@/stores/system-messages-store';

/**
 * Client diagnostics.
 *
 * Everything shown here is already redacted at the store boundary. The
 * subscription table lists CANONICAL KEYS, never connect URLs — a URL would
 * carry the access token.
 */

const LEVEL_TONE: Record<MessageLevel, 'neutral' | 'positive' | 'negative' | 'warning' | 'info'> = {
  info: 'info',
  success: 'positive',
  warning: 'warning',
  error: 'negative',
};

export default function SystemMessagesWidget() {
  const messages = useSystemMessages(selectMessages);
  const clear = useSystemMessages((s) => s.clear);
  const markRead = useSystemMessages((s) => s.markRead);
  const services = useServices();
  const config = env();

  const [levelFilter, setLevelFilter] = useState<MessageLevel | 'all'>('all');
  const [subscriptions, setSubscriptions] = useState(() => services.pool.statuses());

  useEffect(() => {
    markRead();
  }, [markRead]);

  // Poll the pool rather than subscribing: connection state changes are rare
  // and this widget is often not visible.
  useEffect(() => {
    const timer = setInterval(() => setSubscriptions(services.pool.statuses()), 2000);
    return () => clearInterval(timer);
  }, [services]);

  const filtered = useMemo(
    () => (levelFilter === 'all' ? messages : messages.filter((m) => m.level === levelFilter)),
    [messages, levelFilter],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-2 py-1">
        <select
          aria-label="Filter messages by level"
          value={levelFilter}
          onChange={(event) => setLevelFilter(event.target.value as MessageLevel | 'all')}
          className="h-5 rounded border border-[var(--border-default)] bg-[var(--background-tertiary)] px-1 text-2xs"
        >
          <option value="all">All levels</option>
          <option value="error">Errors</option>
          <option value="warning">Warnings</option>
          <option value="info">Info</option>
          <option value="success">Success</option>
        </select>
        <span className="text-2xs text-text-muted">
          v{config.appVersion} · {config.appEnv}
        </span>
        <Button size="xs" variant="ghost" onClick={clear} className="ml-auto">
          <Trash2 className="h-2.5 w-2.5" aria-hidden />
          Clear
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_auto]">
        <div className="widget-scroll min-h-0">
          {filtered.length === 0 ? (
            <EmptyState
              title="No messages"
              description="Connection and order events appear here."
            />
          ) : (
            <ul className="divide-y divide-[var(--border-default)]">
              {filtered.map((message) => (
                <li key={message.id} className="flex gap-2 px-2 py-1 text-2xs">
                  <span className="tabular shrink-0 text-text-muted">
                    {new Date(message.at).toLocaleTimeString()}
                  </span>
                  <Badge tone={LEVEL_TONE[message.level]}>{message.scope}</Badge>
                  <span className="min-w-0 flex-1 break-words text-text-secondary">
                    {message.text}
                  </span>
                  {message.requestId && (
                    <span
                      className="tabular shrink-0 text-text-muted"
                      title={`Request ${message.requestId}`}
                    >
                      {message.requestId.slice(0, 8)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className="widget-scroll w-64 shrink-0 border-l border-[var(--border-default)] p-2">
          <h2 className="mb-1 text-2xs font-medium text-text-secondary">Live subscriptions</h2>
          {subscriptions.length === 0 ? (
            <p className="text-2xs text-text-muted">No active subscriptions.</p>
          ) : (
            <ul className="space-y-1">
              {subscriptions.map((status) => (
                <li key={status.key} className="text-2xs">
                  <div className="flex items-center gap-1">
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        status.state === 'connected'
                          ? 'bg-[var(--positive)]'
                          : status.state === 'stale' || status.state === 'reconnecting'
                            ? 'bg-[var(--warning)]'
                            : 'bg-[var(--negative)]',
                      )}
                      aria-hidden
                    />
                    <span className="text-text-secondary">{status.state}</span>
                    {status.attempts > 0 && (
                      <span className="text-text-muted">· {status.attempts} retries</span>
                    )}
                  </div>
                  {/* The canonical key — deliberately not the URL, which
                      would contain the access token. */}
                  <p className="truncate text-text-muted" title={status.key}>
                    {status.key}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
