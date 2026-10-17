import React, { useEffect, useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Form } from '@client/src/components/ui/form';
import { Button } from '@client/src/components/ui/button';
import { crmApi, masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { todayIso } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { newRowKey } from '@client/src/utils/row-key';
import QuotationFormFields from './components/QuotationFormFields';
import QuotationImportPanel from './components/QuotationImportPanel';
import QuotationItemsEditor from './components/QuotationItemsEditor';
import QuotationTotalsSummary from './components/QuotationTotalsSummary';
import {
  EMPTY_ITEM,
  buildQuotationPayload,
  computeQuotationTotals,
  isBelowMarginLine,
  quoteSchema,
  withRowKey,
  type QuoteFormData,
  type QuoteFormInput,
  type QuotationFormPreset,
  type QuotationItemRow,
  type QuotationRow,
} from './components/quotation-form';
import type {
  CreateQuotationDto,
  Customer,
  Opportunity,
  ParsedQuotationDraft,
  ParsedQuotationItem,
  Quotation,
  QuotationItemInput,
} from '@shared/api.interface';

/*
 * §5.9（F8）：报价单表单一度是 834 行（审计时 799 行）。
 *
 * 上一轮的教训是"只搬纯声明不够"——占体量的从来不是声明，而是 JSX。
 * 本轮按**JSX 分块**拆开，五个新文件各管一段：
 *
 *   · `./components/quotation-form.ts`         纯逻辑：schema / 行身份 / 合计与毛利红线（+ spec）
 *   · `./components/QuotationImportPanel.tsx`  云文档解析 + 多维表格导入（自带 7 个 state）
 *   · `./components/QuotationFormFields.tsx`   表头 7 个字段
 *   · `./components/QuotationItemsEditor.tsx`  明细行表格
 *   · `./components/QuotationTotalsSummary.tsx` 合计 / 毛利率条
 *
 * 主文件保留"页面级编排"与**跨块共享的东西**：三个查询（客户 / 商机 / 多维表格配置）、
 * `useForm`、明细 state（提交处理器、重置 effect、解析回填、合计四处都要读它）、
 * 提交处理器，以及 Dialog 与整页两种外壳。
 *
 * ⚠️ 搬迁时逐条核对的三件事：
 *   ① **重置时机不变**：原实现**没有**"保存成功后重置表单"，只有下面那个
 *      「`active` / `editTarget` / `preset` 变化即整体重置」的 effect（连明细数组
 *      都会重建、重新生成 `rowKey`）。它逐字留在本文件里，没有新增任何 reset。
 *   ② **多维表格配置探测的 effect 留在本文件**：React 的 effect 是**子先父后**执行，
 *      把它一起搬进 `QuotationImportPanel` 会让这个请求排在两个列表查询**之前**。
 *      留在原位后，本文件的 effect 顺序与拆分前逐行一致（探测 → 客户 → 商机 → 重置）。
 *   ③ **子组件全部无条件挂载**，不能写成 `{open && <Xxx/>}`：`QuotationImportPanel`
 *      原先那 7 个 state 在编辑模式下也常驻，条件挂载会在编辑↔新建切换时丢掉
 *      `docUrl` 与多维表格勾选 —— 它内部自己判 `!editTarget`。
 *
 * 另：`DialogFooter` 是本文件**拆分前就存在**的未使用导入，本轮未动。
 */

/** 对外导出面保持不变（原 `QuotationFormPreset` 定义在本文件内） */
export type { QuotationFormPreset };

interface QuotationFormDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 整页模式：不使用弹窗外壳 */
  asPage?: boolean;
  preset?: QuotationFormPreset;
  editTarget?: Quotation | null;
  onSaved: (quotation: Quotation) => void;
  onCancel?: () => void;
}

const QuotationFormDialog: React.FC<QuotationFormDialogProps> = ({
  open = false,
  onOpenChange,
  asPage = false,
  preset,
  editTarget,
  onSaved,
  onCancel,
}) => {
  const active = asPage || open;
  const [items, setItems] = useState<QuotationRow[]>([withRowKey(EMPTY_ITEM)]);
  const [bitableConfigured, setBitableConfigured] = useState(false);

  const form = useForm<QuoteFormInput, unknown, QuoteFormData>({
    resolver: zodResolver(quoteSchema),
    defaultValues: {
      title: '',
      customerId: '',
      opportunityId: '',
      quoteDate: todayIso(),
      validUntil: '',
      discountPct: 0,
      remark: '',
    },
  });

  useEffect(() => {
    if (!active || editTarget) return;
    void crmApi
      .getFeishuBitableMeta()
      .then((meta) => setBitableConfigured(meta.configured))
      .catch(() => setBitableConfigured(false));
  }, [active, editTarget]);

  const applyDraft = (draft: ParsedQuotationDraft) => {
    const current = form.getValues();
    form.reset({
      title: draft.title ?? current.title,
      customerId: current.customerId,
      opportunityId: current.opportunityId,
      quoteDate: draft.quoteDate || current.quoteDate || todayIso(),
      validUntil: draft.validUntil || current.validUntil || '',
      discountPct: current.discountPct,
      remark: draft.remark ?? current.remark,
    });
    const parsedRows: QuotationRow[] = draft.items.map(
      (item: ParsedQuotationItem): QuotationRow => ({
        itemName: item.itemName,
        unit: item.unit ?? '人天',
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountPct: item.discountPct ?? 0,
        estUnitCost: item.estUnitCost ?? 0,
        remark: item.remark ?? '',
        rowKey: newRowKey(),
      }),
    );
    setItems(parsedRows.length > 0 ? parsedRows : [withRowKey(EMPTY_ITEM)]);
  };

  const { data: customers } = useAsyncData<Customer[]>(
    () => masterDataApi.listCustomers(),
    [],
  );
  const { data: opportunities } = useAsyncData<Opportunity[]>(
    () => crmApi.listOpportunities(),
    [],
  );

  useEffect(() => {
    if (!active) return;
    if (editTarget) {
      form.reset({
        title: editTarget.title,
        customerId: editTarget.customerId,
        opportunityId: editTarget.opportunityId ?? '',
        quoteDate: editTarget.quoteDate ?? '',
        validUntil: editTarget.validUntil ?? '',
        discountPct: editTarget.discountPct,
        remark: editTarget.remark ?? '',
      });
      setItems(
        [...editTarget.items]
          .sort((a, b) => a.seq - b.seq)
          .map((item) =>
            withRowKey({
              itemName: item.itemName,
              unit: item.unit,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              discountPct: item.discountPct,
              estUnitCost: item.estUnitCost,
              remark: item.remark ?? '',
            }),
          ),
      );
    } else {
      form.reset({
        title: preset?.title ?? '',
        customerId: preset?.customerId ?? '',
        opportunityId: preset?.opportunityId ?? '',
        quoteDate: preset?.quoteDate || todayIso(),
        validUntil: preset?.validUntil ?? '',
        discountPct: 0,
        remark: preset?.remark ?? '',
      });
      const presetRows: QuotationRow[] = (preset?.items ?? []).map(
        (item: QuotationItemInput): QuotationRow => ({
          itemName: item.itemName,
          unit: item.unit ?? '人天',
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountPct: item.discountPct ?? 0,
          estUnitCost: item.estUnitCost ?? 0,
          remark: item.remark ?? '',
          rowKey: newRowKey(),
        }),
      );
      setItems(presetRows.length > 0 ? presetRows : [withRowKey(EMPTY_ITEM)]);
    }
  }, [active, editTarget, preset, form]);

  const addItem = () => {
    setItems((prev: QuotationRow[]) => [...prev, withRowKey(EMPTY_ITEM)]);
  };

  const removeItem = (index: number) => {
    setItems((prev: QuotationRow[]) =>
      prev.filter((_: QuotationRow, i: number) => i !== index),
    );
  };

  const updateItem = (index: number, patch: Partial<QuotationRow>) => {
    setItems((prev: QuotationRow[]) =>
      prev.map((row: QuotationRow, i: number) =>
        i === index ? { ...row, ...patch } : row,
      ),
    );
  };

  const wholeDiscountPct = form.watch('discountPct');

  const totals = useMemo(
    () => computeQuotationTotals(items, wholeDiscountPct),
    [items, wholeDiscountPct],
  );

  const belowMarginLine = isBelowMarginLine(totals.marginPct);

  const onSubmit = form.handleSubmit(async (values: QuoteFormData) => {
    if (items.length === 0) {
      toast.error('请至少添加一条明细行');
      return;
    }
    if (items.some((item: QuotationItemRow) => !item.itemName.trim())) {
      toast.error('请填写所有明细行的服务项名称');
      return;
    }
    const dto: CreateQuotationDto = buildQuotationPayload({
      values,
      items,
      isEdit: Boolean(editTarget),
    });
    try {
      const saved = editTarget
        ? await crmApi.updateQuotation(editTarget.id, dto)
        : await crmApi.createQuotation(dto);
      toast.success(editTarget ? '报价单已更新' : '报价单已创建');
      onOpenChange?.(false);
      onSaved(saved);
    } catch (err) {
      toast.error(getApiErrorMessage(err, '保存失败'));
    }
  });

  const formInner = (
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <QuotationImportPanel
              editTarget={editTarget}
              bitableConfigured={bitableConfigured}
              applyDraft={applyDraft}
            />

            <QuotationFormFields
              form={form}
              customers={customers}
              opportunities={opportunities}
            />

            <QuotationItemsEditor
              items={items}
              addItem={addItem}
              removeItem={removeItem}
              updateItem={updateItem}
            />

            <QuotationTotalsSummary
              totals={totals}
              belowMarginLine={belowMarginLine}
            />

            <div className="flex justify-end gap-2 border-t pt-3">
              {asPage && onCancel ? (
                <Button type="button" variant="outline" onClick={onCancel}>
                  取消
                </Button>
              ) : null}
              <Button type="submit">{editTarget ? '保存修改' : '保存'}</Button>
            </div>
          </form>
        </Form>
  );

  if (asPage) {
    return <div className="mx-auto max-w-4xl space-y-4">{formInner}</div>;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editTarget ? '编辑报价单' : '新建报价单'}</DialogTitle>
        </DialogHeader>
        {formInner}
      </DialogContent>
    </Dialog>
  );
};

export default QuotationFormDialog;
