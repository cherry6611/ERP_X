import React from 'react';

interface FilterBarProps {
  title?: string;
  children: React.ReactNode;
}

const FilterBar: React.FC<FilterBarProps> = ({ title, children }) => (
  <div className="rounded-xl border border-border/80 bg-card px-3 py-2.5">
    {title ? (
      <p className="mb-2 px-1 text-[11px] font-medium text-muted-foreground">{title}</p>
    ) : null}
    <div className="flex flex-wrap items-center gap-2.5">{children}</div>
  </div>
);

export default FilterBar;
