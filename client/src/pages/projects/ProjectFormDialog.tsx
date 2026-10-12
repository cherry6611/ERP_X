import React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import DateField from '@client/src/components/erp/DateField';
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
import { contractsApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import type { Contract, CreateProjectDto } from '@shared/api.interface';

const projectSchema = z.object({
  name: z.string().min(1, '项目名称不能为空'),
  contractId: z.string().min(1, '请选择关联合同'),
  pm: z.string(),
  deptName: z.string(),
  budget: z.coerce.number().min(0),
  estimatedTotalCost: z
    .union([z.literal(''), z.coerce.number().min(0, '预计总成本不能为负数')])
    .transform((v) => (v === '' ? undefined : v)),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  remark: z.string(),
});

type ProjectFormData = z.output<typeof projectSchema>;
type ProjectFormInput = z.input<typeof projectSchema>;

interface ProjectFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}

const ProjectFormDialog: React.FC<ProjectFormDialogProps> = ({
  open,
  onOpenChange,
  onCreated,
}) => {
  const { data: contracts } = useAsyncData<Contract[]>(
    () => contractsApi.listContracts(),
    [],
  );

  const form = useForm<ProjectFormInput, unknown, ProjectFormData>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      name: '',
      contractId: '',
      pm: '',
      deptName: '',
      budget: 0,
      estimatedTotalCost: '',
      remark: '',
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateProjectDto = {
      name: values.name,
      contractId: values.contractId,
      pm: values.pm || undefined,
      deptName: values.deptName || undefined,
      budget: values.budget || undefined,
      estimatedTotalCost: values.estimatedTotalCost,
      startDate: values.startDate,
      endDate: values.endDate,
      remark: values.remark || undefined,
    };
    try {
      const created = await projectsApi.createProject(dto);
      toast.success('项目已立项');
      onOpenChange(false);
      form.reset({
        name: '',
        contractId: '',
        pm: '',
        deptName: '',
        budget: 0,
        estimatedTotalCost: '',
        remark: '',
      });
      onCreated(created.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '立项失败');
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>项目立项</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    项目名称 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="请输入项目名称" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="contractId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    关联合同 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择关联合同" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(contracts ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.code} - {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="pm"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>项目经理</FormLabel>
                    <FormControl>
                      <Input placeholder="请输入项目经理" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="deptName"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>所属部门</FormLabel>
                    <FormControl>
                      <Input placeholder="请输入部门" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="budget"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>预算基线（元）</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        value={String(field.value ?? '')}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="estimatedTotalCost"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>预计总成本（元）</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        placeholder="选填"
                        value={String(field.value ?? '')}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="startDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>开始日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>结束日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
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
            <AttachmentHint text="保存后将自动打开详情，可在其中上传立项文档、方案文件等附件" />
            <DialogFooter>
              <Button type="submit">立项</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default ProjectFormDialog;
