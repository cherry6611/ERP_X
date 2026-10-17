import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { contractsApi, crmApi, masterDataApi } from '@client/src/api';
import type { ContractItem } from '@client/src/api/contracts';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { CONTRACT_STATUS_LABELS } from '@client/src/utils/biz-labels';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import type {
  ContractDetail,
  ContractMilestone,
  ContractStatusAction,
  Quotation,
  TaxEntity,
} from '@shared/api.interface';
import {
  CALLOFF_FORM_DEFAULTS,
  CHANGE_FORM_DEFAULTS,
  EMPTY_ITEM_DRAFT,
  MILESTONE_FORM_DEFAULTS,
  buildCalloffPayload,
  buildChangePayload,
  buildMilestonePayload,
  calloffSchema,
  changeSchema,
  milestoneSchema,
  resolveItemTaxRate,
  type CalloffFormData,
  type CalloffFormInput,
  type ChangeFormData,
  type ChangeFormInput,
  type MilestoneFormData,
  type MilestoneFormInput,
} from './contract-detail-model';
import ContractDetailBody from './components/ContractDetailBody';
import CalloffDialog from './components/dialogs/CalloffDialog';
import ChangeDialog from './components/dialogs/ChangeDialog';
import ItemDialog from './components/dialogs/ItemDialog';
import MilestoneDialog from './components/dialogs/MilestoneDialog';
import QuotationImportDialog from './components/dialogs/QuotationImportDialog';

/*
 * §5.9（F8）：本文件的**纯逻辑**已移到同目录 `./contract-detail-model`，
 * 并配有 `contract-detail-model.spec.ts`。搬走的是：
 *   · `STATUS_ACTIONS` 状态机按钮表 + 取用它的 `statusActionsFor`
 *   · `milestoneSchema` / `calloffSchema` / `changeSchema` 与三组
 *     `z.input` / `z.output` 类型
 *   · 三张表单的默认值（原先 `defaultValues` 与提交后的 `reset(...)` **各写一遍**）
 *   · `calloffColumns`（纯列定义；`milestoneColumns` / `versionColumns` 的 `render`
 *     里是 JSX，按判据留在本文件）
 *   · 提交入参拼装：`buildMilestonePayload` / `buildCalloffPayload` / `buildChangePayload`
 *   · 明细草稿与默认税率：`EMPTY_ITEM_DRAFT` / `itemRateOptions` /
 *     `resolveItemTaxRate` / `createItemDraft`（P0-3 的"按合同主体校正税率"原先在
 *     打开弹窗与保存后重置两处**各写一遍**，现在同源，且不再可能返回 `null`
 *     让下拉空白、保存 400 —— 证据见该模块文件头）
 * 保留在本文件：布局编排、六个 `<Dialog>`、所有含 JSX 的列定义、API / toast / 组件状态。
 */

/*
 * ⚠️ 上面那段已被**第二轮**部分推翻，此处逐条更正（原话保留在上方，便于对照）：
 *   · 「`milestoneColumns` / `versionColumns` 按判据留在本文件」→ 它们现在在
 *     `./components/contract-detail-columns.tsx`（判据没变：`render` 里是 JSX，
 *     所以**不能**进零 React 依赖的 `contract-detail-model.ts`，但可以进组件模块）。
 *   · 「保留在本文件：所有含 JSX 的列定义」→ 明细表**内联**在 `columns={[…]}` 里的
 *     那份也搬到了 `./components/contract-item-columns.tsx`。
 *   · 「六个 `<Dialog>`」→ 弹窗 JSX 已拆到 `./components/dialogs/`（5 个文件，
 *     里程碑 / Call-off / 变更 / 明细 / 报价导入），本文件只留状态与提交处理。
 *   · `createItemDraft` 的唯一调用点（「添加明细」弹窗）随之下移，故本文件不再
 *     导入它。
 */

/*
 * §5.9（F8）**第二轮**：上一轮只搬走了纯声明，文件仍有 909 行 —— 体量在 JSX。
 * 本轮把 JSX 整体搬走，本文件只剩"页面级编排"（数据查询 + 六个弹窗的状态与提交
 * 处理函数）：
 *
 * | 原位置 | 去向 |
 * |---|---|
 * | `const content = ( … )`（概览栅格 + 按钮行 + 四张表 + 附件区，275 行） | `./components/ContractDetailBody.tsx` |
 * | `milestoneColumns`（含「达成」按钮）/ `versionColumns` | `./components/contract-detail-columns.tsx` |
 * | 明细表**内联**在 `columns={[…]}` 里的列定义（含删除按钮） | `./components/contract-item-columns.tsx` |
 * | `<Dialog>`×6 的 JSX | `./components/dialogs/` 下 5 个文件（里程碑 / Call-off / 变更 / 明细 / 报价导入） |
 *
 * ⚠️ **五个弹窗组件必须无条件挂载**：不能写成 `{milestoneOpen && <MilestoneDialog/>}`。
 * 原实现里三个 `useForm` 与 `itemDraft` / `quotations` / `selectedQuotationId` 都是
 * **常驻**状态，条件挂载会让它们在每次开合时重建 —— 用户填到一半关掉再打开，
 * 草稿值会从"还在"变成"没了"。
 *
 * ⚠️ **三个 `useForm` 刻意留在本文件**，以 `form` prop 下传。原因是**重置时机**：
 * 原实现全部是"写成功后重置"（`setXxxOpen(false)` → `form.reset(*_FORM_DEFAULTS)`
 * → `await load()`），**没有**任何 reset-on-open 的 `useEffect`，全文件也**没有**
 * 一条 `useEffect` 与这六个弹窗的开关有关（只有 `load` 与 `listTaxEntities` 两条，
 * 都跟随 `active` / `contractId`）。把 `useForm` 搬进子组件会让实例身份随父组件
 * 渲染重建、`FormProvider` 重新绑定，重置时点随之漂移；因此这里让子组件只接
 * `form` 与 `onSubmit`，父组件仍是同一行 `reset`。
 *
 * ⚠️ **`itemDraft` / `quotations` / `selectedQuotationId` / `importingQuotation` 同样
 * 留在本文件**：「添加明细」按钮在**点击那一刻**先 `setItemDraft(prev => …)` 校正
 * 默认税率再 `setItemOpen(true)`，「从报价导入」在点击那一刻清空已选报价并拉取
 * 报价单列表 —— 这两段函数体逐字未动，只是从 JSX 里挪到了组件函数体内。
 */

interface ContractDetailDialogProps {
  contractId: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  asPage?: boolean;
}

const ContractDetailDialog: React.FC<ContractDetailDialogProps> = ({
  contractId,
  open = false,
  onOpenChange,
  asPage = false,
}) => {
  const active = asPage || open;
  const [detail, setDetail] = useState<ContractDetail | null>(null);
  const [items, setItems] = useState<ContractItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [calloffOpen, setCalloffOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [itemOpen, setItemOpen] = useState(false);
  const [itemDraft, setItemDraft] = useState(EMPTY_ITEM_DRAFT);
  const [taxEntities, setTaxEntities] = useState<TaxEntity[]>([]);
  const [quotationImportOpen, setQuotationImportOpen] = useState(false);
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [selectedQuotationId, setSelectedQuotationId] = useState('');
  const [importingQuotation, setImportingQuotation] = useState(false);

  const milestoneForm = useForm<MilestoneFormInput, unknown, MilestoneFormData>({
    resolver: zodResolver(milestoneSchema),
    defaultValues: MILESTONE_FORM_DEFAULTS,
  });
  const calloffForm = useForm<CalloffFormInput, unknown, CalloffFormData>({
    resolver: zodResolver(calloffSchema),
    defaultValues: CALLOFF_FORM_DEFAULTS,
  });
  /* `calloffColumns` 已移到 `./contract-detail-model`（纯列定义，无 JSX）—— 见文件头 §5.9 注释 */

  const changeForm = useForm<ChangeFormInput, unknown, ChangeFormData>({
    resolver: zodResolver(changeSchema),
    defaultValues: CHANGE_FORM_DEFAULTS,
  });

  const load = async () => {
    if (!contractId) return;
    setLoading(true);
    setError(null);
    try {
      const [nextDetail, nextItems] = await Promise.all([
        contractsApi.getContract(contractId),
        contractsApi.listContractItems(contractId),
      ]);
      setDetail(nextDetail);
      setItems(nextItems);
    } catch (err) {
      setError(getApiErrorMessage(err, '加载合同详情失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (active) void load();
  }, [active, contractId]);

  useEffect(() => {
    if (!active) return;
    void masterDataApi.listTaxEntities().then(setTaxEntities).catch(() => setTaxEntities([]));
  }, [active]);

  const doAction = async (action: ContractStatusAction) => {
    if (!contractId) return;
    try {
      await contractsApi.changeContractStatus(contractId, action);
      toast.success('状态已更新');
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  const onAddMilestone = milestoneForm.handleSubmit(async (values) => {
    if (!contractId) return;
    try {
      await contractsApi.addMilestone(contractId, buildMilestonePayload(values));
      toast.success('里程碑已添加');
      setMilestoneOpen(false);
      milestoneForm.reset(MILESTONE_FORM_DEFAULTS);
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '添加失败'));
    }
  });

  const reachMilestone = async (m: ContractMilestone) => {
    try {
      await contractsApi.updateMilestone(m.id, { status: 'reached' });
      toast.success('里程碑已达成');
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  const onAddCalloff = calloffForm.handleSubmit(async (values) => {
    if (!contractId) return;
    try {
      await contractsApi.createCalloff(contractId, buildCalloffPayload(values));
      toast.success('Call-off 下单成功');
      setCalloffOpen(false);
      calloffForm.reset(CALLOFF_FORM_DEFAULTS);
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '下单失败'));
    }
  });

  const onCreateChange = changeForm.handleSubmit(async (values) => {
    if (!contractId) return;
    try {
      await contractsApi.createVersion(contractId, buildChangePayload(values));
      toast.success('变更已留痕');
      setChangeOpen(false);
      changeForm.reset(CHANGE_FORM_DEFAULTS);
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '变更失败'));
    }
  });

  /*
   * 「添加明细」按钮的处理体：**从 JSX 的 `onClick` 里逐字搬到组件函数体**，
   * 一个字未改（原来是内联箭头函数，现在是具名函数，调用点仍是同一个
   * `onClick={() => openItemDialog()}`）。
   *
   * 之所以要搬出来：`<ContractDetailBody>` 只负责渲染，不持有 `itemDraft` /
   * `taxEntities` / `detail` 这些状态，若把这段留在 JSX 里就得把 4 个 setter
   * 全传进子组件 —— 而"点击那一刻先按合同主体校正默认税率、再打开弹窗"的时序
   * 是 P0-3 修复的关键，留在状态所在处更不容易被改错。
   */
  const openItemDialog = () => {
    /*
     * 修复 P0-3：打开时按合同主体校正默认税率，
     * 否则小规模主体下 <select value={6}> 匹配不到选项 → 显示空白、提交 400。
     * 校正逻辑（含"越界时取该主体的合法默认档位、绝不返回 null"）
     * 已抽到 `./contract-detail-model` 的 `resolveItemTaxRate`，
     * 与下拉选项 `itemRateOptions` 同源。
     */
    setItemDraft((prev) => ({
      ...prev,
      taxRate: resolveItemTaxRate(
        Number(detail?.taxRate ?? prev.taxRate ?? 6),
        taxEntities,
        detail?.taxEntityId
      ),
    }));
    setItemOpen(true);
  };

  /* `openQuotationImportDialog` 同理：清空已选报价 + 拉取报价单列表，逐字搬运 */
  const openQuotationImportDialog = () => {
    setSelectedQuotationId('');
    setQuotationImportOpen(true);
    void crmApi
      .listQuotations()
      .then(setQuotations)
      .catch((err: unknown) => {
        setQuotations([]);
        toast.error(getApiErrorMessage(err, '加载报价单失败'));
      });
  };

  /* 「导入」按钮的处理体：同样逐字搬出 JSX（`onClick={() => { … }}` 的体） */
  const importQuotationItems = () => {
    if (!contractId || !selectedQuotationId) return;
    setImportingQuotation(true);
    void contractsApi
      .importQuotationItems(contractId, selectedQuotationId)
      .then(() => {
        toast.success('已从报价导入明细');
        setQuotationImportOpen(false);
        setSelectedQuotationId('');
        return load();
      })
      .catch((err: unknown) =>
        toast.error(getApiErrorMessage(err, '导入失败'))
      )
      .finally(() => setImportingQuotation(false));
  };

  /* 「取消」按钮：只关窗 —— 关窗回调会清空已选报价，与原来一致 */
  const cancelQuotationImport = () => {
    setQuotationImportOpen(false);
  };

  const pageTitle = (
    <>
      合同详情 - {detail?.code ?? ''}{' '}
      {detail ? (
        <StatusBadge status={detail.status} labels={CONTRACT_STATUS_LABELS} />
      ) : null}
    </>
  );

  const content = (
    <>
      {detail ? (
        <ContractDetailBody
          detail={detail}
          items={items}
          contractId={contractId}
          loading={loading}
          error={error}
          doAction={doAction}
          reachMilestone={reachMilestone}
          load={load}
          onOpenItem={openItemDialog}
          onOpenQuotationImport={openQuotationImportDialog}
          setMilestoneOpen={setMilestoneOpen}
          setCalloffOpen={setCalloffOpen}
          setChangeOpen={setChangeOpen}
        />
      ) : null}
      <MilestoneDialog
        open={milestoneOpen}
        onOpenChange={setMilestoneOpen}
        form={milestoneForm}
        onSubmit={onAddMilestone}
      />
      <CalloffDialog
        open={calloffOpen}
        onOpenChange={setCalloffOpen}
        form={calloffForm}
        onSubmit={onAddCalloff}
      />
      <ChangeDialog
        open={changeOpen}
        onOpenChange={setChangeOpen}
        form={changeForm}
        onSubmit={onCreateChange}
      />
      <ItemDialog
        open={itemOpen}
        onOpenChange={setItemOpen}
        contractId={contractId}
        itemDraft={itemDraft}
        setItemDraft={setItemDraft}
        taxEntities={taxEntities}
        detail={detail}
        onSaved={load}
      />
      <QuotationImportDialog
        open={quotationImportOpen}
        onOpenChange={(next) => {
          setQuotationImportOpen(next);
          if (!next) {
            setSelectedQuotationId('');
          }
        }}
        quotations={quotations}
        selectedQuotationId={selectedQuotationId}
        setSelectedQuotationId={setSelectedQuotationId}
        importingQuotation={importingQuotation}
        onCancel={cancelQuotationImport}
        onImport={importQuotationItems}
      />
    </>
  );

  if (asPage) {
    return <div className="space-y-4">{content}</div>;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{pageTitle}</DialogTitle>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
};

export default ContractDetailDialog;
