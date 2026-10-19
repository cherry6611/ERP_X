import React from 'react';
import { cn } from '@client/src/lib/utils';

interface ActionGroupProps {
  children: React.ReactNode;
  className?: string;
}

/** 同一组次级操作。说明不要放进这个组，页面说明走 PageHelp，按钮说明走 ButtonHelp。 */
const ActionGroup: React.FC<ActionGroupProps> = ({ children, className }) => (
  <div className={cn('inline-flex flex-wrap items-center gap-2', className)}>{children}</div>
);

export default ActionGroup;
