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
    className="flex flex-col gap-1.5 rounded-xl border border-border/80 bg-card p-4"
  >
    <div className="flex items-start justify-between gap-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      {Icon ? (
        <span
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md',
            TONE_ICON_CLASS[tone],
          )}
        >
          <Icon className="size-3.5" />
        </span>
      ) : null}
    </div>
    <div className="text-[25px] font-semibold leading-8 tabular-nums tracking-tight">
      {value}
    </div>
    {delta || hint ? (
      <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
        {delta}
        {hint}
      </div>
    ) : null}
  </div>
);

export default StatCard;
