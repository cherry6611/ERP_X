/**
 * 「新增资产」弹窗
 *
 * §5.9（F8）：从 `AssetPanel.tsx` 抽出的独立弹窗组件（原 `<Dialog open={createOpen}>` 块）。
 *
 * ⚠️ **本组件是原块的逐字搬运**，只做了三件事：
 *   ① `createOpen` / `setCreateOpen` 改为 props（`open` / `onOpenChange`）；
 *   ② `operating` / `setOperating` 由父组件按**同名 props** 传入 —— 原实现里它与
 *      「发起资产变更」弹窗**共用**同一个布尔值（任一弹窗提交时两处提交按钮一起置灰），
 *      保持共用可让该语义逐字不变；
 *   ③ 提交成功后的 `await Promise.all([reload(), reloadOverview()])` 改为父组件传入的
 *      `await onSaved()`；它前面那行 `setPage(1)` 通过同名 prop `setPage` 原样留下
 *      —— 因此"先 `setPage(1)`、再 `await` 列表与总览重取"的**顺序与 await 链**
 *      逐字不变（提交失败仍会走 catch 并弹 toast）。
 * 字段、schema、默认值、校验、文案、`Select` 的取值与顺序、按钮文案全部未动。
 *
 * ## reset 语义（**已核对：本弹窗没有 reset-on-open**）
 *
 * 原文件里 `createForm.reset(EMPTY_ASSET_FORM)` 只有**一处** —— 创建成功之后（见下）。
 * 打开弹窗时**没有任何清空动作**，所以「填一半 → 取消 → 再打开」会看到上一次的值；
 * 拆分后同样如此，**未新增任何 reset**。
 *
 * 表单实例随弹窗搬进本文件：父组件没有任何入口（表格行按钮 / 筛选区 / 页头按钮）
 * 触碰它，搬走不改变任何触发点。
 */
import React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { assetApi, masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { ASSET_CATEGORY_LABELS } from '../AssetStatusBadge';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Textarea } from '@client/src/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Explained } from '@client/src/components/erp/ItemHelp';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import DateField from '@client/src/components/erp/DateField';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import type {
  CreateAssetDto,
  Department,
  Project,
} from '@shared/api.interface';

const assetFormSchema = z.object({
  name: z.string().min(1, '请填写资产名称'),
  category: z.string().min(1, '请选择资产类别'),
  originalValue: z.coerce.number().positive('原值必须大于 0'),
  residualValue: z.coerce.number().min(0, '残值不能为负'),
  usefulMonths: z.coerce.number().int().min(1, '折旧月数至少为 1'),
  departmentId: z.string(),
  projectId: z.string(),
  taxEntityId: z.string(),
  purchaseDate: z.string(),
  remark: z.string(),
});

const EMPTY_ASSET_FORM = {
  name: '',
  category: 'server_gpu',
  originalValue: 0,
  residualValue: 0,
  usefulMonths: 36,
  departmentId: '',
  projectId: '',
  taxEntityId: '',
  purchaseDate: '',
  remark: '',
};

interface AssetCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 归属部门下拉的数据源（父组件查询，两处共用） */
  departments: Department[] | undefined;
  /** 归属项目下拉的数据源（父组件查询，筛选区也用它） */
  projects: Project[] | undefined;
  /** 与「发起资产变更」弹窗共用（父组件状态，按同名 prop 传入） */
  operating: boolean;
  setOperating: (operating: boolean) => void;
  /** 创建成功后回到第 1 页（父组件状态，按同名 prop 传入） */
  setPage: (page: number) => void;
  /** 创建成功后的父组件动作：重取列表与总览（原 `Promise.all([reload(), reloadOverview()])`） */
  onSaved: () => void | Promise<unknown>;
}

const AssetCreateDialog: React.FC<AssetCreateDialogProps> = ({
  open,
  onOpenChange,
  departments,
  projects,
  operating,
  setOperating,
  setPage,
  onSaved,
}) => {
  const createForm = useForm<
    z.input<typeof assetFormSchema>,
    unknown,
    z.output<typeof assetFormSchema>
  >({
    resolver: zodResolver(assetFormSchema),
    defaultValues: EMPTY_ASSET_FORM,
  });
  const { data: taxEntities } = useAsyncData(
    () => masterDataApi.listTaxEntities(),
    [],
  );

  const onCreateSubmit = createForm.handleSubmit(async (values) => {
    const dto: CreateAssetDto = {
      name: values.name,
      category: values.category as CreateAssetDto['category'],
      originalValue: values.originalValue,
      residualValue: values.residualValue,
      usefulMonths: values.usefulMonths,
      departmentId: values.departmentId || undefined,
      projectId: values.projectId || undefined,
      taxEntityId: values.taxEntityId || undefined,
      purchaseDate: values.purchaseDate || undefined,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      await assetApi.createAsset(dto);
      toast.success('资产已创建');
      onOpenChange(false);
      createForm.reset(EMPTY_ASSET_FORM);
      setPage(1);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建资产失败');
    } finally {
      setOperating(false);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>新增资产</DialogTitle>
          <DialogDescription>
            净值初始为原值减残值，状态默认在用
          </DialogDescription>
        </DialogHeader>
        <Form {...createForm}>
          <form
            onSubmit={onCreateSubmit}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-wrap gap-4">
              <FormField
                control={createForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      资产名称{' '}
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
                control={createForm.control}
                name="category"
                render={({ field }) => (
                  <FormItem className="w-44">
                    <FormLabel>
                      资产类别{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(ASSET_CATEGORY_LABELS).map(
                          ([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <FormField
                control={createForm.control}
                name="originalValue"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      原值（元）{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        value={String(field.value ?? '')}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={createForm.control}
                name="residualValue"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <Explained
                      title="残值"
                      content="折旧到这个金额后不再计提。它不是采购原值。残值不能大于原值。"
                    >
                      <FormLabel>残值（元）</FormLabel>
                    </Explained>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        value={String(field.value ?? '')}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={createForm.control}
                name="usefulMonths"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <Explained
                      title="折旧月数"
                      content="从采购日期所在期间的下一期开始，按这个月数计提折旧。处置和减值会提前结束或减少以后的折旧。"
                    >
                      <FormLabel>折旧月数</FormLabel>
                    </Explained>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        value={String(field.value ?? '')}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={createForm.control}
              name="taxEntityId"
              render={({ field }) => (
                <FormItem>
                  <Explained
                    title="我方纳税主体"
                    content="折旧凭证记到这个纳税主体。合同上已有主体时以合同为准；没有合同时必须选，否则不会计提。"
                  >
                    <FormLabel>我方纳税主体</FormLabel>
                  </Explained>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value || undefined}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="多主体且合同无主体时必填" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(taxEntities ?? []).map((entity) => (
                          <SelectItem key={entity.id} value={entity.id}>
                            {entity.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex flex-wrap gap-4">
              <FormField
                control={createForm.control}
                name="departmentId"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>归属部门</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value || undefined}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="不归属部门" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(departments ?? []).map((d: Department) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={createForm.control}
                name="projectId"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>归属项目</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value || undefined}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="不归属项目" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(projects ?? []).map((p: Project) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={createForm.control}
                name="purchaseDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <Explained
                      title="采购日期"
                      content="决定折旧从哪一期开始计提。改采购日期会改后续折旧期间。"
                    >
                      <FormLabel>采购日期</FormLabel>
                    </Explained>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={createForm.control}
              name="remark"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>备注</FormLabel>
                  <FormControl>
                    <Textarea placeholder="选填" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <AttachmentHint text="保存后可在发起变更时上传资产照片、采购凭证、验收单等附件" />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={operating}>
                保存
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default AssetCreateDialog;
