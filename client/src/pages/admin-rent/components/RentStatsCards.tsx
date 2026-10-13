import React from 'react';
import { FileCheck, CalendarClock, Banknote } from 'lucide-react';
import { DataState } from '@client/src/components/DataState';
import StatCard from '@client/src/components/erp/StatCard';
import { formatMoney, formatNumber } from '@client/src/utils/format';
import type { AdminRentContractStats } from '@shared/api.interface';

interface RentStatsCardsProps {
  stats: AdminRentContractStats | null;
  loading: boolean;
}

const RentStatsCards: React.FC<RentStatsCardsProps> = ({ stats, loading }) => {
  const activeCount = stats ? formatNumber(stats.activeCount) : '-';
  const expiringCount = stats ? formatNumber(stats.expiringCount) : '-';
  const totalMonthlyRent = stats ? formatMoney(stats.totalMonthlyRent) : '-';

  if (loading) {
    return <DataState loading skeleton="card" />;
  }

  return (
    <div
      className="grid grid-cols-3 gap-4"
      data-ai-section-type="card-stat"
    >
      <StatCard
        label="生效中合同数"
        value={activeCount}
        icon={FileCheck}
        tone="success"
      />
      <StatCard
        label="未来30天到期"
        value={expiringCount}
        icon={CalendarClock}
        tone="warning"
      />
      <StatCard
        label="月租金合计"
        value={totalMonthlyRent}
        icon={Banknote}
        tone="primary"
      />
    </div>
  );
};

export default RentStatsCards;
