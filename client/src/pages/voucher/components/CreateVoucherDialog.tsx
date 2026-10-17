/**
 * 新增手工凭证弹窗（§5.9 / F8）。
 *
 * 从 `VoucherPanel.tsx` 抽出的**自包含**弹窗：`useFieldArray` 分录编辑器、
 * 按科目必挂维度渲染的辅助核算输入框（含 `datalist` 提示）、借贷合计与
 * 提交/错误提示都在这里。表单与数据由 `./use-voucher-create-form` 提供 ——
 * 该 hook 在这个组件**顶层无条件**调用，而本组件在面板里是常驻挂载的，
 * 因此副作用触发时机与原实现逐次对应（详见 hook 文件头）。
 *
 * ⚠️ **行为零变更**：JSX 是原块的逐字搬运 —— 只做了四件事：
 *   ① 整体去掉一层缩进（`<Dialog>` 由 6 空格缩进变为 4 空格）；
 *   ② `createOpen` / `setCreateOpen` 改为 props `open` / `onOpenChange`；
 *   ③ `form` / `fields` / `append` / `remove` / `activeAccounts` /
 *      `auxNameByCode` / `auxValueHints` / `watchedLines` / `totalDebit` /
 *      `totalCredit` / `getLinesErrorMessage` / `submitError` / `operating` /
 *      `onSubmit` 从同一 hook 的解构结果取用（原名不变）；
 *   ④ `setCreateOpen(false); setPage(1); await reload();` 收敛为
 *      `onOpenChange(false); await onCreated();`（父组件传入的
 *      `onCreated` 就是 `setPage(1) + reload()`）。
 *
 * ⚠️ 辅助核算输入框的 `<Label htmlFor={…}>` 与 `<Input id={…}>` 成对留在
 * **同一文件**内（`check:label-a11y` 要求 `htmlFor` 指向的 `id` 在同文件存在）。
 */
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
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
import DateField from '@client/src/components/erp/DateField';
import { formatMoney } from '@client/src/utils/format';
import { isBalanced } from './voucher-form';
import { useVoucherCreateForm } from './use-voucher-create-form';
import type { AccountItem } from '@shared/api.interface';

interface CreateVoucherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 创建成功后调用。父组件在此重取列表并回到第 1 页
   * （原实现是 `setPage(1); await reload();`）。
   */
  onCreated: () => void | Promise<void>;
}

const CreateVoucherDialog: React.FC<CreateVoucherDialogProps> = ({
  open,
  onOpenChange,
  onCreated,
}) => {
  const {
    form,
    fields,
    append,
    remove,
    activeAccounts,
    auxNameByCode,
    auxValueHints,
    watchedLines,
    totalDebit,
    totalCredit,
    getLinesErrorMessage,
    submitError,
    operating,
    onSubmit,
  } = useVoucherCreateForm({
    createOpen: open,
    onOpenChange,
    onCreated,
  });

  return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>新增手工凭证</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="voucherDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        凭证日期 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <DateField value={field.value || undefined} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="period"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        期间 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="YYYY-MM" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="summary"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        摘要 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="请输入凭证摘要" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="remark"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>备注</FormLabel>
                      <FormControl>
                        <Input placeholder="请输入备注" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold">分录明细</span>
                  <span className="text-sm text-muted-foreground">
                    每行填写借方或贷方其一，提交前借贷合计必须相等
                  </span>
                </div>
                <div className="flex gap-2 text-sm text-muted-foreground">
                  <span className="w-56 shrink-0">科目</span>
                  <span className="flex-1">分录摘要</span>
                  <span className="w-28 shrink-0 text-right">借方</span>
                  <span className="w-28 shrink-0 text-right">贷方</span>
                  <span className="w-9 shrink-0" aria-hidden="true" />
                </div>
                {fields.map((field, index: number) => {
                  const account = activeAccounts.find(
                    (a: AccountItem) => a.id === (watchedLines[index]?.accountId ?? ''),
                  );
                  /** A-05：本行科目必挂的辅助核算维度 */
                  const requiredAux = account?.auxRequired ?? [];
                  return (
                  <React.Fragment key={field.id}>
                  <div className="flex items-start gap-2">
                    <FormField
                      control={form.control}
                      name={`lines.${index}.accountId`}
                      render={({ field: lineField }) => (
                        <FormItem className="w-56 shrink-0">
                          <Select onValueChange={lineField.onChange} value={lineField.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="请选择科目" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {activeAccounts.map((a: AccountItem) => (
                                <SelectItem key={a.id} value={a.id}>
                                  {a.code} {a.name}
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
                      name={`lines.${index}.summary`}
                      render={({ field: lineField }) => (
                        <FormItem className="flex-1">
                          <FormControl>
                            <Input placeholder="分录摘要（可选）" {...lineField} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`lines.${index}.debit`}
                      render={({ field: lineField }) => (
                        <FormItem className="w-28 shrink-0">
                          <FormControl>
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              placeholder="0.00"
                              {...lineField}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`lines.${index}.credit`}
                      render={({ field: lineField }) => (
                        <FormItem className="w-28 shrink-0">
                          <FormControl>
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              placeholder="0.00"
                              {...lineField}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="mt-0.5 shrink-0"
                      aria-label={`删除分录行 ${index + 1}`}
                      disabled={fields.length <= 2}
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  {requiredAux.length > 0 ? (
                    <div className="ml-0 flex flex-wrap items-center gap-2 pl-0">
                      {requiredAux.map((code) => {
                        const listId = `voucher-aux-hints-${index}-${code}`;
                        const hints = auxValueHints?.get(code) ?? [];
                        return (
                          <div key={code} className="flex items-center gap-1">
                            <Label
                              htmlFor={`voucher-aux-${index}-${code}`}
                              className="text-xs text-muted-foreground"
                            >
                              {auxNameByCode.get(code) ?? code}
                            </Label>
                            <Input
                              id={`voucher-aux-${index}-${code}`}
                              className="h-8 w-48"
                              list={hints.length > 0 ? listId : undefined}
                              placeholder={`请输入${auxNameByCode.get(code) ?? code}`}
                              value={watchedLines[index]?.aux?.[code] ?? ''}
                              onChange={(e) =>
                                form.setValue(
                                  `lines.${index}.aux.${code}`,
                                  e.target.value,
                                  { shouldDirty: true, shouldValidate: false },
                                )
                              }
                            />
                            {hints.length > 0 ? (
                              <datalist id={listId}>
                                {hints.map((hint) => (
                                  <option key={hint} value={hint} />
                                ))}
                              </datalist>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  </React.Fragment>
                  );
                })}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() =>
                    append({
                      accountId: '',
                      summary: '',
                      debit: '',
                      credit: '',
                      aux: {},
                    })
                  }
                >
                  <Plus className="h-4 w-4" />
                  添加分录行
                </Button>
                <p className="text-sm">
                  借方合计 <span className="font-medium">{formatMoney(totalDebit)}</span>
                  {'　'}贷方合计 <span className="font-medium">{formatMoney(totalCredit)}</span>
                  {!isBalanced(totalDebit, totalCredit) ? (
                    <span className="ml-3 text-destructive">借贷不平衡</span>
                  ) : null}
                </p>
                {getLinesErrorMessage() ? (
                  <p className="text-sm text-destructive">{getLinesErrorMessage()}</p>
                ) : null}
                {submitError ? (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                  >
                    <span className="font-medium">错误提示：</span>
                    {submitError}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button type="submit" disabled={operating}>
                  创建凭证
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
  );
};

export default CreateVoucherDialog;
