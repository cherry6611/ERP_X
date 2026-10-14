import type { ReactNode } from 'react';
import { cn } from '@client/src/lib/utils';

interface SectionTitleProps {
  id?: string;
  children: ReactNode;
  className?: string;
  description?: ReactNode;
}

/** P1：分区标题强制渲染 h2，保证 h1→h2→h3 连续 */
export function SectionTitle({
  id,
  children,
  className,
  description,
}: SectionTitleProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <h2
        id={id}
        className="text-base font-semibold leading-6 tracking-tight text-foreground"
      >
        {children}
      </h2>
      {description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
