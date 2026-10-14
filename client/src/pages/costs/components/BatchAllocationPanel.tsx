import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Wand2 } from 'lucide-react';
import { SectionTitle } from '@client/src/components/SectionTitle';
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
import { costsApi } from '@client/src/api';
import { formatMoney } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { COST_TYPE_LABELS } from '@client/src/utils/biz-labels';
import type {
  CostType,
  CreateCostAllocationBatchDto,
  Project,
} from '@shared/api.interface';

interface Row {
  projectId: string;
  weight: string;
}

/**
 * D-07：一笔公共成本按**权重**分摊到多个项目（作业成本法 ABC 的核心动作）。
 *
 * ## 为什么前端必须把金额计算交给服务端
 *
 * 界面上会**预估**每项分摊额（让使用者填权重时看得到结果），
 * 但提交时不带任何金额 —— 最终金额由服务端用最大余数法计算。
 *
 * 原因：分摊额之和必须**严格等于**被分摊总额。前端自己算再逐笔提交，
 * 即使算法正确也要多发 N 个请求；算法一旦退化成朴素的
 * `round2(amount × w / Σw)`，三项均分 100 元就会得到 33.33×3 = 99.99，
 * **差的 1 分在凭证上就是借贷不平**。所以这里只做**展示性预估**
 * （明确标注"预估"），并展示与服务端一致的尾差补齐结果。
 */
const BatchAllocationPanel: React.FC<{
  projects: Project[];
  onDone: () => Promise<void> | void;
}> = ({ projects, onDone }) => {
  const [sourceDesc, setSourceDesc] = useState('');
  const [period, setPeriod] = useState('');
  const [costType, setCostType] = useState<CostType>('compute');
  const [amount, setAmount] = useState('');
  const [rows, setRows] = useState<Row[]>([
    { projectId: '', weight: '1' },
    { projectId: '', weight: '1' },
  ]);
  const [submitting, setSubmitting] = useState(false);

  const totalAmount = Number(amount);
  const weights = rows.map((r) => Number(r.weight));

  /**
   * 展示性预估：与服务端**同一套最大余数法**（逐项补齐分位），
   * 因此这里显示的数就是提交后落库的数，不会出现"预览 33.33、实际 33.34"的错位。
   */
  const preview = useMemo(() => {
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) return null;
    if (weights.some((w) => !Number.isFinite(w) || w <= 0)) return null;
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    if (totalWeight <= 0) return null;
    const cents = Math.round(totalAmount * 100);
    const exact = weights.map((w) => (cents * w) / totalWeight);
    const floors = exact.map((v) => Math.floor(v));
    let remainder = cents - floors.reduce((a, b) => a + b, 0);
    const order = exact
      .map((v, i) => ({ i, frac: v - Math.floor(v) }))
      .sort((a, b) => (b.frac === a.frac ? a.i - b.i : b.frac - a.frac));
    const out = [...floors];
    let cursor = 0;
    while (remainder > 0 && order.length > 0) {
      out[order[cursor % order.length].i] += 1;
      remainder -= 1;
      cursor += 1;
    }
    return out.map((c) => Math.round(c) / 100);
  }, [totalAmount, weights]);

  const previewSum = preview
    ? Math.round(preview.reduce((a, b) => a + b, 0) * 100) / 100
    : 0;

  const submit = async () => {
    if (!sourceDesc.trim()) {
      toast.error('来源说明不能为空');
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(period)) {
      toast.error('期间格式为 YYYY-MM');
      return;
    }
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      toast.error('分摊金额必须大于 0');
      return;
    }
    const targets = rows
      .filter((r) => r.projectId)
      .map((r) => ({ projectId: r.projectId, weight: Number(r.weight) }));
    if (targets.length === 0) {
      toast.error('请至少选择一个分摊项目');
      return;
    }
    if (new Set(targets.map((t) => t.projectId)).size !== targets.length) {
      toast.error('分摊项目不能重复；同一项目的权重请合并后只填一行');
      return;
    }
    if (targets.some((t) => !Number.isFinite(t.weight) || t.weight <= 0)) {
      toast.error('每行权重必须大于 0');
      return;
    }

    const dto: CreateCostAllocationBatchDto = {
      sourceDesc: sourceDesc.trim(),
      costType,
      amount: totalAmount,
      period,
      // 与单项目模式一致：用来源说明作为 sourceRef 的业务标识
      sourceRef: sourceDesc.trim(),
      targets,
    };
    setSubmitting(true);
    try {
      const result = await costsApi.createAllocationBatch(dto);
      if (result.allocatedAmount !== result.totalAmount) {
        // 服务端有自检，理论上到不了这里；真到了必须让人知道而不是静默继续
        toast.error(
          `分摊合计 ${formatMoney(result.allocatedAmount)} 与总额 ${formatMoney(result.totalAmount)} 不一致，请勿使用该结果`,
        );
        return;
      }
      toast.success(
        `已分摊到 ${result.allocations.length} 个项目，合计 ${formatMoney(result.allocatedAmount)}` +
          (result.adjustedCount > 0
            ? `（${result.adjustedCount} 项因四舍五入被补齐 1 分）`
            : ''),
      );
      setSourceDesc('');
      setAmount('');
      setRows([
        { projectId: '', weight: '1' },
        { projectId: '', weight: '1' },
      ]);
      await onDone();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '分摊失败'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <SectionTitle>多项目加权分摊（D-07）</SectionTitle>
      <p className="text-xs text-muted-foreground">
        一笔公共成本按权重（工时 / 收入占比 / 机时等）分到多个项目。
        金额由服务端计算，**保证各项目分摊额之和严格等于分摊总额**（尾差按最大余数法补齐）
        —— 手工拆多笔极易差 1 分，而分摊合计与被分摊总额不等会让凭证不平。
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <Label className="text-xs">来源说明</Label>
          <Input
            className="w-56"
            value={sourceDesc}
            placeholder="如：2026-10 公共云资源"
            onChange={(e) => setSourceDesc(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">期间</Label>
          <Input
            className="w-28"
            value={period}
            placeholder="YYYY-MM"
            onChange={(e) => setPeriod(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">成本类型</Label>
          <Select
            value={costType}
            onValueChange={(v) => setCostType(v as CostType)}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(COST_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">待分摊总额</Label>
          <Input
            className="w-32"
            inputMode="decimal"
            value={amount}
            placeholder="0.00"
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="text-xs">分摊目标与权重</Label>
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <Select
              value={row.projectId || undefined}
              onValueChange={(v) =>
                setRows((prev) =>
                  prev.map((r, i) => (i === index ? { ...r, projectId: v } : r)),
                )
              }
            >
              <SelectTrigger className="w-64">
                <SelectValue placeholder="选择项目" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="w-24"
              inputMode="decimal"
              value={row.weight}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((r, i) =>
                    i === index ? { ...r, weight: e.target.value } : r,
                  ),
                )
              }
            />
            <span className="w-28 text-right text-sm tabular-nums text-muted-foreground">
              {preview ? `预估 ${formatMoney(preview[index] ?? 0)}` : '—'}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={rows.length <= 1}
              onClick={() =>
                setRows((prev) => prev.filter((_, i) => i !== index))
              }
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setRows((prev) => [...prev, { projectId: '', weight: '1' }])
            }
          >
            <Plus className="mr-1 h-4 w-4" />
            增加一行
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRows((prev) => prev.map((r) => ({ ...r, weight: '1' })))}
          >
            <Wand2 className="mr-1 h-4 w-4" />
            权重平均
          </Button>
        </div>
      </div>

      {preview && (
        <p className="text-xs text-muted-foreground">
          预估合计 {formatMoney(previewSum)}
          {previewSum === totalAmount
            ? '，与分摊总额一致（尾差已按最大余数法补齐）'
            : '，与分摊总额不一致，请检查输入'}
        </p>
      )}

      <div>
        <Button type="button" disabled={submitting} onClick={() => void submit()}>
          {submitting ? '分摊中…' : '按权重分摊'}
        </Button>
      </div>
    </div>
  );
};

export default BatchAllocationPanel;
