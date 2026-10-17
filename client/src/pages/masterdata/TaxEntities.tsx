import React, { useState } from 'react';
import { toast } from 'sonner';
import { Table, TableColumnsType } from 'antd';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { FieldLabel, useFieldId } from '@client/src/components/erp/FieldLabel';
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

  return (
    <PageShell title="纳税主体" description="维护开票主体。主体由人工创建，系统不预置。">
      <div className="flex justify-end">
        <CanCapabilityWrite capability="tax_entity">
          <Button onClick={openCreate}>新建主体</Button>
        </CanCapabilityWrite>
      </div>
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !error && list.length === 0}
        emptyText="还没有纳税主体。请先创建后再提交合同审批或开票。"
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          rowKey="id"
          columns={columns}
          dataSource={list}
          pagination={false}
        />
      </DataState>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑纳税主体' : '新建纳税主体'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <FieldLabel htmlFor={codeId} required>编码</FieldLabel>
              {/*
                编码**创建后不可修改**：服务端 `UpdateTaxEntityDto` 里没有 `code`
                字段（全局 ValidationPipe 开了 forbidNonWhitelisted，带上即 400）。
                原先这个输入框在编辑时仍可编辑，用户改完保存只会拿到
                `400 code: property code should not exist` —— 一个不存在的入口。
                这里改为编辑时禁用，让界面与服务端能力一致。
              */}
              <Input
                id={codeId}
                value={form.code}
                disabled={Boolean(editing)}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
              {editing ? (
                <p className="text-sm text-muted-foreground">编码创建后不可修改</p>
              ) : null}
              {fieldErrors.code ? (
                <p className="text-sm text-destructive">{fieldErrors.code}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <FieldLabel htmlFor={nameId} required>名称</FieldLabel>
              <Input
                id={nameId}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              {fieldErrors.name ? (
                <p className="text-sm text-destructive">{fieldErrors.name}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <FieldLabel htmlFor={usccId}>统一社会信用代码</FieldLabel>
              <Input
                id={usccId}
                value={form.uscc}
                onChange={(e) => setForm({ ...form, uscc: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <FieldLabel required>纳税人类型</FieldLabel>
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
                <p className="text-sm text-destructive">{fieldErrors.taxpayerType}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <FieldLabel required>默认销项税率</FieldLabel>
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
                <p className="text-sm text-destructive">{fieldErrors.defaultOutputRate}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              {/*
                a11y（§5.10 / P2-3）：本字段漏了可访问名 —— 同文件其余复合控件
                （纳税人类型 / 默认销项税率 / 申报周期 / 小微资格）都给
                `<SelectTrigger aria-label="…">`，只有这里没有，于是读屏器
                只念"组合框"。与同文件保持一致，补 `aria-label`。
                （`FieldLabel` 渲染的是 `<label>` 却没有 `for`，对 Radix
                触发器给不出可访问名，故不走 `htmlFor`。）
              */}
              <FieldLabel required>默认进项税率</FieldLabel>
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
                <p className="text-sm text-destructive">{fieldErrors.defaultInputRate}</p>
              ) : null}
            </div>
            {/*
              T9：城建税率。原先**界面上根本没有这个入口** ——
              后端字段存在、库约束存在、附加税计提依赖它，但使用者无处录入，
              于是底稿永远是"主体未配置城建税率，附加税费无法计提"（阻断出数）。
              这不是后端缺陷，是**配置入口缺失**，且只有走到增值税底稿才会暴露。
            */}
            <div className="space-y-1">
              <FieldLabel htmlFor={urbanMaintId}>城建税率（%）</FieldLabel>
              <Input
                id={urbanMaintId}
                value={form.urbanMaintRate}
                inputMode="decimal"
                placeholder="市区 7 / 县镇 5 / 其他 1；留空 = 未配置"
                onChange={(e) => setForm({ ...form, urbanMaintRate: e.target.value })}
              />
              {fieldErrors.urbanMaintRate ? (
                <p className="text-sm text-destructive">{fieldErrors.urbanMaintRate}</p>
              ) : null}
              <p className="text-sm text-muted-foreground">
                未配置时增值税底稿的附加税费会**拒绝出数**（不按 0 计提），这是有意设计。
              </p>
            </div>
            {/*
              T9：申报周期。小规模免征额度（月 10 万 / 季 30 万）判定的必要要件，
              同样原先没有录入入口。未声明时底稿按偏严口径不减免（不会少缴，
              但可能长期多缴），并在差异区提示补录。
            */}
            <div className="space-y-1">
              <FieldLabel>增值税申报周期</FieldLabel>
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
                  <SelectItem value="unset">未声明（不做免征判定，偏严）</SelectItem>
                  <SelectItem value="monthly">按月申报（免征额度 10 万/月）</SelectItem>
                  <SelectItem value="quarterly">按季申报（免征额度 30 万/季）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                仅小规模纳税人的两项附加免征判定需要它；一般纳税人可留空。
              </p>
            </div>
            {/*
              §4.7(e)：企业所得税「小型微利企业」资格。

              原先完全没有这个字段 —— 而它是 5% 与 25% 的分水岭：
              同一个 100 万应纳税所得额，税额差 **20 万**。
              系统里没有录入入口时，企业所得税只能线下拍一个税率。

              三态必须都露出（未确认 / 是 / 否）：
              把"未确认"和"否"合并成一个默认值，使用者就不知道
              "我到底确认过没有"，从而不去补录 —— 而按偏严口径
              （未确认 = 不享受）会一直多缴着 25%。
            */}
            <div className="space-y-1">
              <FieldLabel>小型微利企业资格（企业所得税）</FieldLabel>
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
                  <SelectItem value="unset">未确认（按不享受处理，偏严）</SelectItem>
                  <SelectItem value="yes">
                    符合（应纳税所得额 ≤ 300 万 且 从业人数 ≤ 300 且 资产总额 ≤ 5000 万）→ 实际税负 5%
                  </SelectItem>
                  <SelectItem value="no">不符合 → 25%</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                三个条件须**同时**满足且需人工确认：从业人数与资产总额本系统没有取数能力，
                故不做自动判定。未确认时按不享受处理（多缴而非少缴）；
                应纳税所得额超过 300 万时即使选"符合"也会自动降为 25%。
              </p>
            </div>
          </div>
          <DialogFooter>
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
