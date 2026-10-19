import React from 'react';
import StickyActionBar from '@client/src/components/erp/StickyActionBar';
import { Button } from '@client/src/components/ui/button';

interface ContractFormFooterProps {
  asPage: boolean;
  isEdit: boolean;
  submitting?: boolean;
  onCancel?: () => void;
}

/** 合同表单底部动作区；独立页使用吸底栏，弹窗模式保持右对齐。 */
const ContractFormFooter: React.FC<ContractFormFooterProps> = ({
  asPage,
  isEdit,
  submitting = false,
  onCancel,
}) => {
  if (asPage) {
    return (
      <StickyActionBar variant="card" hint="保存后进入详情，可继续上传附件">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            取消
          </Button>
        ) : null}
        <Button type="submit" disabled={submitting}>{isEdit ? '保存修改' : '保存'}</Button>
      </StickyActionBar>
    );
  }

  return (
    <div className="flex justify-end gap-2 border-t pt-3">
      <Button type="submit" disabled={submitting}>{isEdit ? '保存修改' : '保存'}</Button>
    </div>
  );
};

export default ContractFormFooter;
