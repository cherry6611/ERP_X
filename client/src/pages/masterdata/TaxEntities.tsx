import React, { useState } from 'react';
import { toast } from 'sonner';
import { Table, TableColumnsType } from 'antd';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { FieldLabel, useFieldId } from '@client/src/components/erp/FieldLabel';
import { Explained } from '@client/src/components/erp/ItemHelp';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { masterDataApi } from '@client/src/api';
import type { TaxEntity } from '@client/src/api/master-data';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { ALLOWED_RATES, type TaxpayerType } from '@shared/tax';
import { taxEntityColumns } from './components/tax-entity-columns';
/*
 * §5.9：本页"错了也看不出来"的两块计算搬进 `./components/tax-entity-form`：
 *   · 编辑路径**不能带 `code`**（服务端 UpdateTaxEntityDto 无该字段，
 *     全局 ValidationPipe 开了 forbidNonWhitelisted → 整次保存 400）；
 *   · 城建税率必须先解析（`Number('7%')` = NaN → JSON 里变 null →
 *     服务端当"显式清空" → 已配置的税率被静默抹掉）。
 * 两块都有 `tax-entity-form.spec.ts` 逐条断言。
 */
import {
  buildTaxEntityCreatePayload,
  buildTaxEntityUpdatePayload,
  parseUrbanMaintRate,
} from './components/tax-entity-form';
import {
  EMPTY_TAX_ENTITY_FORM,
  taxEntitySchema,
} from './components/tax-entity-schema';

function fieldStatus(text: string | null) {
  if (!text) return null;
  return <p className="text-[12px] leading-[18px] text-muted-foreground">{text}</p>;
}

const TaxEntitiesPage: React.FC = () => {
  const { data, loading, error, reload } = useAsyncData<TaxEntity[]>(
    () => masterDataApi.listTaxEntities(),
    []
  );
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TaxEntity | null>(null);
  const [form, setForm] = useState(EMPTY_TAX_ENTITY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // P2-3：字段 id 统一由 useFieldId 生成（React.useId 保证全页唯一）
  const usccId = useFieldId('tax-entity-uscc');
  const urbanMaintId = useFieldId('tax-entity-urban-maint');
  const codeId = useFieldId('tax-entity-code');
  const nameId = useFieldId('tax-entity-name');

  const rates = ALLOWED_RATES[form.taxpayerType];

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_TAX_ENTITY_FORM);
    setFieldErrors({});
    setOpen(true);
  };

  const openEdit = (row: TaxEntity) => {
    setEditing(row);
    setForm({
      code: row.code,
      name: row.name,
      uscc: row.uscc ?? '',
      taxpayerType: row.taxpayerType,
      defaultOutputRate: row.defaultOutputRate,
      defaultInputRate: row.defaultInputRate,
      vatFilingCycle: (row.vatFilingCycle ?? '') as '' | 'monthly' | 'quarterly',
      urbanMaintRate:
        row.urbanMaintRate === null || row.urbanMaintRate === undefined
          ? ''
          : String(row.urbanMaintRate),
      vatExemptionEnabled: row.vatExemptionEnabled !== false,
      // §4.7(e)：`null` 必须原样带入，不能在编辑时把"未确认"变成"否" ——
      // 那会让使用者以为已经确认过不符合，从而不去补录。
      citSmallMicro: row.citSmallMicro ?? null,
      invoiceTitle: row.invoiceTitle ?? '',
      invoiceAddress: row.invoiceAddress ?? '',
      invoicePhone: row.invoicePhone ?? '',
      invoiceBank: row.invoiceBank ?? '',
      invoiceAccount: row.invoiceAccount ?? '',
      remark: row.remark ?? '',
    });
    setFieldErrors({});
    setOpen(true);
  };

  const toggleStatus = async (row: TaxEntity) => {
    if (row.status === 'active') {
      const ok = await confirmDanger(
        `确认停用纳税主体 ${row.name}？停用后不可用于新开票。`,
        { title: '确认停用' },
      );
      if (!ok) return;
    }
    try {
      await masterDataApi.toggleTaxEntityStatus(row.id);
      toast.success(row.status === 'active' ? '纳税主体已停用' : '纳税主体已启用');
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '状态更新失败'));
    }
  };

  const save = async () => {
    const parsed = taxEntitySchema.safeParse({
      code: form.code,
      name: form.name,
      taxpayerType: form.taxpayerType,
      defaultOutputRate: form.defaultOutputRate,
      defaultInputRate: form.defaultInputRate,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        if (key && !next[key]) next[key] = issue.message;
      }
      setFieldErrors(next);
      toast.error(parsed.error.issues[0]?.message ?? '请完善必填项');
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      /*
       * 城建税率**先解析再提交**。
       *
       * 原先这里直接写 `Number(form.urbanMaintRate)`：填 `7%` 会得到 NaN，
       * `JSON.stringify` 把 NaN 序列化成 `null`，而服务端 DTO 的
       * `@IsOptional() @ValidateIf(v => v !== null)` 对 null 跳过校验、
       * service 又按"显式清空"写库 → **已配置的城建税率被静默抹掉**，
       * 界面却报"保存成功"。解析器把这条路堵死：解析不出来就拒绝提交。
       */
      const urban = parseUrbanMaintRate(form.urbanMaintRate);
      if (!urban.ok) {
        setFieldErrors({ urbanMaintRate: urban.message });
        toast.error(urban.message);
        return;
      }
      const args = {
        form,
        core: {
          code: parsed.data.code,
          name: parsed.data.name,
          taxpayerType: parsed.data.taxpayerType,
          defaultOutputRate: parsed.data.defaultOutputRate,
          defaultInputRate: parsed.data.defaultInputRate,
        },
        urbanMaintRate: urban.value,
      };
      if (editing) {
        // 编辑路径**不带 code** —— 见 `tax-entity-form.ts` 文件头 ①
        await masterDataApi.updateTaxEntity(
          editing.id,
          buildTaxEntityUpdatePayload(args),
        );
        toast.success('纳税主体已更新');
      } else {
        await masterDataApi.createTaxEntity(buildTaxEntityCreatePayload(args));
        toast.success('纳税主体已创建');
      }
      setOpen(false);
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const columns: TableColumnsType<TaxEntity> = taxEntityColumns({
    openEdit,
    toggleStatus,
    reload,
  });

  const list = data ?? [];

  const urbanEmpty = form.urbanMaintRate.trim() === '';
  const cycleUnset = form.vatFilingCycle === '';

  return (
    <PageShell
      title="纳税主体"
      description="开票与计税使用的我方主体。"
      actions={
        <CanCapabilityWrite capability="tax_entity">
          <Button onClick={openCreate}>新建主体</Button>
        </CanCapabilityWrite>
      }
    >
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !error && list.length === 0}
        emptyText="还没有纳税主体。请先创建后再提交合同审批或开票。"
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          className="overflow-hidden rounded-xl border border-border/80 bg-card"
          rowKey="id"
          columns={columns}
          dataSource={list}
          pagination={false}
        />
      </DataState>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-w-[720px] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b px-6 py-4">
            <DialogTitle>{editing ? '编辑纳税主体' : '新建纳税主体'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 overflow-y-auto px-6 py-5">
            <section className="space-y-4">
              <h3 className="text-[13px] font-semibold leading-5">基本信息</h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                <div className="space-y-1.5">
                  <Explained title="编码" content="主体在系统里的唯一编号。创建之后不能再改。">
                    <FieldLabel htmlFor={codeId} required>编码</FieldLabel>
                  </Explained>
                  <Input
                    id={codeId}
                    value={form.code}
                    disabled={Boolean(editing)}
                    onChange={(e) => setForm({ ...form, code: e.target.value })}
                  />
                  {editing ? fieldStatus('创建后不可修改。') : null}
                  {fieldErrors.code ? (
                    <p className="text-[12px] leading-[18px] text-destructive">{fieldErrors.code}</p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <FieldLabel htmlFor={nameId} required>名称</FieldLabel>
                  <Input
                    id={nameId}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                  {fieldErrors.name ? (
                    <p className="text-[12px] leading-[18px] text-destructive">{fieldErrors.name}</p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Explained
                    title="统一社会信用代码"
                    content="开票和申报使用的 18 位代码。格式不对时不能保存。填错不会改税额，但票面和申报会对不上。"
                  >
                    <FieldLabel htmlFor={usccId}>统一社会信用代码</FieldLabel>
                  </Explained>
                  <Input
                    id={usccId}
                    value={form.uscc}
                    onChange={(e) => setForm({ ...form, uscc: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Explained
                    title="纳税人类型"
                    content="决定销项和进项能选哪些税率。一般纳税人和小规模纳税人的档位不同。切换类型后，两种默认税率会回到该类型的默认档。"
                  >
                    <FieldLabel required>纳税人类型</FieldLabel>
                  </Explained>
                  <Select
                    value={form.taxpayerType}
                    onValueChange={(value) => {
                      const taxpayerType = value as TaxpayerType;
                      const allowed = ALLOWED_RATES[taxpayerType];
                      setForm({
                        ...form,
                        taxpayerType,
                        defaultOutputRate: allowed[allowed.length - 1],
                        defaultInputRate: allowed[allowed.length - 1],
                      });
                    }}
                  >
                    <SelectTrigger aria-label="纳税人类型">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="general">一般纳税人</SelectItem>
                      <SelectItem value="small">小规模纳税人</SelectItem>
                    </SelectContent>
                  </Select>
                  {fieldErrors.taxpayerType ? (
                    <p className="text-[12px] leading-[18px] text-destructive">{fieldErrors.taxpayerType}</p>
                  ) : null}
                </div>
              </div>
            </section>
            <section className="space-y-4">
              <h3 className="text-[13px] font-semibold leading-5">增值税</h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                <div className="space-y-1.5">
                  <Explained
                    title="默认销项税率"
                    content="开销项发票时默认带出的税率，单据上仍可以改。只能选当前纳税人类型允许的档位。"
                  >
                    <FieldLabel required>默认销项税率</FieldLabel>
                  </Explained>
                  <Select
                    value={String(form.defaultOutputRate)}
                    onValueChange={(value) =>
                      setForm({ ...form, defaultOutputRate: Number(value) })
                    }
                  >
                    <SelectTrigger aria-label="默认销项税率">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {rates.map((rate) => (
                        <SelectItem key={rate} value={String(rate)}>
                          {rate}%
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {fieldErrors.defaultOutputRate ? (
                    <p className="text-[12px] leading-[18px] text-destructive">{fieldErrors.defaultOutputRate}</p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Explained
                    title="默认进项税率"
                    content="登记进项发票时默认带出的税率。可选档位和销项一样，随纳税人类型变化。"
                  >
                    <FieldLabel required>默认进项税率</FieldLabel>
                  </Explained>
                  <Select
                    value={String(form.defaultInputRate)}
                    onValueChange={(value) =>
                      setForm({ ...form, defaultInputRate: Number(value) })
                    }
                  >
                    <SelectTrigger aria-label="默认进项税率">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {rates.map((rate) => (
                        <SelectItem key={`in-${rate}`} value={String(rate)}>
                          {rate}%
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {fieldErrors.defaultInputRate ? (
                    <p className="text-[12px] leading-[18px] text-destructive">{fieldErrors.defaultInputRate}</p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Explained
                    title="城建税率"
                    content="市区一般填 7，县镇填 5，其他地区填 1。留空不是 0。增值税附加税会拒绝出数，避免把没配置当成免税。"
                  >
                    <FieldLabel htmlFor={urbanMaintId}>城建税率（%）</FieldLabel>
                  </Explained>
                  <Input
                    id={urbanMaintId}
                    value={form.urbanMaintRate}
                    inputMode="decimal"
                    placeholder="7、5 或 1"
                    onChange={(e) => setForm({ ...form, urbanMaintRate: e.target.value })}
                  />
                  {fieldErrors.urbanMaintRate ? (
                    <p className="text-[12px] leading-[18px] text-destructive">{fieldErrors.urbanMaintRate}</p>
                  ) : (
                    fieldStatus(urbanEmpty ? '未填写，附加税无法出数。' : null)
                  )}
                </div>
                <div className="space-y-1.5">
                  <Explained
                    title="申报周期"
                    content="只影响小规模纳税人的免征额度：按月 10 万，按季 30 万。未确认时不判断免征，可能多缴，不会少缴。一般纳税人保持未确认即可。"
                  >
                    <FieldLabel>申报周期</FieldLabel>
                  </Explained>
                  <Select
                    value={form.vatFilingCycle === '' ? 'unset' : form.vatFilingCycle}
                    onValueChange={(value) =>
                      setForm({
                        ...form,
                        vatFilingCycle:
                          value === 'unset' ? '' : (value as 'monthly' | 'quarterly'),
                      })
                    }
                  >
                    <SelectTrigger aria-label="增值税申报周期">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unset">未确认</SelectItem>
                      <SelectItem value="monthly">按月</SelectItem>
                      <SelectItem value="quarterly">按季</SelectItem>
                    </SelectContent>
                  </Select>
                  {fieldStatus(
                    cycleUnset && form.taxpayerType === 'small'
                      ? '未确认，不判断免征额度。'
                      : null,
                  )}
                </div>
              </div>
            </section>
            <section className="space-y-4">
              <h3 className="text-[13px] font-semibold leading-5">企业所得税</h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                <div className="space-y-1.5">
                  <Explained
                    title="小型微利企业"
                    content="所得额不超过 300 万、从业人数不超过 300、资产总额不超过 5000 万，三项同时满足时实际税负 5%，否则 25%。从业人数和资产总额需要你自己确认。未确认按不符合。已经选了符合，但所得额超过 300 万时，仍按 25%。"
                  >
                    <FieldLabel>小型微利企业</FieldLabel>
                  </Explained>
                  <Select
                    value={
                      form.citSmallMicro === null
                        ? 'unset'
                        : form.citSmallMicro
                          ? 'yes'
                          : 'no'
                    }
                    onValueChange={(value) =>
                      setForm({
                        ...form,
                        citSmallMicro:
                          value === 'unset' ? null : value === 'yes',
                      })
                    }
                  >
                    <SelectTrigger aria-label="小型微利企业资格">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unset">未确认</SelectItem>
                      <SelectItem value="yes">符合</SelectItem>
                      <SelectItem value="no">不符合</SelectItem>
                    </SelectContent>
                  </Select>
                  {fieldStatus(
                    form.citSmallMicro === null
                      ? '按 25% 计税，可能多缴。'
                      : form.citSmallMicro
                        ? '所得额超过 300 万时仍按 25%。'
                        : null,
                  )}
                </div>
              </div>
            </section>
          </div>
          <DialogFooter className="border-t px-6 py-4">
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? '保存中' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
};

export default TaxEntitiesPage;
