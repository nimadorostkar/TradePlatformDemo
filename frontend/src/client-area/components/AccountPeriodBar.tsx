import type { ClientAccount } from '../api';
import type { Period } from './use-account-period';
import { AccountSelect, Segmented } from './ui';

/** Account + period pickers shared by Performance and History of orders. */
export function AccountPeriodBar({
  list,
  login,
  setLogin,
  period,
  setPeriod,
}: {
  list: readonly ClientAccount[];
  login: string;
  setLogin: (login: string) => void;
  period: Period;
  setPeriod: (period: Period) => void;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <div className="w-full sm:w-80">
        <AccountSelect id="period-account" accounts={list} value={login} onChange={setLogin} />
      </div>
      <Segmented
        label="Period"
        value={period}
        onChange={setPeriod}
        options={[
          { value: '7d', label: '7 days' },
          { value: '30d', label: '30 days' },
          { value: '90d', label: '90 days' },
          { value: 'all', label: 'All time' },
        ]}
      />
    </div>
  );
}
