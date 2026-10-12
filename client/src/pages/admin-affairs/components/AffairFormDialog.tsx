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
import type { AdminAffairItem } from '@shared/api.interface';

const TYPE_OPTIONS = [
  { value: 'vehicle', label: '用车' },
  { value: 'travel', label: '差旅' },
] as const;

const affairSchema = z.object({
  affairType: z.enum(['vehicle', 'travel']),
  title: z.string().min(1, '请填写事由'),
  participants: z.array(z.string()),
  startDate: z.string().min(1, '请选择开始日期'),
  endDate: z.string(),
  amount: z
    .string()
    .refine(
      (v) =>
        v === '' || (!Number.isNaN(Number(v)) && Number(v) >= 0),
      '金额需为非负数字',
    ),
  remark: z.string(),
});

type AffairFormData = z.output<typeof affairSchema>;

const EMPTY_FORM: z.input<typeof affairSchema> = {
  affairType: 'vehicle',
  title: '',
  participants: [],
  startDate: '',
  endDate: '',
  amount: '',
  remark: '',
};

interface AffairFormDialogProps {
  open: boolean;
  target: AdminAffairItem | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void | Promise<void>;
}

const AffairFormDialog: React.FC<AffairFormDialogProps> = ({
  open,
  target,
  onOpenChange,
  onSuccess,
}) => {
  const [operating, setOperating] = useState(false);

  const form = useForm<z.input<typeof affairSchema>, unknown, AffairFormData>({
    resolver: zodResolver(affairSchema),
    defaultValues: EMPTY_FORM,
  });

  useEffect(() => {
    if (!open) return;
    form.reset(
      target
        ? {
            affairType: target.affairType,
            title: target.title,
            participants: target.participants,
            startDate: target.startDate,
            endDate: target.endDate ?? '',
            amount: target.amount == null ? '' : String(target.amount),
            remark: target.remark ?? '',
          }
        : EMPTY_FORM,
    );
  }, [open, target, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    setOperating(true);
    try {
      const amountValue =
        values.amount === '' ? undefined : Number(values.amount);
      if (target) {
        await adminApi.updateAdminAffair(target.id, {
          affairType: values.affairType,
          title: values.title,
          participants: values.participants,
          startDate: values.startDate,
          endDate: values.endDate || null,
          amount: amountValue ?? null,
          remark: values.remark || null,
        });
        toast.success('事务已更新');
      } else {
        await adminApi.createAdminAffair({
          affairType: values.affairType,
          title: values.title,
          participants:
            values.participants.length > 0 ? values.participants : undefined,
          startDate: values.startDate,
          endDate: values.endDate || undefined,
          amount: amountValue,
          remark: values.remark || undefined,
        });
        toast.success('事务已登记');
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
          <DialogTitle>{target ? '编辑事务' : '新建事务'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="affairType"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>
                      类型{' '}
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
                          <SelectValue placeholder="请选择类型" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {TYPE_OPTIONS.map((opt) => (
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
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-56">
                    <FormLabel>
                      事由{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：客户拜访用车" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="participants"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>参与人</FormLabel>
                  <UserSelect
                    multiple
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="请选择参与人"
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="startDate"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>
                      开始日期{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
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
                name="endDate"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>结束日期</FormLabel>
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
                name="amount"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>金额（元）</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder="选填"
                        {...field}
                      />
                    </FormControl>
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

export default AffairFormDialog;
