import React from 'react';
import { Download } from 'lucide-react';
import FilterBar from '@client/src/components/erp/FilterBar';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { CONTRACT_STATUS_LABELS } from '@client/src/utils/biz-labels';

interface ContractFiltersProps {
  q: string;
  onQChange: (value: string) => void;
  debouncing: boolean;
  statusFilter: string;
  onStatusChange: (value: string) => void;
  onExport: () => void;
}

const ContractFilters: React.FC<ContractFiltersProps> = ({
  q,
  onQChange,
  debouncing,
  statusFilter,
  onStatusChange,
  onExport,
}) => (
  <FilterBar>
    <div className="flex items-center gap-2">
      <Label htmlFor="contract-status-filter">状态</Label>
      <Select value={statusFilter} onValueChange={onStatusChange}>
        <SelectTrigger id="contract-status-filter" className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部</SelectItem>
          {Object.entries(CONTRACT_STATUS_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
    <Input
      aria-label="搜索合同"
      placeholder="搜索合同名称或编号"
      className="w-64"
      value={q}
      onChange={(e) => onQChange(e.target.value)}
    />
    {debouncing ? (
      <span className="text-xs text-muted-foreground">筛选中…</span>
    ) : null}
    <Button variant="outline" onClick={onExport}>
      <Download className="h-4 w-4" />
      导出 Excel
    </Button>
  </FilterBar>
);

export default ContractFilters;
