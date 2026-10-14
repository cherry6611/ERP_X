import React, { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { financeApi } from '@client/src/api';
import { formatMoney } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';

type ReconRow = {
  id: string;
  code: string;
  counterpartName: string;
  amount: number;
  linkedAmount: number;
  openAmount: number;
  status: string;
  linkId: string | null;
  linkCode: string | null;
  flag: 'ok' | 'unlinked' | 'over' | 'voided_risk';
};

const FLAG_LABEL: Record<ReconRow['flag'], string> = {
  ok: '正常',
  unlinked: '未勾稽',
  over: '超额',
  voided_risk: '作废风险',
};

const ReconciliationTab: React.FC = () => {
  const [sub, setSub] = useState('purchase');
  const { data: summary, reload: reloadSummary } = useAsyncData(
    () => financeApi.reconSummary(),
    [],
  );
  const { data: purchase, reload: reloadPurchase } = useAsyncData(
    () => financeApi.reconPurchaseAp(),
    [],
  );
  const { data: sales } = useAsyncData(() => financeApi.reconSalesAr(), []);
  const { data: receipts } = useAsyncData(
    () => financeApi.reconReceiptWriteoff(),
    [],
  );

  const rows: ReconRow[] =
    sub === 'purchase'
      ? (purchase ?? [])
      : sub === 'sales'
        ? (sales ?? [])
        : (receipts ?? []);

  const unbind = async (invoiceId: string) => {
    try {
      await financeApi.unbindPurchaseAp(invoiceId);
      toast.success('已解绑应付');
      void reloadPurchase();
      void reloadSummary();
    } catch (e) {
      toast.error(getApiErrorMessage(e, '解绑失败'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="进项未勾稽" value={summary?.purchaseUnlinked ?? 0} />
        <Stat label="销项未关联应收" value={summary?.salesUnlinked ?? 0} />
        <Stat label="回款未核销" value={summary?.receiptUnlinked ?? 0} />
        <Stat label="作废风险" value={summary?.voidedRisk ?? 0} />
      </div>

      <Tabs value={sub} onValueChange={setSub}>
        <TabsList>
          <TabsTrigger value="purchase">进项↔应付</TabsTrigger>
          <TabsTrigger value="sales">销项↔应收</TabsTrigger>
          <TabsTrigger value="receipt">回款↔核销</TabsTrigger>
        </TabsList>
        <TabsContent value={sub} className="mt-3">
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2">单号</th>
                  <th className="p-2">对方</th>
                  <th className="p-2">金额</th>
                  <th className="p-2">已勾稽</th>
                  <th className="p-2">关联</th>
                  <th className="p-2">状态</th>
                  <th className="p-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="p-2 font-mono text-xs">{row.code}</td>
                    <td className="p-2">{row.counterpartName || '—'}</td>
                    <td className="p-2">{formatMoney(row.amount)}</td>
                    <td className="p-2">{formatMoney(row.linkedAmount)}</td>
                    <td className="p-2 font-mono text-xs">
                      {row.linkCode || '—'}
                    </td>
                    <td className="p-2">
                      <span
                        className={
                          row.flag === 'ok'
                            ? 'text-muted-foreground'
                            : row.flag === 'over' || row.flag === 'voided_risk'
                              ? 'text-destructive'
                              : 'text-amber-700'
                        }
                      >
                        {FLAG_LABEL[row.flag]}
                      </span>
                    </td>
                    <td className="p-2">
                      {sub === 'purchase' && row.linkId ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void unbind(row.id)}
                        >
                          解绑
                        </Button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td className="p-4 text-muted-foreground" colSpan={7}>
                      暂无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

export default ReconciliationTab;
