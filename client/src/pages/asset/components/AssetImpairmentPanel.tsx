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
// B-01：写操作（计提减值会生成凭证、删除减值记录）必须按能力显隐。
// `pur_asset` 在矩阵中对 finance_viewer / project_manager 是 `r`，
// 后端写接口要求 `rw` —— 不加这一层会让只读角色看到点了必然 403 的按钮。
import { CanCapabilityWrite } from '@client/src/platform/auth';
// 业务时区（Asia/Shanghai）取"今天"与"本月"：`toISOString()` 走 UTC，
// 北京时间 00:00–08:00 会取到**前一天/上一月**，减值凭证可能被记进上个期间
// （或被服务端 `assertPeriodOpen` 以"期间已关账"拒绝，且原因看不出来）。
import { currentPeriod, todayIso } from '@client/src/utils/format';
import type {
  AssetImpairmentItem,
  AssetItem,
  ImpairmentTestPreview,
} from '@shared/api.interface';

/**
 * D-08 ③：减值测试面板。
 *
 * 交互设计要点：
 * 1. **先预览后提交**：减值损失不能只靠人工填，必须由「账面价值 − 可收回金额」算出，
 *    因此先调 `impairment-test` 预览，把账面价值/累计折旧/已计提减值都摊开给财务看，
 *    再确认建单（避免手填错金额导致账实不符）。
 * 2. **可收回金额为 0 也允许建单**（全额减值），但不允许负数。
 * 3. 损失为 0 时禁用提交按钮并说明原因，而不是提交后报错。
 */
const ImpairmentPanel: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [assetId, setAssetId] = useState<string>('');
  const [testDate, setTestDate] = useState<string>(todayIso());
  const [period, setPeriod] = useState<string>(currentPeriod());
  const [recoverableAmount, setRecoverableAmount] = useState<string>('');
  const [remark, setRemark] = useState<string>('');
  const [preview, setPreview] = useState<ImpairmentTestPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: assets } = useAsyncData(
    () => assetApi.listAssets({ pageSize: 200 }),
    [],
  );
  const { data, loading, error, reload } = useAsyncData(
    () => assetApi.listImpairments({ pageSize: 100 }),
    [],
  );

  const items: AssetImpairmentItem[] = data?.items ?? [];
  const assetOptions: AssetItem[] = assets?.items ?? [];

  const runPreview = async () => {
    if (!assetId) {
      toast.error('请先选择资产');
      return;
    }
    const amount = Number(recoverableAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error('可收回金额必须为不小于 0 的数值');
      return;
    }
    try {
      const result = await assetApi.previewImpairmentTest(assetId, amount);
      setPreview(result);
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  const submit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await assetApi.createImpairment({
        assetId,
        testDate,
        period,
        recoverableAmount: Number(recoverableAmount),
        remark: remark || undefined,
      });
      toast.success(`已计提减值 ${preview.impairmentLoss} 元，凭证已生成或进入补偿队列`);
      setOpen(false);
      setPreview(null);
      setRecoverableAmount('');
      setRemark('');
      reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: AssetImpairmentItem) => {
    const ok = await confirmDanger(
      `确认删除 ${item.code}（资产 ${item.assetCode}，减值 ${item.impairmentLoss} 元）？已生成凭证的记录需先作废凭证。`,
      { title: '删除减值记录' },
    );
    if (!ok) return;
    try {
      await assetApi.deleteImpairment(item.id);
      toast.success('已删除');
      reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center gap-4">
        <p className="text-sm text-muted-foreground">
          减值损失 = 账面价值 − 可收回金额（下限 0）；账面价值 = 原值 − 累计折旧 − 已计提减值。
          凭证：借 6701 资产减值损失 / 贷 1604 固定资产减值准备。
        </p>
        <CanCapabilityWrite capability="pur_asset">
          <Button
            type="button"
            onClick={() => {
              setPreview(null);
              setOpen(true);
            }}
          >
            计提减值
          </Button>
        </CanCapabilityWrite>
      </div>

      <DataBoundary
        loading={loading}
        error={error}
        empty={items.length === 0}
        emptyText="暂无减值记录"
        onRetry={reload}
      >
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th className="p-2 font-medium">减值单号</th>
                <th className="p-2 font-medium">资产</th>
                <th className="p-2 font-medium">测试日</th>
                <th className="p-2 font-medium">期间</th>
                <th className="p-2 text-right font-medium">账面价值</th>
                <th className="p-2 text-right font-medium">可收回金额</th>
                <th className="p-2 text-right font-medium">减值损失</th>
                <th className="p-2 font-medium">凭证</th>
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
                  <td className="p-2">{item.testDate}</td>
                  <td className="p-2">{item.period}</td>
                  <td className="p-2 text-right tabular-nums">
                    {item.bookValue.toFixed(2)}
                  </td>
                  <td className="p-2 text-right tabular-nums">
                    {item.recoverableAmount.toFixed(2)}
                  </td>
                  <td className="p-2 text-right tabular-nums text-destructive">
                    {item.impairmentLoss.toFixed(2)}
                  </td>
                  <td className="p-2 text-xs">
                    {item.voucherRef ? (
                      <span className="text-muted-foreground">
                        {item.voucherRef}
                      </span>
                    ) : (
                      <span className="text-amber-600">待补录（已入补偿队列）</span>
                    )}
                  </td>
                  <td className="p-2">
                    <CanCapabilityWrite capability="pur_asset">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => remove(item)}
                      >
                        删除
                      </Button>
                    </CanCapabilityWrite>
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
            <DialogTitle>计提固定资产减值</DialogTitle>
            <DialogDescription>
              先选资产并填写可收回金额，系统会算出减值损失供确认。
              同一资产同一期间只能计提一次。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="impairment-asset">资产</Label>
              <Select value={assetId} onValueChange={setAssetId}>
                <SelectTrigger id="impairment-asset">
                  <SelectValue placeholder="选择资产" />
                </SelectTrigger>
                <SelectContent>
                  {assetOptions.map((asset) => (
                    <SelectItem key={asset.id} value={asset.id}>
                      {asset.code} {asset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="impairment-date">减值测试日</Label>
                <Input
                  id="impairment-date"
                  type="date"
                  value={testDate}
                  onChange={(event) => setTestDate(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="impairment-period">归属期间（YYYY-MM）</Label>
                <Input
                  id="impairment-period"
                  value={period}
                  placeholder="2026-10"
                  onChange={(event) => setPeriod(event.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="impairment-recoverable">
                可收回金额（公允价值减处置费用 与 预计未来现金流量现值 孰高）
              </Label>
              <div className="flex gap-2">
                <Input
                  id="impairment-recoverable"
                  inputMode="decimal"
                  value={recoverableAmount}
                  placeholder="0.00"
                  onChange={(event) => setRecoverableAmount(event.target.value)}
                />
                <Button type="button" variant="outline" onClick={runPreview}>
                  测算
                </Button>
              </div>
            </div>

            {preview && (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <StatCard
                  label="账面价值"
                  value={preview.bookValue.toFixed(2)}
                  tone="info"
                />
                <StatCard
                  label="累计折旧"
                  value={preview.accumulatedDepreciation.toFixed(2)}
                />
                <StatCard
                  label="已计提减值"
                  value={preview.accumulatedImpairment.toFixed(2)}
                />
                <StatCard
                  label="本次减值损失"
                  value={preview.impairmentLoss.toFixed(2)}
                  tone={preview.needsImpairment ? 'warning' : 'success'}
                />
                {preview.belowResidual && (
                  <p className="col-span-full text-sm text-amber-600">
                    提示：可收回金额已低于资产残值，请复核评估依据后再提交。
                  </p>
                )}
                {!preview.needsImpairment && (
                  <p className="col-span-full text-sm text-muted-foreground">
                    可收回金额不低于账面价值，无需计提减值。
                  </p>
                )}
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="impairment-remark">备注（评估依据/报告编号）</Label>
              <Input
                id="impairment-remark"
                value={remark}
                onChange={(event) => setRemark(event.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              disabled={busy || !preview?.needsImpairment}
              onClick={submit}
            >
              {busy ? '提交中…' : '确认计提'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ImpairmentPanel;
