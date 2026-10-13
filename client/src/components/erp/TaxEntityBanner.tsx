import React from 'react';
import { masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { TAX_ENTITY_REQUIRED_MESSAGE } from '@shared/tax';

/** 纳税主体库为空时，在客户、合同、开票页面提示先建主体。 */
const TaxEntityBanner: React.FC = () => {
  const { data } = useAsyncData(() => masterDataApi.listTaxEntities(), []);
  if (!data || data.length > 0) return null;
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="status">
      {TAX_ENTITY_REQUIRED_MESSAGE}。草稿可以先保存，提交审批和开票前必须至少有一个启用主体。
    </div>
  );
};

export default TaxEntityBanner;
