import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { adminApi } from '@client/src/api';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { Textarea } from '@client/src/components/ui/textarea';
import { UserSelect } from '@client/src/components/business-ui/user-select';
import DateField from '@client/src/components/erp/DateField';
import type { AdminAssetItem } from '@shared/api.interface';

const CATEGORY_OPTIONS = [
  { value: 'office_equipment', label: '办公设备' },
  { value: 'office_furniture', label: '办公家具' },
  { value: 'other', label: '其他' },
] as const;

const STATUS_OPTIONS = [
  { value: 'in_use', label: '在用' },
  { value: 'idle', label: '闲置' },
  { value: 'scrapped', label: '已报废' },
] as const;

const assetSchema = z.object({
  name: z.string().min(1, '请填写资产名称'),
  category: z.enum(['office_equipment', 'office_furniture', 'other']),
  quantity: z
    .string()
    .refine(
      (v) => Number.isInteger(Number(v)) && Number(v) >= 1,
      '数量需为不小于 1 的整数',
    ),
  unitPrice: z
    .string()
    .refine(
      (v) => v !== '' && !Number.isNaN(Number(v)) && Number(v) >= 0,
      '单价需为非负数字',
    ),
  location: z.string(),
  owner: z.string().nullable(),
  purchaseDate: z.string(),
  status: z.enum(['in_use', 'idle', 'scrapped']),
  remark: z.string(),
});

type AssetFormData = z.output<typeof assetSchema>;

const EMPTY_FORM: z.input<typeof assetSchema> = {
  name: '',
  category: 'office_equipment',
  quantity: '1',
  unitPrice: '0',
  location: '',
  owner: null,
  purchaseDate: '',
  status: 'in_use',
  remark: '',
};

interface AssetFormDialogProps {
  open: boolean;
  target: AdminAssetItem | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void | Promise<void>;
}

const AssetFormDialog: React.FC<AssetFormDialogProps> = ({
  open,
  target,
  onOpenChange,
  onSuccess,
}) => {
  const [operating, setOperating] = useState(false);

  const form = useForm<z.input<typeof assetSchema>, unknown, AssetFormData>({
    resolver: zodResolver(assetSchema),
    defaultValues: EMPTY_FORM,
  });

  useEffect(() => {
    if (!open) return;
    form.reset(
      target
        ? {
            name: target.name,
            category: target.category,
            quantity: String(target.quantity),
            unitPrice: String(target.unitPrice),
            location: target.location ?? '',
            owner: target.owner,
            purchaseDate: target.purchaseDate ?? '',
            status: target.status,
            remark: target.remark ?? '',
          }
        : EMPTY_FORM,
    );
  }, [open, target, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    const quantity = Number(values.quantity);
    const unitPrice = Number(values.unitPrice);
    setOperating(true);
    try {
      if (target) {
        await adminApi.updateAdminAsset(target.id, {
          name: values.name,
          category: values.category,
          quantity,
          unitPrice,
          location: values.location || null,
          owner: values.owner ?? null,
          purchaseDate: values.purchaseDate || null,
          status: values.status,
          remark: values.remark || null,
        });
        toast.success('资产已更新');
      } else {
        await adminApi.createAdminAsset({
          name: values.name,
          category: values.category,
          quantity,
          unitPrice,
          location: values.location || undefined,
          owner: values.owner ?? undefined,
          purchaseDate: values.purchaseDate || undefined,
          status: values.status,
          remark: values.remark || undefined,
        });
        toast.success('资产已登记');
      }
      onOpenChange(false);
      await onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setOperating(false);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{target ? '编辑资产' : '新建资产'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-56">
                    <FormLabel>
                      名称{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="请输入资产名称" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>
                      类别{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择类别" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CATEGORY_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="quantity"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>
                      数量{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input type="number" min={1} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="unitPrice"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>
                      单价（元）{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <p className="w-full text-sm text-muted-foreground">
                金额按 数量 × 单价 由系统自动计算
              </p>
            </div>
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="location"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>位置</FormLabel>
                    <FormControl>
                      <Input placeholder="如：3 号楼 201" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="owner"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>责任人</FormLabel>
                    <UserSelect
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="请选择责任人"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="purchaseDate"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>购买日期</FormLabel>
                    <DateField
                      value={field.value || null}
                      onChange={(v) => field.onChange(v ?? '')}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>
                      状态{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择状态" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {STATUS_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="remark"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>备注</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="选填"
                      rows={2}
                      className="resize-none"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={operating}>
                {operating ? '保存中…' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default AssetFormDialog;
