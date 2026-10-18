import React from 'react';
import { Link } from 'react-router-dom';
import { masterDataApi } from '@client/src/api';
import NoticeBar from '@client/src/components/erp/NoticeBar';
import { useAsyncData } from '@client/src/hooks/useAsyncData';

/**
 * 纳税主体库为空时，在客户、合同、开票页面显示一条可操作的提示。
 * 只保留一句原因 + 一个动作，避免每个页面重复长说明。
 */
const TaxEntityBanner: React.FC = () => {
  const { data } = useAsyncData(() => masterDataApi.listTaxEntities(), []);
  if (!data || data.length > 0) return null;

  return (
    <NoticeBar
      tone="warning"
      action={
        <Link
          to="/tax-entities"
          className="text-[12px] font-medium text-primary hover:underline"
        >
          去创建
        </Link>
      }
    >
      还没有纳税主体。提交审批和开票前，至少需要先创建一个启用主体。
    </NoticeBar>
  );
};

export default TaxEntityBanner;
