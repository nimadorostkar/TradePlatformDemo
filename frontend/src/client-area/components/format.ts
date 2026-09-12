import { TradingError } from '@/domain/common/errors';
import type { ClientAccount } from '../api';
import { formatMoney } from '../hooks';

export function accountLabel(a: ClientAccount): string {
  return `#${a.login} · ${a.type.platform} ${a.type.title} · ${formatMoney(a.balance, a.currency)}`;
}

export function errorMessage(error: unknown): string {
  return TradingError.from(error).message;
}
