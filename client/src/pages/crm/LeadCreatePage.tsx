import React from 'react';
import { useNavigate } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import DateField from '@client/src/components/erp/DateField';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import { Button } from '@client/src/components/ui/button';
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
import { crmApi } from '@client/src/api';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { CreateLeadDto } from '@shared/api.interface';

const LEAD_SOURCES = ['官网咨询', '展会', '转介绍', '主动开发', '其他'];

const leadSchema = z.object({
  customerName: z.string().min(1, '客户名称不能为空'),
  source: z.string(),
  contactName: z.string(),
  contactPhone: z.string(),
  owner: z.string(),
  nextDate: z.string().optional(),
  remark: z.string(),
});

type LeadFormData = z.infer<typeof leadSchema>;

const LeadCreatePage: React.FC = () => {
  const navigate = useNavigate();
  const form = useForm<LeadFormData>({
    resolver: zodResolver(leadSchema),
    defaultValues: {
      customerName: '',
      source: '官网咨询',
      contactName: '',
      contactPhone: '',
      owner: '',
      remark: '',
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateLeadDto = { ...values };
    try {
      const created = await crmApi.createLead(dto);
      toast.success('线索已创建');
      navigate(`/crm/leads/${created.id}`, { replace: true });
    } catch (err) {
      toast.error(getApiErrorMessage(err, '登记失败'));
    }
  });

  return (
    <PageShell
      title="新建线索"
      description="登记线索后进入详情页上传需求文档与沟通记录"
      actions={
        <Button variant="outline" onClick={() => navigate('/crm?tab=leads')}>
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>
      }
    >
      <div className="mx-auto max-w-lg">
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="customerName"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      客户名称{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="请输入客户名称" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="source"
                render={({ field }) => (
                  <FormItem className="w-40">
                    <FormLabel>来源</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {LEAD_SOURCES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="contactName"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>联系人</FormLabel>
                    <FormControl>
                      <Input placeholder="联系人姓名" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="contactPhone"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>电话</FormLabel>
                    <FormControl>
                      <Input placeholder="联系电话" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="owner"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>负责人</FormLabel>
                    <FormControl>
                      <Input placeholder="负责人" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="nextDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>下次跟进</FormLabel>
                    <FormControl>
                      <DateField
                        value={field.value}
                        onChange={field.onChange}
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
                    <Textarea placeholder="备注信息" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <AttachmentHint text="保存后将进入详情页，可上传客户需求文档、沟通记录等附件" />
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate('/crm?tab=leads')}
              >
                取消
              </Button>
              <Button type="submit">保存</Button>
            </div>
          </form>
        </Form>
      </div>
    </PageShell>
  );
};

export default LeadCreatePage;
