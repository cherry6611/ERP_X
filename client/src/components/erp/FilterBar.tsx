import React from 'react';

interface FilterBarProps {
  title?: string;
  children: React.ReactNode;
}

const FilterBar: React.FC<FilterBarProps> = ({ title, children }) => (
  <div className="rounded-lg border bg-card p-3">
    {title ? (
      <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">{title}</p>
    ) : null}
    <div className="flex flex-wrap items-center gap-2">{children}</div>
  </div>
);

export default FilterBar;
