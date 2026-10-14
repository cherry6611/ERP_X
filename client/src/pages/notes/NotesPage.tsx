import React, { useState } from 'react';
import { toast } from 'sonner';
import PageShell from '@client/src/components/PageShell';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as notesApi from '@client/src/api/notes';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { cn } from '@client/src/lib/utils';
import type {
  NoteAction,
  NoteDiscountPreview,
  NoteDueAlert,
  NoteItem,
  NoteRegisterResult,
  NoteStatus,
  NoteType,
} from '@shared/api.interface';

const STATUS_TONE: Record<NoteStatus, string> = {
  received: 'bg-slate-100 text-slate-700',
  held: 'bg-sky-100 text-sky-700',
  endorsed: 'bg-violet-100 text-violet-700',
  discounted: 'bg-amber-100 text-amber-800',
  settled: 'bg-emerald-100 text-emerald-700',
  dishonored: 'bg-rose-100 text-rose-700',
};

const STATUS_LABELS: Record<NoteStatus, string> = {
  received: '已收到',
  held: '持有中',
  endorsed: '已背书',
  discounted: '已贴现',
  settled: '已结清',
  dishonored: '已拒付',
};

const TYPE_LABELS: Record<NoteType, string> = {
  bank: '银行承兑',
  commercial: '商业承兑',
};

function money(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

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
 */
const NotesPage: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState<string>('outstanding');
  const [createOpen, setCreateOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<NoteItem | null>(null);
  const [actionKind, setActionKind] = useState<NoteAction>('hold');
  const [counterparty, setCounterparty] = useState('');
  const [discountRate, setDiscountRate] = useState('');
  const [discountDate, setDiscountDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [remark, setRemark] = useState('');
  const [preview, setPreview] = useState<NoteDiscountPreview | null>(null);
  const [busy, setBusy] = useState(false);

  // 新建表单
  const [noteNo, setNoteNo] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('bank');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [drawer, setDrawer] = useState('');

  const { data: dict } = useAsyncData(() => notesApi.getNoteDictionaries(), []);
  const { data: register, reload: reloadRegister } =
    useAsyncData<NoteRegisterResult>(() => notesApi.getNoteRegister(), []);
  const { data: alerts, reload: reloadAlerts } = useAsyncData<NoteDueAlert[]>(
    () => notesApi.getNoteDueAlerts(),
    [],
  );
  const { data: basis } = useAsyncData(() => notesApi.getDiscountBasis(), []);
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

  const allNotes: NoteItem[] = notes?.items ?? [];
  const rows =
    statusFilter === 'outstanding'
      ? allNotes.filter(
          (note) => note.status !== 'settled' && note.status !== 'dishonored',
        )
      : allNotes;
  const alertRows = alerts ?? [];
  const actionOptions = (dict?.actions ?? []).filter((item) => {
    if (!actionTarget) return false;
    if (actionTarget.status === 'settled' || actionTarget.status === 'dishonored') {
      return false;
    }
    return true;
  });
  const currentAction = actionOptions.find((item) => item.value === actionKind);

  const reloadAll = () => {
    reload();
    reloadRegister();
    reloadAlerts();
  };

  const submitCreate = async () => {
    const parsedAmount = Number(amount);
    if (!noteNo.trim()) {
      toast.error('请填写票号');
      return;
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast.error('票面金额必须大于 0');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      toast.error('到期日格式必须为 YYYY-MM-DD');
      return;
    }
    setBusy(true);
    try {
      await notesApi.createNote({
        noteNo: noteNo.trim(),
        noteType,
        amount: parsedAmount,
        dueDate,
        drawer: drawer || undefined,
      });
      toast.success('票据已登记');
      setCreateOpen(false);
      setNoteNo('');
      setAmount('');
      setDueDate('');
      setDrawer('');
      reloadAll();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '登记失败'));
    } finally {
      setBusy(false);
    }
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
        <Button type="button" onClick={() => setCreateOpen(true)}>
          登记票据
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {register && (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="票据总额"
              value={money(register.totalAmount)}
            />
            <StatCard
              label="未结清金额"
              value={money(register.outstandingAmount)}
              tone="warning"
            />
            <StatCard
              label="临期/逾期"
              value={String(alertRows.length)}
              tone={alertRows.some((a) => a.level === 'overdue') ? 'warning' : 'info'}
            />
            <StatCard
              label="票面张数"
              value={String(
                register.byStatus.reduce((sum, item) => sum + item.count, 0),
              )}
            />
          </div>
        )}

        {alertRows.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4">
            <h3 className="text-sm font-semibold text-amber-900">
              到期预警（{alertRows.length} 张）
            </h3>
            <div className="flex flex-wrap gap-2">
              {alertRows.map((alert) => (
                <span
                  key={alert.code}
                  className={cn(
                    'rounded px-2 py-1 text-xs',
                    alert.level === 'overdue'
                      ? 'bg-rose-100 text-rose-800'
                      : alert.level === 'urgent'
                        ? 'bg-orange-100 text-orange-800'
                        : 'bg-amber-100 text-amber-800',
                  )}
                >
                  {alert.noteNo} · {money(alert.amount)} ·{' '}
                  {alert.daysLeft < 0
                    ? `已逾期 ${-alert.daysLeft} 天`
                    : alert.daysLeft === 0
                      ? '今日到期'
                      : `${alert.daysLeft} 天后到期`}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Label className="text-sm">状态筛选</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="outstanding">未结清</SelectItem>
              <SelectItem value="all">全部</SelectItem>
              {(dict?.statuses ?? []).map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {basis && (
            <span className="text-xs text-muted-foreground">{basis.note}</span>
          )}
        </div>

        <DataBoundary
          loading={loading}
          error={error}
          empty={rows.length === 0}
          emptyText="暂无票据记录"
          onRetry={reload}
        >
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-2 font-medium">票号</th>
                  <th className="p-2 font-medium">类型</th>
                  <th className="p-2 font-medium">出票人</th>
                  <th className="p-2 text-right font-medium">票面</th>
                  <th className="p-2 font-medium">到期日</th>
                  <th className="p-2 font-medium">状态</th>
                  <th className="p-2 font-medium">关联</th>
                  <th className="p-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((note) => (
                  <tr key={note.id} className="border-t">
                    <td className="p-2 font-mono text-xs">
                      {note.noteNo}
                      <div className="text-muted-foreground">{note.code}</div>
                    </td>
                    <td className="p-2">{TYPE_LABELS[note.noteType]}</td>
                    <td className="p-2">{note.drawer ?? '—'}</td>
                    <td className="p-2 text-right tabular-nums">
                      {money(note.amount)}
                    </td>
                    <td className="p-2">
                      {note.dueDate}
                      {note.daysToDue <= 15 && note.daysToDue >= -9999 && (
                        <div
                          className={cn(
                            'text-xs',
                            note.daysToDue < 0
                              ? 'text-destructive'
                              : 'text-amber-700',
                          )}
                        >
                          {note.daysToDue < 0
                            ? `逾期 ${-note.daysToDue} 天`
                            : `${note.daysToDue} 天后`}
                        </div>
                      )}
                    </td>
                    <td className="p-2">
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-xs',
                          STATUS_TONE[note.status],
                        )}
                      >
                        {STATUS_LABELS[note.status]}
                      </span>
                      {note.discountInterest !== null && (
                        <div className="text-xs text-muted-foreground">
                          息 {money(note.discountInterest)}
                        </div>
                      )}
                    </td>
                    <td className="p-2 text-xs">
                      {note.customerName ?? note.supplierName ?? '—'}
                      {note.endorsementCounterparty && (
                        <div className="text-muted-foreground">
                          背书给 {note.endorsementCounterparty}
                        </div>
                      )}
                    </td>
                    <td className="p-2">
                      {note.status === 'settled' || note.status === 'dishonored' ? (
                        <span className="text-xs text-muted-foreground">
                          已终态
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {(dict?.actions ?? [])
                            .filter((action) => {
                              // 只显示当前状态允许的动作，与后端状态机同源
                              if (action.value === 'endorse') {
                                return (
                                  note.status === 'received' ||
                                  note.status === 'held'
                                );
                              }
                              if (action.value === 'discount') {
                                return (
                                  note.status === 'received' ||
                                  note.status === 'held'
                                );
                              }
                              return true;
                            })
                            .map((action) => (
                              <Button
                                key={action.value}
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-6 px-1.5 text-xs"
                                onClick={() => openAction(note, action.value)}
                              >
                                {action.label}
                              </Button>
                            ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataBoundary>

        {register && (
          <div className="flex flex-col gap-3">
            <h3 className="text-base font-semibold">票据备查簿</h3>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="p-2 font-medium">状态</th>
                      <th className="p-2 text-right font-medium">张数</th>
                      <th className="p-2 text-right font-medium">金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {register.byStatus.map((item) => (
                      <tr key={item.status} className="border-t">
                        <td className="p-2">{item.label}</td>
                        <td className="p-2 text-right tabular-nums">
                          {item.count}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {money(item.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="p-2 font-medium">票据类型</th>
                      <th className="p-2 text-right font-medium">张数</th>
                      <th className="p-2 text-right font-medium">金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {register.byType.map((item) => (
                      <tr key={item.noteType} className="border-t">
                        <td className="p-2">{item.label}</td>
                        <td className="p-2 text-right tabular-nums">
                          {item.count}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {money(item.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 登记票据 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>登记票据</DialogTitle>
            <DialogDescription>
              票号在系统内唯一，同一张票据重复登记会被拒绝（防止重复入账）。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="note-no">票号</Label>
              <Input
                id="note-no"
                value={noteNo}
                onChange={(event) => setNoteNo(event.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="note-type">票据类型</Label>
                <Select
                  value={noteType}
                  onValueChange={(value) => setNoteType(value as NoteType)}
                >
                  <SelectTrigger id="note-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(dict?.types ?? []).map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="note-amount">票面金额</Label>
                <Input
                  id="note-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="note-due">到期日</Label>
                <Input
                  id="note-due"
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="note-drawer">出票人</Label>
                <Input
                  id="note-drawer"
                  value={drawer}
                  onChange={(event) => setDrawer(event.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={busy} onClick={submitCreate}>
              {busy ? '登记中…' : '确认登记'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 流转动作 */}
      <Dialog
        open={actionTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setActionTarget(null);
            setPreview(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {actionOptions.find((a) => a.value === actionKind)?.label ?? '票据流转'}{' '}
              · {actionTarget?.noteNo}
            </DialogTitle>
            <DialogDescription>
              票面 {actionTarget ? money(actionTarget.amount) : ''} 元，到期日{' '}
              {actionTarget?.dueDate}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            {currentAction?.requiresCounterparty && (
              <div className="grid gap-2">
                <Label htmlFor="note-counterparty">受让方（背书给谁）</Label>
                <Input
                  id="note-counterparty"
                  value={counterparty}
                  onChange={(event) => setCounterparty(event.target.value)}
                />
              </div>
            )}
            {currentAction?.requiresRate && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="note-rate">贴现率（%）</Label>
                    <Input
                      id="note-rate"
                      inputMode="decimal"
                      value={discountRate}
                      onChange={(event) => setDiscountRate(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="note-discount-date">贴现日</Label>
                    <Input
                      id="note-discount-date"
                      type="date"
                      value={discountDate}
                      onChange={(event) => setDiscountDate(event.target.value)}
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={runDiscountPreview}
                  >
                    试算贴现息与分录
                  </Button>
                </div>
                {preview && (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                      <StatCard label="票面" value={money(preview.amount)} />
                      <StatCard
                        label={`贴现天数（基准 ${basis?.basis ?? 360}）`}
                        value={`${preview.days} 天`}
                      />
                      <StatCard
                        label="贴现息"
                        value={money(preview.interest)}
                        tone="warning"
                      />
                      <StatCard
                        label="实际到账"
                        value={money(preview.netProceeds)}
                        tone="success"
                      />
                    </div>
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/50">
                          <tr className="text-left">
                            <th className="p-2 font-medium">科目</th>
                            <th className="p-2 text-right font-medium">借方</th>
                            <th className="p-2 text-right font-medium">贷方</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.lines.map((line, index) => (
                            <tr key={`${line.accountCode}-${index}`} className="border-t">
                              <td className="p-2 font-mono">
                                {line.accountCode}
                              </td>
                              <td className="p-2 text-right tabular-nums">
                                {line.debit ? money(line.debit) : ''}
                              </td>
                              <td className="p-2 text-right tabular-nums">
                                {line.credit ? money(line.credit) : ''}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
            <div className="grid gap-2">
              <Label htmlFor="note-remark">备注</Label>
              <Input
                id="note-remark"
                value={remark}
                onChange={(event) => setRemark(event.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              提交后会生成凭证；若凭证服务不可用，业务状态照常推进并进入补偿队列，
              可在凭证失败队列中补录。
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setActionTarget(null)}
            >
              取消
            </Button>
            <Button type="button" disabled={busy} onClick={submitAction}>
              {busy ? '提交中…' : '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
};

export default NotesPage;
