import React, { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as assetApi from '@client/src/api/asset';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type {
  AssetDisposalItem,
  AssetDisposalPreview,
  AssetDisposalType,
  AssetItem,
} from '@shared/api.interface';

const DISPOSAL_TYPE_LABELS: Record<AssetDisposalType, string> = {
  sale: '出售转让',
  scrap: '报废',
  donate: '捐赠',
};

const STATUS_LABELS: Record<AssetDisposalItem['status'], string> = {
  disposing: '处置中',
  disposed: '已处置',
  scrapped: '已报废',
  rejected: '已驳回',
};

/**
 * D-08 ④：处置与报废面板。
 *
 * 交互设计要点：
 * 1. **先预览分录再提交**：处置会同时影响 1601/1602/1604/1603/1002/6711/6301 七个科目，
 *    把将要生成的分录提前展示给财务，是避免科目错误最有效的手段。
 * 2. 报废/捐赠的收入固定为 0（后端也校验），因此收入与税率输入框在选中报废/捐赠时禁用。
 * 3. 审批 `complete` 后才生成凭证并同步资产卡片状态；`reject` 只改状态不生成凭证。
 */
const DisposalPanel: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [assetId, setAssetId] = useState<string>('');
  const [disposalType, setDisposalType] = useState<AssetDisposalType>('scrap');
  const [applyDate, setApplyDate] = useState<string>(
    new Date().toISOString().slice(0, 10),
  );
  const [disposalIncome, setDisposalIncome] = useState<string>('0');
  const [taxRate, setTaxRate] = useState<string>('0');
  const [reason, setReason] = useState<string>('');
  const [preview, setPreview] = useState<AssetDisposalPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: assets } = useAsyncData(
    () => assetApi.listAssets({ pageSize: 200 }),
    [],
  );
  const { data, loading, error, reload } = useAsyncData(
    () => assetApi.listDisposals({ pageSize: 100 }),
    [],
  );

  const items: AssetDisposalItem[] = data?.items ?? [];
  const assetOptions: AssetItem[] = assets?.items ?? [];
  const incomeDisabled = disposalType !== 'sale';

  const runPreview = async () => {
    if (!assetId) {
      toast.error('请先选择资产');
      return;
    }
    try {
      const result = await assetApi.previewDisposal({
        assetId,
        disposalType,
        disposalIncome: incomeDisabled ? 0 : Number(disposalIncome) || 0,
        taxRate: incomeDisabled ? 0 : Number(taxRate) || 0,
      });
      setPreview(result);
    } catch (err) {
      toast.error(getApiErrorMessage(err, '测算失败'));
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      await assetApi.createDisposal({
        assetId,
        disposalType,
        applyDate,
        disposalIncome: incomeDisabled ? 0 : Number(disposalIncome) || 0,
        taxRate: incomeDisabled ? 0 : Number(taxRate) || 0,
        reason: reason || undefined,
      });
      toast.success('处置申请已提交，等待审批完成');
      setOpen(false);
      setPreview(null);
      reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '提交失败'));
    } finally {
      setBusy(false);
    }
  };

  const complete = async (item: AssetDisposalItem) => {
    const ok = await confirmDanger(
      `确认完成 ${item.code}（资产 ${item.assetCode}，预计损益 ${item.gainLoss} 元）？完成后将生成处置凭证并同步资产状态。`,
      { title: '完成处置' },
    );
    if (!ok) return;
    try {
      const result = await assetApi.disposalAction(item.id, 'complete');
      toast.success(
        result.voucherRef
          ? `处置完成，凭证 ${result.voucherRef}`
          : '处置完成，凭证进入补偿队列待补录',
      );
      reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  const reject = async (item: AssetDisposalItem) => {
    const ok = await confirmDanger(`确认驳回 ${item.code}？`, {
      title: '驳回处置',
    });
    if (!ok) return;
    try {
      await assetApi.disposalAction(item.id, 'reject');
      toast.success('已驳回');
      reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center gap-4">
        <p className="text-sm text-muted-foreground">
          处置净损益 = 处置收入 − 销项税 −（原值 − 累计折旧 − 已计提减值）。
          凭证：借 1603 固定资产清理 + 借 1602 + 借 1604 / 贷 1601；收益贷 6301，损失借 6711。
        </p>
        <Button
          type="button"
          onClick={() => {
            setPreview(null);
            setOpen(true);
          }}
        >
          发起处置
        </Button>
      </div>

      <DataBoundary
        loading={loading}
        error={error}
        empty={items.length === 0}
        emptyText="暂无处置记录"
        onRetry={reload}
      >
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th className="p-2 font-medium">处置单号</th>
                <th className="p-2 font-medium">资产</th>
                <th className="p-2 font-medium">方式</th>
                <th className="p-2 font-medium">状态</th>
                <th className="p-2 font-medium">申请日</th>
                <th className="p-2 text-right font-medium">净值</th>
                <th className="p-2 text-right font-medium">处置收入</th>
                <th className="p-2 text-right font-medium">净损益</th>
                <th className="p-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t">
                  <td className="p-2 font-mono text-xs">{item.code}</td>
                  <td className="p-2">
                    {item.assetCode} {item.assetName}
                  </td>
                  <td className="p-2">{DISPOSAL_TYPE_LABELS[item.disposalType]}</td>
                  <td className="p-2">{STATUS_LABELS[item.status]}</td>
                  <td className="p-2">{item.applyDate}</td>
                  <td className="p-2 text-right tabular-nums">
                    {item.netValue.toFixed(2)}
                  </td>
                  <td className="p-2 text-right tabular-nums">
                    {item.disposalIncome.toFixed(2)}
                  </td>
                  <td
                    className={`p-2 text-right tabular-nums ${
                      item.gainLoss < 0 ? 'text-destructive' : 'text-emerald-600'
                    }`}
                  >
                    {item.gainLoss.toFixed(2)}
                  </td>
                  <td className="p-2">
                    {item.status === 'disposing' ? (
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => complete(item)}
                        >
                          完成
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => reject(item)}
                        >
                          驳回
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {item.voucherRef ?? '—'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataBoundary>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>发起资产处置</DialogTitle>
            <DialogDescription>
              报废与捐赠无处置收入；出售转让需填写不含税收入与销项税率。
              提交后需审批「完成」才会生成凭证。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="disposal-asset">资产（仅在用/闲置/维修中可选）</Label>
              <Select value={assetId} onValueChange={setAssetId}>
                <SelectTrigger id="disposal-asset">
                  <SelectValue placeholder="选择资产" />
                </SelectTrigger>
                <SelectContent>
                  {assetOptions
                    .filter((asset) =>
                      ['in_use', 'idle', 'repair'].includes(asset.status ?? ''),
                    )
                    .map((asset) => (
                      <SelectItem key={asset.id} value={asset.id}>
                        {asset.code} {asset.name}（净值 {asset.netValue}）
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="disposal-type">处置方式</Label>
                <Select
                  value={disposalType}
                  onValueChange={(value) =>
                    setDisposalType(value as AssetDisposalType)
                  }
                >
                  <SelectTrigger id="disposal-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(DISPOSAL_TYPE_LABELS) as AssetDisposalType[]).map(
                      (key) => (
                        <SelectItem key={key} value={key}>
                          {DISPOSAL_TYPE_LABELS[key]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="disposal-date">申请日期</Label>
                <Input
                  id="disposal-date"
                  type="date"
                  value={applyDate}
                  onChange={(event) => setApplyDate(event.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="disposal-income">处置收入（不含税）</Label>
                <Input
                  id="disposal-income"
                  inputMode="decimal"
                  disabled={incomeDisabled}
                  value={incomeDisabled ? '0' : disposalIncome}
                  onChange={(event) => setDisposalIncome(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="disposal-tax">销项税率（%）</Label>
                <Input
                  id="disposal-tax"
                  inputMode="decimal"
                  disabled={incomeDisabled}
                  value={incomeDisabled ? '0' : taxRate}
                  onChange={(event) => setTaxRate(event.target.value)}
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={runPreview}>
                测算损益与分录
              </Button>
            </div>

            {preview && (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <StatCard
                    label="账面净值"
                    value={preview.netBookValue.toFixed(2)}
                  />
                  <StatCard
                    label="已计提减值"
                    value={preview.accumulatedImpairment.toFixed(2)}
                  />
                  <StatCard label="销项税" value={preview.taxAmount.toFixed(2)} />
                  <StatCard
                    label="预计净损益"
                    value={preview.gainLoss.toFixed(2)}
                    tone={preview.gainLoss >= 0 ? 'success' : 'warning'}
                  />
                </div>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr className="text-left">
                        <th className="p-2 font-medium">科目</th>
                        <th className="p-2 text-right font-medium">借方</th>
                        <th className="p-2 text-right font-medium">贷方</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.lines.map((line, index) => (
                        <tr key={`${line.accountCode}-${index}`} className="border-t">
                          <td className="p-2 font-mono">{line.accountCode}</td>
                          <td className="p-2 text-right tabular-nums">
                            {line.debit ? line.debit.toFixed(2) : ''}
                          </td>
                          <td className="p-2 text-right tabular-nums">
                            {line.credit ? line.credit.toFixed(2) : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="disposal-reason">处置原因</Label>
              <Input
                id="disposal-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={busy || !assetId} onClick={submit}>
              {busy ? '提交中…' : '提交处置申请'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DisposalPanel;
