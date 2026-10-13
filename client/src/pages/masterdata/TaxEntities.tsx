import React, { useState } from 'react';
import { z } from 'zod';
import { toast } from 'sonner';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
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
import { ALLOWED_RATES, type TaxpayerType } from '@shared/tax';

const EMPTY = {
  code: '',
  name: '',
  uscc: '',
  taxpayerType: 'general' as TaxpayerType,
  defaultOutputRate: 6,
  defaultInputRate: 6,
  invoiceTitle: '',
  invoiceAddress: '',
  invoicePhone: '',
  invoiceBank: '',
  invoiceAccount: '',
  remark: '',
};

const taxEntitySchema = z.object({
  code: z.string().trim().min(1, '编码不能为空'),
  name: z.string().trim().min(1, '名称不能为空'),
  taxpayerType: z.enum(['general', 'small'], {
    message: '请选择纳税人类型',
  }),
  defaultOutputRate: z.number({
    message: '请选择默认销项税率',
  }),
  defaultInputRate: z.number({
    message: '请选择默认进项税率',
  }),
}).superRefine((data, ctx) => {
  const allowed = ALLOWED_RATES[data.taxpayerType] as readonly number[];
  if (!allowed.includes(data.defaultOutputRate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultOutputRate'],
      message: '销项税率不在允许范围内',
    });
  }
  if (!allowed.includes(data.defaultInputRate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultInputRate'],
      message: '进项税率不在允许范围内',
    });
  }
});

const TaxEntitiesPage: React.FC = () => {
  const { data, loading, error, reload } = useAsyncData<TaxEntity[]>(
    () => masterDataApi.listTaxEntities(),
    []
  );
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TaxEntity | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const rates = ALLOWED_RATES[form.taxpayerType];

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY);
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
      const payload = {
        ...form,
        code: parsed.data.code,
        name: parsed.data.name,
        taxpayerType: parsed.data.taxpayerType,
        defaultOutputRate: parsed.data.defaultOutputRate,
        defaultInputRate: parsed.data.defaultInputRate,
        uscc: form.uscc.trim() === '' ? null : form.uscc.trim(),
      };
      if (editing) {
        await masterDataApi.updateTaxEntity(editing.id, payload);
        toast.success('纳税主体已更新');
      } else {
        await masterDataApi.createTaxEntity(payload);
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

  const columns: TableColumnsType<TaxEntity> = [
    { title: '编码', dataIndex: 'code', width: 120 },
    { title: '名称', dataIndex: 'name', width: 200 },
    {
      title: '类型',
      dataIndex: 'taxpayerType',
      width: 120,
      render: (value: TaxpayerType) => (value === 'general' ? '一般纳税人' : '小规模'),
    },
    { title: '销项税率', dataIndex: 'defaultOutputRate', width: 100, render: (v: number) => `${v}%` },
    { title: '进项税率', dataIndex: 'defaultInputRate', width: 100, render: (v: number) => `${v}%` },
    {
      title: '默认',
      dataIndex: 'isDefault',
      width: 80,
      render: (value: boolean) => (value ? '是' : ''),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: string) => (value === 'active' ? '启用' : '停用'),
    },
    {
      title: '操作',
      key: 'action',
      width: 260,
      render: (_value, row) => (
        <CanRole roles={['admin']}>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
              编辑
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                masterDataApi
                  .setDefaultTaxEntity(row.id)
                  .then(() => reload())
                  .catch((err: unknown) =>
                    toast.error(getApiErrorMessage(err, '设置失败'))
                  )
              }
            >
              设为默认
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                masterDataApi
                  .toggleTaxEntityStatus(row.id)
                  .then(() => reload())
                  .catch((err: unknown) =>
                    toast.error(getApiErrorMessage(err, '状态更新失败'))
                  )
              }
            >
              {row.status === 'active' ? '停用' : '启用'}
            </Button>
          </div>
        </CanRole>
      ),
    },
  ];

  return (
    <PageShell title="纳税主体" description="维护开票主体。主体由人工创建，系统不预置。">
      {error ? (
        <p className="text-sm text-destructive">
          {typeof error === 'string' ? error : '加载失败'}
        </p>
      ) : null}
      <div className="flex justify-end">
        <CanRole roles={['admin']}>
          <Button onClick={openCreate}>新建主体</Button>
        </CanRole>
      </div>
      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={data ?? []}
        pagination={false}
        locale={{ emptyText: '还没有纳税主体。请先创建后再提交合同审批或开票。' }}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑纳税主体' : '新建纳税主体'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>
                编码 <span aria-hidden="true" className="text-destructive">*</span>
              </Label>
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
              {fieldErrors.code ? (
                <p className="text-sm text-destructive">{fieldErrors.code}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label>
                名称 <span aria-hidden="true" className="text-destructive">*</span>
              </Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              {fieldErrors.name ? (
                <p className="text-sm text-destructive">{fieldErrors.name}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label>统一社会信用代码</Label>
              <Input value={form.uscc} onChange={(e) => setForm({ ...form, uscc: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>
                纳税人类型 <span aria-hidden="true" className="text-destructive">*</span>
              </Label>
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
                <SelectTrigger>
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
              <Label>
                默认销项税率 <span aria-hidden="true" className="text-destructive">*</span>
              </Label>
              <Select
                value={String(form.defaultOutputRate)}
                onValueChange={(value) =>
                  setForm({ ...form, defaultOutputRate: Number(value) })
                }
              >
                <SelectTrigger>
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
              <Label>
                默认进项税率 <span aria-hidden="true" className="text-destructive">*</span>
              </Label>
              <Select
                value={String(form.defaultInputRate)}
                onValueChange={(value) =>
                  setForm({ ...form, defaultInputRate: Number(value) })
                }
              >
                <SelectTrigger>
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
