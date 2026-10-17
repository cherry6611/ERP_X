/**
 * 发票编辑弹窗（用户要求：**发票登记后能编辑**）。
 *
 * ## 为什么单独开一个弹窗，而不是给 `InvoiceFormDialog` 加编辑模式
 *
 * `InvoiceFormDialog` 是 470 行的**新建**弹窗，含方向/合同/供应商/关联应收
 * 等一整套登记语义。给它加一个 `editTarget` 分支意味着：条件化标题、条件化
 * DTO 组装、条件化提交目标、条件化字段可见性 —— **新建路径的每一行都要重新回归**。
 * 而本次要解锁的只是「录错了改一改」这一件事，字段少、语义单一。
 * 因此独立成件：**新建路径一个字符都不动**，风险面只在这一个文件里。
 *
 * ## 可编辑范围由**服务端**判定，前端不复制状态机
 *
 * 哪个字段能改取决于该发票的**记账凭证是否已过账**
 * （判据在 `server/modules/finance/invoice-edit-guard.ts`，含 9 条断言）。
 * 前端**有意不复制这套判断** —— 只有一份真相，就不会出现"前端以为能改、
 * 服务端拒绝"或反过来的分叉。所以这里把三类字段都渲染出来，
 * 由服务端拒绝时把它的中文原因原样展示（`getApiErrorMessage`）。
 *
 * 服务端拒绝时的文案已经写明下一步（「先作废该发票（会生成冲回凭证）再重新登记」），
 * 使用者不会卡住。
 */
import React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { financeApi } from '@client/src/api';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { VAT_RATES } from '@shared/tax';
import type { InvoiceItem, UpdateInvoiceDto } from '@shared/api.interface';

interface InvoiceEditDialogProps {
  /** 待编辑的发票；`null` 表示弹窗关闭（与 `InvoiceLinkDialog` 同一约定） */
  target: InvoiceItem | null;
  setTarget: (value: InvoiceItem | null) => void;
  /** 保存成功后调用，父组件据此重取发票台账 */
  onSaved: () => void | Promise<void>;
}

/** 表单态的原始字符串（数字留作字符串，提交时再转，避免 `Number('') → 0`） */
interface EditFormState {
  amount: string;
  taxRate: string;
  invoiceDate: string;
  invoiceNo: string;
  remark: string;
}

const EDIT_EMPTY: EditFormState = {
  amount: '',
  taxRate: '',
  invoiceDate: '',
  invoiceNo: '',
  remark: '',
};

const toFormState = (item: InvoiceItem): EditFormState => ({
  amount: item.amount != null ? String(item.amount) : '',
  taxRate: item.taxRate != null ? String(item.taxRate) : '',
  invoiceDate: item.invoiceDate ?? '',
  invoiceNo: item.invoiceNo ?? '',
  remark: item.remark ?? '',
});

const InvoiceEditDialog: React.FC<InvoiceEditDialogProps> = ({
  target,
  setTarget,
  onSaved,
}) => {
  const [form, setForm] = React.useState<EditFormState>(EDIT_EMPTY);
  const [saving, setSaving] = React.useState(false);

  /*
   * 打开时同步表单 —— 触发点是父组件的「编辑」按钮（与 `openLinkDialog` 同一形状）。
   *
   * ⚠️ 这里用 `useEffect` 而不是"父组件在 onClick 里先 setForm"：
   * 表单态是本组件私有的，父组件不该看到它。而 `target` 从 null → 对象
   * 这个跃迁只发生一次，`[target]` 依赖下不存在"多渲一帧旧值"的问题
   * （对比 `InvoiceLinkDialog` 那种 state 在父组件、必须同帧赋值的情形）。
   */
  React.useEffect(() => {
    if (target) setForm(toFormState(target));
  }, [target]);

  const set = <K extends keyof EditFormState>(key: K, value: EditFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    if (!target) return;

    /* 客户端只做"非空/是数字"的最低限度校验；业务规则在服务端 */
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('开票金额必须大于 0');
      return;
    }
    const taxRate = Number(form.taxRate);
    if (!Number.isFinite(taxRate) || !(VAT_RATES as readonly number[]).includes(taxRate)) {
      toast.error('请选择合法税率');
      return;
    }

    /*
     * 只提交**真正改动过**的字段。
     *
     * 这一点很重要：服务端按"是否触及影响凭证的字段"决定要不要重建凭证
     * （`pickVoucherAffectingFields`）。若把未改动的 amount/taxRate 也一起发过去，
     * 一张凭证已过账的发票即使只改备注也会被拒 —— 那就把"改备注"也堵死了。
     */
    const dto: UpdateInvoiceDto = {};
    const initial = toFormState(target);
    if (form.amount !== initial.amount) dto.amount = amount;
    if (form.taxRate !== initial.taxRate) dto.taxRate = taxRate;
    if (form.invoiceDate !== initial.invoiceDate) {
      dto.invoiceDate = form.invoiceDate;
    }
    if (form.invoiceNo !== initial.invoiceNo) dto.invoiceNo = form.invoiceNo;
    if (form.remark !== initial.remark) dto.remark = form.remark;

    if (Object.keys(dto).length === 0) {
      toast.info('没有需要保存的修改');
      return;
    }

    setSaving(true);
    try {
      await financeApi.updateInvoice(target.id, dto);
      toast.success('发票已更新');
      setTarget(null);
      await onSaved();
    } catch (err) {
      /* 服务端的拒绝原因已写明下一步，原样展示 */
      toast.error(getApiErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open: boolean) => {
        if (!open) setTarget(null);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑发票</DialogTitle>
          <DialogDescription>
            发票 {target?.code} —— 金额、税率、开票日期等已入账信息仅在
            <b>记账凭证未过账</b>时可改；凭证已过账的请先作废该发票再重新登记。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex min-w-[180px] flex-1 flex-col gap-2">
              <Label htmlFor="inv-edit-amount">
                开票金额（元） <span aria-hidden="true" className="text-destructive">*</span>
              </Label>
              <Input
                id="inv-edit-amount"
                type="number"
                min={0.01}
                step="0.01"
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
              />
            </div>
            <div className="flex min-w-[150px] flex-1 flex-col gap-2">
              <Label htmlFor="inv-edit-tax-rate">税率（%）</Label>
              <select
                id="inv-edit-tax-rate"
                className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                value={form.taxRate}
                onChange={(e) => set('taxRate', e.target.value)}
              >
                {VAT_RATES.map((rate) => (
                  <option key={rate} value={String(rate)}>
                    {rate}%
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="flex min-w-[180px] flex-1 flex-col gap-2">
              <Label htmlFor="inv-edit-date">开票日期</Label>
              {/*
                * 用原生 `type="date"` 而不是 `DateField`：后者的 props 只有
                * `value`/`onChange`（无 `id`），而 `check:label-a11y` 要求
                * `<Label htmlFor>` 指向同文件内存在的 `id`。原生 date 输入
                * 的 value 本身就是 `YYYY-MM-DD`，与 `erp_invoice.invoice_date`
                * （`date` 列）完全同构，不需要额外转换。
                */}
              <Input
                id="inv-edit-date"
                type="date"
                value={form.invoiceDate}
                onChange={(e) => set('invoiceDate', e.target.value)}
              />
            </div>
            <div className="flex min-w-[180px] flex-1 flex-col gap-2">
              <Label htmlFor="inv-edit-no">发票号码</Label>
              <Input
                id="inv-edit-no"
                value={form.invoiceNo}
                onChange={(e) => set('invoiceNo', e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="inv-edit-remark">备注</Label>
            <Input
              id="inv-edit-remark"
              value={form.remark}
              onChange={(e) => set('remark', e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              取消
            </Button>
            <Button disabled={saving} onClick={() => void handleSave()}>
              保存
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default InvoiceEditDialog;
