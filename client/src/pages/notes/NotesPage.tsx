import React, { useState } from 'react';
import { toast } from 'sonner';
import PageShell from '@client/src/components/PageShell';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as notesApi from '@client/src/api/notes';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
// B-01：票据登记与状态动作（持有/背书/贴现/到期收款/拒付）后端均为
// `@CanCapability('finance_write')`，前端必须同口径显隐，否则 finance_viewer
// 会看到点了必然 403 的按钮。
import { CanCapabilityWrite } from '@client/src/platform/auth';
// 业务时区取"今天"：票据贴现/到期日按 UTC 取会在北京时间凌晨偏一天
import { todayIso } from '@client/src/utils/format';
import NoteActionDialog from './components/NoteActionDialog';
import NoteCreateDialog from './components/NoteCreateDialog';
import NotesRegisterDeepPanel from './components/NotesRegisterDeepPanel';
import NotesRegisterLedger from './components/NotesRegisterLedger';
import NotesRegisterSummary from './components/NotesRegisterSummary';
import NotesStatusFilter from './components/NotesStatusFilter';
import NotesTable from './components/NotesTable';
import type {
  NoteAction,
  NoteDiscountPreview,
  NoteDueAlert,
  NoteItem,
  NoteRegisterResult,
} from '@shared/api.interface';

/**
 * C-04 / D-02：应收应付票据工作台。
 *
 * 设计要点：
 * 1. **动作按钮由后端字典驱动**（`GET /api/notes/dictionaries`），前端不硬编码状态机 ——
 *    否则状态机一改就要动两处，且容易前后端判定不一致。
 * 2. **贴现先试算再提交**：贴现息涉及时长基准（360/365）与算头不算尾口径，
 *    把息费、到账额和将生成的分录提前摊开，是避免算错钱最有效的手段。
 * 3. **备查簿与到期预警同页**：票据管理的核心动作就是"看哪些快到期了"，
 *    分到两个页面会让人忘记看预警。
 *
 * ## §5.9（F8）：本文件现在只做**布局编排**（原 934 行 → 约 300 行）
 *
 * 上一轮的教训是"只搬纯声明不够 —— JSX 才是体量所在"（`ApTab.tsx` 991 → 391）。
 * 本轮照同样的办法，把页面拆成下面这些部分，**每段 JSX 逐字搬运、只去一层缩进**：
 *
 * | 原位置 | 去向 | 承担什么 |
 * |---|---|---|
 * | `STATUS_TONE` / `TYPE_LABELS` / `money` | `note-format.ts`（+ spec） | 零 React 依赖的展示口径，搬走即**可单测** |
 * | 指标卡 + 到期预警条 | `components/NotesRegisterSummary.tsx` | 只读 `register` / `alerts` |
 * | 状态筛选行 | `components/NotesStatusFilter.tsx` | 受控筛选（值仍归父组件：它是查询参数） |
 * | 票据台账表格 + 空态 | `components/NotesTable.tsx` | 只读列表与字典，动作回调交给父组件 |
 * | 票据备查簿两张表 | `components/NotesRegisterLedger.tsx` | 只读 `register` |
 * | 备查簿深化（D-02） | `components/NotesRegisterDeepPanel.tsx` | 只读 `deep` |
 * | 「登记票据」弹窗 | `components/NoteCreateDialog.tsx` | **自持**五个输入值 / `busy` / `submitCreate` |
 * | 「票据流转」弹窗 | `components/NoteActionDialog.tsx` | JSX + 两个派生值（state 仍在父组件，理由见该文件） |
 *
 * **本文件保留**：五路数据查询（`useAsyncData`）、`reloadAll`、以及流转弹窗的
 * state 与三个处理器（`openAction` / `runDiscountPreview` / `submitAction`）——
 * 也就是"页面级编排"。流转弹窗的 state 之所以留在这一层而非搬进子组件，
 * 是因为 `openAction` 在**行内按钮点击的那一刻**重置其中四个字段，
 * 搬走后这个重置点只能变成副作用或强制重挂载（都是行为变更），
 * 详见 `components/NoteActionDialog.tsx` 的说明。
 *
 * ⚠️ 拆分**不改行为**：所有弹窗都**无条件挂载**（`{open && <X/>}` 会让
 * "取消后重开仍保留上次输入"这一行为消失）；重置时机一律保持原样
 * （登记弹窗是**写成功后**清空，流转弹窗是**打开时**清四个字段、
 * 且 `discountDate` 任何时机都不清）。
 */
const NotesPage: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState<string>('outstanding');
  const [createOpen, setCreateOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<NoteItem | null>(null);
  const [actionKind, setActionKind] = useState<NoteAction>('hold');
  const [counterparty, setCounterparty] = useState('');
  const [discountRate, setDiscountRate] = useState('');
  const [discountDate, setDiscountDate] = useState(todayIso());
  const [remark, setRemark] = useState('');
  const [preview, setPreview] = useState<NoteDiscountPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: dict } = useAsyncData(() => notesApi.getNoteDictionaries(), []);
  const { data: register, reload: reloadRegister } =
    useAsyncData<NoteRegisterResult>(() => notesApi.getNoteRegister(), []);
  const { data: alerts, reload: reloadAlerts } = useAsyncData<NoteDueAlert[]>(
    () => notesApi.getNoteDueAlerts(),
    [],
  );
  const { data: basis } = useAsyncData(() => notesApi.getDiscountBasis(), []);
  // D-02：备查簿深化（到期结构 / 票号连续性 / 贴现成本分析）
  const { data: deep, reload: reloadDeep } = useAsyncData(
    () => notesApi.getNoteRegisterDeep(),
    [],
  );
  const {
    data: notes,
    loading,
    error,
    reload,
  } = useAsyncData(
    () =>
      notesApi.listNotes({
        pageSize: 200,
        // "outstanding" 是前端语义：未结清 = 排除已结清与已拒付
        status:
          statusFilter === 'outstanding' || statusFilter === 'all'
            ? undefined
            : statusFilter,
      }),
    [statusFilter],
  );

  const reloadAll = () => {
    reload();
    reloadRegister();
    reloadDeep();
    reloadAlerts();
  };

  const openAction = (note: NoteItem, action: NoteAction) => {
    setActionTarget(note);
    setActionKind(action);
    setPreview(null);
    setCounterparty('');
    setDiscountRate('');
    setRemark('');
  };

  const runDiscountPreview = async () => {
    if (!actionTarget) return;
    const rate = Number(discountRate);
    if (!Number.isFinite(rate) || rate < 0) {
      toast.error('请填写不小于 0 的贴现率');
      return;
    }
    try {
      setPreview(
        await notesApi.previewNoteDiscount(actionTarget.id, rate, discountDate),
      );
    } catch (err) {
      toast.error(getApiErrorMessage(err, '试算失败'));
    }
  };

  const submitAction = async () => {
    if (!actionTarget) return;
    setBusy(true);
    try {
      await notesApi.noteAction(actionTarget.id, {
        action: actionKind,
        counterparty: counterparty || undefined,
        discountRate:
          actionKind === 'discount' ? Number(discountRate) : undefined,
        discountDate: actionKind === 'discount' ? discountDate : undefined,
        remark: remark || undefined,
      });
      toast.success('票据流转成功');
      setActionTarget(null);
      setPreview(null);
      reloadAll();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell
      title="应收应付票据"
      description="银行/商业承兑汇票登记、持有、背书、贴现、到期收款与拒付，含备查簿与到期预警"
      actions={
        <CanCapabilityWrite capability="finance_write">
          <Button type="button" onClick={() => setCreateOpen(true)}>
            登记票据
          </Button>
        </CanCapabilityWrite>
      }
    >
      <div className="flex flex-col gap-6">
        <NotesRegisterSummary register={register} alerts={alerts} />

        <NotesStatusFilter
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          dict={dict}
          basis={basis}
        />

        <NotesTable
          notes={notes?.items}
          statusFilter={statusFilter}
          loading={loading}
          error={error}
          dict={dict}
          onRetry={reload}
          onAction={openAction}
        />

        <NotesRegisterLedger register={register} />

        <NotesRegisterDeepPanel deep={deep} />
      </div>

      <NoteCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        dict={dict}
        onSaved={reloadAll}
      />

      <NoteActionDialog
        actionTarget={actionTarget}
        setActionTarget={setActionTarget}
        actionKind={actionKind}
        counterparty={counterparty}
        setCounterparty={setCounterparty}
        discountRate={discountRate}
        setDiscountRate={setDiscountRate}
        discountDate={discountDate}
        setDiscountDate={setDiscountDate}
        remark={remark}
        setRemark={setRemark}
        preview={preview}
        setPreview={setPreview}
        busy={busy}
        dict={dict}
        basis={basis}
        runDiscountPreview={runDiscountPreview}
        submitAction={submitAction}
      />
    </PageShell>
  );
};

export default NotesPage;
