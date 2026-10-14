import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BookMarked, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@client/src/components/ui/table';
import { Textarea } from '@client/src/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@client/src/components/ui/tooltip';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as systemConfigApi from '@client/src/api/system-config';
import type {
  CodeRuleItem,
  DictionaryItem,
  RetentionPolicyItem,
  UpsertDictionaryDto,
} from '@shared/api.interface';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';

const DATE_PATTERN_LABELS: Record<CodeRuleItem['datePattern'], string> = {
  YYYYMM: 'YYYYMM（年月）',
  YYYY: 'YYYY（年）',
  NONE: '无日期段',
};

const RESET_POLICY_LABELS: Record<CodeRuleItem['resetPolicy'], string> = {
  never: '不重置',
  yearly: '按年重置',
  monthly: '按月重置',
};

const RETENTION_ACTION_LABELS: Record<RetentionPolicyItem['action'], string> = {
  none: '仅保留（不处理）',
  archive: '归档',
  delete: '删除',
};

interface DictFormState {
  dictType: string;
  dictKey: string;
  dictLabel: string;
  extra: string;
  sortNo: string;
  enabled: boolean;
  remark: string;
}

const EMPTY_FORM: DictFormState = {
  dictType: '',
  dictKey: '',
  dictLabel: '',
  extra: '',
  sortNo: '100',
  enabled: true,
  remark: '',
};

/** 字典设置（B-03）：按 dictType 分组浏览，内置项只能停用不能删除 */
const DictionarySettings: React.FC = () => {
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState<DictFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const dicts = useAsyncData<DictionaryItem[]>(() => systemConfigApi.listDictionary(), []);
  const codeRules = useAsyncData<CodeRuleItem[]>(() => systemConfigApi.listCodeRules(), []);
  const retentions = useAsyncData<RetentionPolicyItem[]>(
    () => systemConfigApi.listRetentionPolicies(),
    [],
  );

  const items = dicts.data ?? [];

  const types = useMemo(
    () => Array.from(new Set(items.map((item) => item.dictType))).sort(),
    [items],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, DictionaryItem[]>();
    for (const item of items) {
      if (typeFilter !== 'all' && item.dictType !== typeFilter) continue;
      map.set(item.dictType, [...(map.get(item.dictType) ?? []), item]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [items, typeFilter]);

  const openCreate = () => {
    setEditingKey(null);
    setForm({ ...EMPTY_FORM, dictType: typeFilter !== 'all' ? typeFilter : '' });
    setFormError(null);
    setDialogOpen(true);
  };

  const openEdit = (item: DictionaryItem) => {
    setEditingKey(`${item.dictType}.${item.dictKey}`);
    setForm({
      dictType: item.dictType,
      dictKey: item.dictKey,
      dictLabel: item.dictLabel,
      extra: item.extra ?? '',
      sortNo: String(item.sortNo ?? 100),
      enabled: item.enabled,
      remark: item.remark ?? '',
    });
    setFormError(null);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const dictType = form.dictType.trim();
    const dictKey = form.dictKey.trim();
    const dictLabel = form.dictLabel.trim();
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(dictType)) {
      setFormError('字典类型必须小写字母开头，仅含小写字母/数字/下划线，长度 2~64');
      return;
    }
    if (!dictKey) {
      setFormError('字典键必填');
      return;
    }
    if (!dictLabel) {
      setFormError('字典标签必填');
      return;
    }
    const sortNo = Number(form.sortNo);
    if (!Number.isInteger(sortNo) || sortNo < 0 || sortNo > 9999) {
      setFormError('排序号必须为 0~9999 的整数');
      return;
    }
    const dto: UpsertDictionaryDto = {
      dictType,
      dictKey,
      dictLabel,
      extra: form.extra.trim() || undefined,
      sortNo,
      enabled: form.enabled,
      remark: form.remark.trim() || undefined,
    };
    setSaving(true);
    try {
      await systemConfigApi.upsertDictionary(dto);
      toast.success(editingKey ? '字典项已更新' : '字典项已新增');
      setDialogOpen(false);
      await dicts.reload();
    } catch (err) {
      // 409 / 400 的中文原因直接透出，不吞成通用提示
      toast.error(getApiErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: DictionaryItem) => {
    const ok = await confirmDanger(
      `确认删除字典项 ${item.dictType}.${item.dictKey}（${item.dictLabel}）？`,
      { title: '删除字典项', confirmLabel: '确认删除' },
    );
    if (!ok) return;
    setDeletingKey(`${item.dictType}.${item.dictKey}`);
    try {
      await systemConfigApi.deleteDictionary(item.dictType, item.dictKey);
      toast.success('字典项已删除');
      await dicts.reload();
    } catch (err) {
      // 被业务引用时后端返回 409 及中文原因，必须原样展示
      toast.error(getApiErrorMessage(err, '删除失败'));
    } finally {
      setDeletingKey(null);
    }
  };

  const handleRetentionSave = async (
    item: RetentionPolicyItem,
    next: { retainDays: number; action: RetentionPolicyItem['action']; enabled: boolean },
  ) => {
    try {
      await systemConfigApi.updateRetentionPolicy(item.dataType, next);
      toast.success(`保留策略 ${item.displayName} 已保存`);
      await retentions.reload();
    } catch (err) {
      // 审计类数据 action=delete 会被后端拒绝，中文原因需透出
      toast.error(getApiErrorMessage(err, '保存保留策略失败'));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="dict-type-filter" className="text-xs text-muted-foreground">
          字典类型
        </Label>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger id="dict-type-filter" className="w-[240px]">
            <SelectValue placeholder="全部类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型（{types.length}）</SelectItem>
            {types.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" size="sm" onClick={openCreate}>
          <Plus className="size-4" />
          新增字典项
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void dicts.reload()}
          disabled={dicts.loading}
        >
          <RefreshCw className="size-4" />
          刷新
        </Button>
      </div>

      <DataBoundary
        loading={dicts.loading}
        error={dicts.error}
        skeleton="table"
        empty={!dicts.loading && !dicts.error && grouped.length === 0}
        emptyText="暂无字典数据；可点击「新增字典项」创建第一个业务字典"
        onRetry={() => void dicts.reload()}
      >
        <div className="flex flex-col gap-6">
          {grouped.map(([dictType, rows]) => (
            <div key={dictType} className="flex flex-col gap-2">
              <SectionTitle>
                {dictType}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  共 {rows.length} 项
                </span>
              </SectionTitle>
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[180px]">字典键</TableHead>
                      <TableHead>字典标签</TableHead>
                      <TableHead className="w-[180px]">扩展值 extra</TableHead>
                      <TableHead className="w-[80px] text-right">排序</TableHead>
                      <TableHead className="w-[90px]">启用</TableHead>
                      <TableHead className="w-[90px]">来源</TableHead>
                      <TableHead className="min-w-[160px]">备注</TableHead>
                      <TableHead className="w-[140px]">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => {
                      const rowKey = `${row.dictType}.${row.dictKey}`;
                      return (
                        <TableRow key={rowKey}>
                          <TableCell className="tabular-nums">{row.dictKey}</TableCell>
                          <TableCell>{row.dictLabel}</TableCell>
                          <TableCell className="max-w-[200px] truncate">
                            {row.extra ?? '-'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{row.sortNo}</TableCell>
                          <TableCell>
                            <Badge variant={row.enabled ? 'success' : 'secondary'}>
                              {row.enabled ? '启用' : '停用'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {row.builtin ? (
                              <Badge variant="info">内置</Badge>
                            ) : (
                              <Badge variant="outline">自定义</Badge>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[220px] truncate">
                            {row.remark ?? '-'}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => openEdit(row)}
                              >
                                <Pencil className="size-3" />
                                编辑
                              </Button>
                              {row.builtin ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    {/* span 包裹：disabled 按钮不触发 hover 事件，无法显示 tooltip */}
                                    <span className="inline-flex">
                                      <Button type="button" variant="ghost" size="sm" disabled>
                                        <Trash2 className="size-3" />
                                        删除
                                      </Button>
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>内置项只能停用</TooltipContent>
                                </Tooltip>
                              ) : (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={deletingKey === rowKey}
                                  onClick={() => void handleDelete(row)}
                                >
                                  <Trash2 className="size-3" />
                                  删除
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          ))}
        </div>
      </DataBoundary>

      <div className="flex flex-col gap-2">
        <SectionTitle>编号规则</SectionTitle>
        <p className="text-xs text-muted-foreground">
          只读展示：编号规则由后端 sys_code_rule 维护，改动需走 B-08 接口并留审计。
        </p>
        <DataBoundary
          loading={codeRules.loading}
          error={codeRules.error}
          skeleton="table"
          empty={!codeRules.loading && !codeRules.error && (codeRules.data ?? []).length === 0}
          emptyText="暂无编号规则配置"
          onRetry={() => void codeRules.reload()}
        >
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[160px]">业务类型</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead className="w-[110px]">前缀</TableHead>
                  <TableHead className="w-[150px]">日期段</TableHead>
                  <TableHead className="w-[110px] text-right">流水位数</TableHead>
                  <TableHead className="w-[120px]">重置策略</TableHead>
                  <TableHead className="w-[100px]">允许重用</TableHead>
                  <TableHead className="w-[90px]">启用</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(codeRules.data ?? []).map((row) => (
                  <TableRow key={row.bizType}>
                    <TableCell className="tabular-nums">{row.bizType}</TableCell>
                    <TableCell>{row.bizName}</TableCell>
                    <TableCell className="tabular-nums">{row.prefix}</TableCell>
                    <TableCell>{DATE_PATTERN_LABELS[row.datePattern] ?? row.datePattern}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.seqLength}</TableCell>
                    <TableCell>
                      {RESET_POLICY_LABELS[row.resetPolicy] ?? row.resetPolicy}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.allowReuse ? 'warning' : 'secondary'}>
                        {row.allowReuse ? '允许' : '禁止'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.enabled ? 'success' : 'secondary'}>
                        {row.enabled ? '启用' : '停用'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DataBoundary>
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>数据保留策略</SectionTitle>
        <p className="text-xs text-muted-foreground">
          修改后立即生效；审计类数据（audit_log / login_audit）不允许 delete，后端会拒绝并返回原因。
        </p>
        <DataBoundary
          loading={retentions.loading}
          error={retentions.error}
          skeleton="table"
          empty={
            !retentions.loading && !retentions.error && (retentions.data ?? []).length === 0
          }
          emptyText="暂无数据保留策略配置"
          onRetry={() => void retentions.reload()}
        >
          <div className="flex flex-col gap-3">
            {(retentions.data ?? []).map((row) => (
              <RetentionRow key={row.dataType} item={row} onSave={handleRetentionSave} />
            ))}
          </div>
        </DataBoundary>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) setDialogOpen(false);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingKey ? '编辑字典项' : '新增字典项'}</DialogTitle>
            <DialogDescription>
              字典键在同一字典类型内唯一；内置项（builtin）只能停用，不能删除。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="dict-type">字典类型</Label>
              <Input
                id="dict-type"
                value={form.dictType}
                disabled={editingKey !== null}
                placeholder="如 invoice_type"
                onChange={(e) => {
                  setForm({ ...form, dictType: e.target.value });
                  setFormError(null);
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dict-key">字典键</Label>
              <Input
                id="dict-key"
                value={form.dictKey}
                disabled={editingKey !== null}
                placeholder="如 vat_special"
                onChange={(e) => {
                  setForm({ ...form, dictKey: e.target.value });
                  setFormError(null);
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dict-label">字典标签</Label>
              <Input
                id="dict-label"
                value={form.dictLabel}
                placeholder="如 增值税专用发票"
                onChange={(e) => {
                  setForm({ ...form, dictLabel: e.target.value });
                  setFormError(null);
                }}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="dict-sort">排序号</Label>
                <Input
                  id="dict-sort"
                  type="number"
                  min={0}
                  max={9999}
                  value={form.sortNo}
                  onChange={(e) => {
                    setForm({ ...form, sortNo: e.target.value });
                    setFormError(null);
                  }}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="dict-extra">扩展值 extra</Label>
                <Input
                  id="dict-extra"
                  value={form.extra}
                  placeholder="如税率数值 0.06"
                  onChange={(e) => setForm({ ...form, extra: e.target.value })}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              启用
            </label>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dict-remark">备注</Label>
              <Textarea
                id="dict-remark"
                rows={2}
                value={form.remark}
                onChange={(e) => setForm({ ...form, remark: e.target.value })}
              />
            </div>
            {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button type="button" onClick={() => void handleSave()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

interface RetentionRowProps {
  item: RetentionPolicyItem;
  onSave: (
    item: RetentionPolicyItem,
    next: { retainDays: number; action: RetentionPolicyItem['action']; enabled: boolean },
  ) => Promise<void>;
}

const RetentionRow: React.FC<RetentionRowProps> = ({ item, onSave }) => {
  const [retainDays, setRetainDays] = useState(String(item.retainDays));
  const [action, setAction] = useState<RetentionPolicyItem['action']>(item.action);
  const [enabled, setEnabled] = useState(item.enabled);
  const [saving, setSaving] = useState(false);

  const dirty =
    retainDays !== String(item.retainDays) || action !== item.action || enabled !== item.enabled;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3">
      <span className="flex min-w-[200px] items-center gap-2 text-sm font-medium">
        <BookMarked className="size-4 text-muted-foreground" />
        {item.displayName}
        <span className="text-xs font-normal text-muted-foreground">({item.dataType})</span>
      </span>
      <div className="flex items-center gap-2">
        <Label htmlFor={`retain-${item.dataType}`} className="text-xs text-muted-foreground">
          保留天数
        </Label>
        <Input
          id={`retain-${item.dataType}`}
          type="number"
          min={1}
          max={36500}
          className="w-[120px]"
          value={retainDays}
          onChange={(e) => setRetainDays(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground">到期动作</Label>
        <Select
          value={action}
          onValueChange={(value) => setAction(value as RetentionPolicyItem['action'])}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{RETENTION_ACTION_LABELS.none}</SelectItem>
            <SelectItem value="archive">{RETENTION_ACTION_LABELS.archive}</SelectItem>
            <SelectItem value="delete">{RETENTION_ACTION_LABELS.delete}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        启用
      </label>
      <span className="text-xs text-muted-foreground">
        上次执行：
        {item.lastRunAt ? new Date(item.lastRunAt).toLocaleString('zh-CN') : '未执行'}
        {item.lastRunCount === null ? '' : ` · ${item.lastRunCount} 条`}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="ml-auto"
        disabled={!dirty || saving}
        onClick={() => {
          const days = Number(retainDays);
          if (!Number.isInteger(days) || days < 1 || days > 36500) {
            toast.error('保留天数必须为 1~36500 的整数');
            return;
          }
          setSaving(true);
          void onSave(item, { retainDays: days, action, enabled }).finally(() =>
            setSaving(false),
          );
        }}
      >
        {saving ? '保存中…' : '保存'}
      </Button>
    </div>
  );
};

export default DictionarySettings;
