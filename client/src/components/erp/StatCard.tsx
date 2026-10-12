import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@client/src/lib/utils';

type StatTone = 'primary' | 'success' | 'warning' | 'info' | 'neutral';

const TONE_ICON_CLASS: Record<StatTone, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  info: 'bg-info/10 text-info',
  neutral: 'bg-muted text-muted-foreground',
};

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
  tone?: StatTone;
  delta?: React.ReactNode;
  hint?: React.ReactNode;
}

const StatCard: React.FC<StatCardProps> = ({
  label,
  value,
  icon: Icon,
  tone = 'primary',
  delta,
  hint,
}) => (
  <div
    data-ai-section-type="card-stat"
    className="rounded-lg border bg-card p-4 flex flex-col gap-2 hover-elevate transition-all hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md"
  >
    <div className="flex items-start justify-between gap-2">
      <p className="text-sm text-muted-foreground">{label}</p>
      {Icon ? (
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md',
            TONE_ICON_CLASS[tone],
          )}
        >
          <Icon className="size-4" />
        </span>
      ) : null}
    </div>
    <div className="text-2xl font-semibold tabular-nums leading-none">{value}</div>
    {delta || hint ? (
      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        {delta}
        {hint}
      </div>
    ) : null}
  </div>
);

export default StatCard;
