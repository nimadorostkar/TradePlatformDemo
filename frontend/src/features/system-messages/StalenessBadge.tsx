import { useEffect, useState } from 'react';
import { env } from '@/app/config/env';
import { Badge } from '@/components/ui/primitives';
import type { DataFreshness } from '@/stores/trading-store';

/**
 * Truthful freshness indicator.
 *
 * A frozen price that LOOKS live is the most dangerous state a trading terminal
 * can be in. When the stream stops, this says so — with the age, so the trader
 * can judge how much to trust what is on screen.
 */
export function StalenessBadge({
  freshness,
  className,
}: {
  freshness: DataFreshness;
  className?: string;
}) {
  const staleAfterMs = env().quoteStaleAfterMs;
  const age = useAge(freshness.updatedAt);

  if (freshness.connection === 'connected' && age !== null && age < staleAfterMs) {
    return (
      <Badge tone="positive" className={className}>
        Live
      </Badge>
    );
  }

  if (freshness.connection === 'connecting') {
    return (
      <Badge tone="info" className={className}>
        Connecting…
      </Badge>
    );
  }

  if (freshness.connection === 'reconnecting') {
    return (
      <Badge tone="warning" className={className}>
        Reconnecting…
      </Badge>
    );
  }

  if (freshness.connection === 'auth-expired') {
    return (
      <Badge tone="negative" className={className}>
        Session expired
      </Badge>
    );
  }

  if (freshness.connection === 'failed' || freshness.connection === 'disconnected') {
    return (
      <Badge tone="negative" className={className}>
        Disconnected
      </Badge>
    );
  }

  if (age === null) {
    return (
      <Badge tone="neutral" className={className}>
        No data
      </Badge>
    );
  }

  return (
    <Badge tone="warning" className={className}>
      Stale · {formatAge(age)}
    </Badge>
  );
}

/** Ticks once a second so the age stays honest without re-rendering on frames. */
function useAge(updatedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return updatedAt === null ? null : now - updatedAt;
}

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
