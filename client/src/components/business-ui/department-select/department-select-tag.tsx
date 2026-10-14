'use client';

import { X } from 'lucide-react';

import { IconDepartment } from '@client/src/components/business-ui/department-select/icon-department';
import type { Department } from '@client/src/components/business-ui/department-select/types';
import { ItemPill } from '@client/src/components/business-ui/entity-combobox/item-pill';
import {
  tagCloseIconVariants,
  tagIconVariants,
  type ComboboxSize,
} from '@client/src/components/business-ui/entity-combobox/size-variants';
import { Button } from '@/components/ui/button';

export const DepartmentSelectTag = ({
  departmentValue,
  onClose,
  maxTextLength,
  className,
  size = 'medium',
  disabled,
}: {
  departmentValue: Department;
  onClose: (value: Department, e: React.MouseEvent) => void;
  maxTextLength?: number;
  className?: string;
  size?: ComboboxSize;
  disabled?: boolean;
}) => {
  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose(departmentValue, e);
  };

  const closeButton = !disabled ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-auto rounded-sm p-0 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none"
      onClick={handleClose}
    >
      <X className={tagCloseIconVariants({ size })} />
      <span className="sr-only">移除 {departmentValue.name}</span>
    </Button>
  ) : null;

  return (
    <ItemPill
      label={departmentValue.name}
      avatar={<IconDepartment className={tagIconVariants({ size })} />}
      avatarFallback={false}
      className={className}
      maxTextLength={maxTextLength}
      suffix={closeButton}
      size={size}
    />
  );
};
