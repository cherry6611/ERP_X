import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { AccountStatusBadge, ACCOUNT_TYPE_LABELS } from './VoucherBadges';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@client/src/components/ui/form';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { voucherApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { useListQuery } from '@client/src/hooks/useListQuery';
import type { AccountItem, CreateAccountDto } from '@shared/api.interface';

const accountSchema = z.object({
  code: z.string().min(1, '请输入科目编码'),
  name: z.string().min(1, '请输入科目名称'),
  accountType: z.string().min(1, '请选择科目类型'),
  remark: z.string(),
});

type AccountFormData = z.infer<typeof accountSchema>;

const EMPTY_FORM: AccountFormData = {
  code: '',
  name: '',
  accountType: '',
  remark: '',
};

const PAGE_SIZE = 20;

const AccountPanel: React.FC = () => {
  const { q, setQ, debouncedQ, page, setPage, debouncing } = useListQuery();
  const [createOpen, setCreateOpen] = useState(false);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData(
    () =>
      voucherApi.listAccounts({
        page,
        pageSize: PAGE_SIZE,
        keyword: debouncedQ || undefined,
      }),
    [page, debouncedQ],
  );

  const form = useForm<AccountFormData>({
    resolver: zodResolver(accountSchema),
    defaultValues: EMPTY_FORM,
  });

  const openCreate = () => {
    form.reset(EMPTY_FORM);
    setCreateOpen(true);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateAccountDto = {
      code: values.code,
      name: values.name,
      accountType: values.accountType as CreateAccountDto['accountType'],
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      await voucherApi.createAccount(dto);
      toast.success('科目已创建');
      setCreateOpen(false);
      setPage(1);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建科目失败');
    } finally {
      setOperating(false);
    }
  });

  const columns: TableColumnsType<AccountItem> = [
    { title: '编码', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '名称', dataIndex: 'name', width: 200 },
    {
      title: '类型',
      dataIndex: 'accountType',
      width: 100,
      render: (v: string) => ACCOUNT_TYPE_LABELS[v] ?? v,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <AccountStatusBadge status={v} />,
    },
    {
      title: '备注',
      dataIndex: 'remark',
      render: (v: string | null) => v ?? '-',
    },
    {
      // A-09：科目启用/停用。此前只有"新建"没有"停用"，
      // 建账模板带入的多余科目（如 1403 原材料）无法清理。
      title: '操作',
      key: 'actions',
      width: 90,
      fixed: 'right',
      render: (_: unknown, record: AccountItem) => {
        const isActive = (record.status ?? 'active') === 'active';
        return (
          <Button
            variant="ghost"
            size="sm"
            disabled={operating}
            onClick={() => void toggleStatus(record, isActive)}
          >
            {isActive ? '停用' : '启用'}
          </Button>
        );
      },
    },
  ];

  /**
   * 停用是**有门槛**的：后端会拒绝「有下级科目」或「已有凭证发生额」的科目。
   * 这里在点击前先做一次确认，并把门槛原因讲清楚 ——
   * 否则业务方点了才被拒，会以为是系统故障。
   */
  const toggleStatus = async (record: AccountItem, isActive: boolean) => {
    if (isActive) {
      const confirmed = await confirmDanger(
        `停用后科目「${record.name}」（${record.code}）将不接受新凭证。` +
          '若该科目已有凭证发生额或存在下级科目，系统会拒绝停用 —— ' +
          '因为其历史余额仍会出现在报表中，却无法再做账，会造成"看得到、动不了"的状态。',
        { title: `停用科目 ${record.code}？`, confirmLabel: '停用' },
      );
      if (!confirmed) return;
    }
    setOperating(true);
    try {
      await voucherApi.setAccountStatus(record.code, {
        status: isActive ? 'inactive' : 'active',
      });
      toast.success(`科目 ${record.code} 已${isActive ? '停用' : '启用'}`);
      await reload();
    } catch (err) {
      toast.error(
        getApiErrorMessage(err, isActive ? '停用科目失败' : '启用科目失败'),
      );
    } finally {
      setOperating(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="voucher-account-keyword">关键字</Label>
          <Input
            id="voucher-account-keyword"
            className="w-56"
            placeholder="搜索科目编码或名称"
            value={q}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setQ(e.target.value)
            }
          />
          {debouncing ? (
            <span className="text-xs text-muted-foreground">筛选中…</span>
          ) : null}
        </div>
        <CanCapabilityWrite capability="finance_write">
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            新增科目
          </Button>
        </CanCapabilityWrite>
      </div>
      {error ? (
        <p className="text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reload()}>
            重试
          </Button>
        </p>
      ) : null}
      <Table
        columns={columns}
        dataSource={data?.items ?? []}
        loading={loading}
        rowKey="id"
        scroll={{ x: 900, y: 480 }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          onChange: (p: number) => setPage(p),
        }}
        locale={{ emptyText: '暂无科目，点击右上角新增科目' }}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>新增科目</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="code"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        科目编码 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="如 1001" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        科目名称 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="如 库存现金" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="accountType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      科目类型 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择科目类型" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Input placeholder="请输入备注" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit" disabled={operating}>
                  创建科目
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AccountPanel;
