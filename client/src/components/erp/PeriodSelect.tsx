import React from 'react';
import { Input } from '@client/src/components/ui/input';

interface PeriodSelectProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * 业务月份（YYYY-MM）选择器。
 * 用原生 month input 而不是下拉：账务查询允许提前查看未来期间，
 * 下拉只能列出「已存在凭证的期间」，会挡住查空报表的场景。
 * 清空时忽略变更：后端要求 period 匹配 YYYY-MM，空值会直接 400。
 */
const PeriodSelect: React.FC<PeriodSelectProps> = ({
  value,
  onChange,
  id,
  disabled,
  className,
}) => (
  <Input
    id={id}
    type="month"
    className={className ?? 'w-[160px]'}
    value={value}
    disabled={disabled}
    onChange={(e) => {
      if (!e.target.value) return;
      onChange(e.target.value);
    }}
  />
);

export default PeriodSelect;
