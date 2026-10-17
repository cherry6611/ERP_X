import React, { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BookMarked, Plus, RefreshCw } from 'lucide-react';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
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
import { SectionTitle } from '@client/src/components/SectionTitle';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as systemConfigApi from '@client/src/api/system-config';
import { codeRuleSample } from './code-rule-sample';
import { Table, type TableColumnsType } from 'antd';
import type {
  CodeRuleItem,
  DictionaryItem,
  RetentionPolicyItem,
} from '@shared/api.interface';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import DictionaryItemsPanel from './components/DictionaryItemsPanel';
import DictionaryItemDialog, {
  EMPTY_FORM,
  type DictFormState,
} from './components/dialogs/DictionaryItemDialog';

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

/** 字典设置（B-03）：按 dictType 分组浏览，内置项只能停用不能删除 */
const DictionarySettings: React.FC = () => {
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState<DictFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const dicts = useAsyncData<DictionaryItem[]>(() => systemConfigApi.listDictionary(), []);
  const codeRules = useAsyncData<CodeRuleItem[]>(() => systemConfigApi.listCodeRules(), []);
  const retentions = useAsyncData<RetentionPolicyItem[]>(
    () => systemConfigApi.listRetentionPolicies(),
    [],
  );

  // §5.5：`?? []` 每次渲染产生新数组 → 会让下游 useMemo（分组/列定义）失效
  const items = useMemo(() => dicts.data ?? [], [dicts.data]);

  const types = useMemo(
    () => Array.from(new Set(items.map((item) => item.dictType))).sort(),
    [items],
  );

  const openCreate = () => {
    setEditingKey(null);
    setForm({ ...EMPTY_FORM, dictType: typeFilter !== 'all' ? typeFilter : '' });
    setFormError(null);
    setDialogOpen(true);
  };

  /*
   * `useCallback` 是必需的：它是 `dictColumns`（useMemo）的依赖，
   * 每次渲染新建的闭包会让 useMemo 每次失效 → antd 表头重建。
   */
  const openEdit = useCallback((item: DictionaryItem) => {
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
  }, []);

  /*
   * `useCallback` 是必需的：`handleDelete` 是 `dictColumns`（useMemo）的依赖，
   * 每次渲染新建的闭包会让 useMemo 每次失效 → antd 表头重建。
   *
   * 依赖里的 `dicts` 由 `useAsyncData` 返回（对象引用每次渲染可能变，但内部
   * `reload` 引用恒定）；这里列 `dicts` 而不是 `dicts.reload` 是因为
   * `exhaustive-deps` 对成员表达式只认最外层对象，列对象可消除告警且行为等价。
   */
  const handleDelete = useCallback(
    async (item: DictionaryItem) => {
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
    },
    [dicts],
  );

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

  /** §5.5（F4）：编号规则列定义（只读展示） */
  const codeRuleColumns = useMemo<TableColumnsType<CodeRuleItem>>(
    () => [
      { title: '业务类型', dataIndex: 'bizType', width: 160 },
      /*
       * 缺陷修复（本轮 F8 拆分时发现）：原为 `dataIndex: 'name'`，但
       * `CodeRuleItem`（shared/api.interface.ts:4515，契约唯一权威）里没有 `name`
       * 字段，只有 `bizName`；后端 `SystemConfigService.listCodeRules()` 经
       * `toCodeRule()`（system-config.service.ts:249-271）也只产出 `bizName`。
       * 该列没有 `render` 兜底，antd 取 `record.name` 得到 undefined →「名称」列
       * **每一行都是空白**（不是显示 "-"，是整格空白），而 646 行版与 719 行版都
       * 通过了 `tsc --noEmit`：antd 的 `dataIndex` 类型是
       * `DataIndex<T> = DeepNamePath<T> | SpecialString<T> | number | …`，其中
       * `SpecialString<T> = T | (string & {})` 的 `string & {}` 让**任意字符串**
       * 都可赋值（node_modules/@rc-component/table/es/interface.d.ts:69），所以字段名
       * 写错不会被静态检查拦下。改成 `bizName` 后该列才真的显示编号规则名称。
       */
      { title: '名称', dataIndex: 'bizName', width: 200 },
      { title: '前缀', dataIndex: 'prefix', width: 110 },
      { title: '日期段', dataIndex: 'datePattern', width: 140,
        render: (value: CodeRuleItem['datePattern']) => DATE_PATTERN_LABELS[value] ?? value },
      { title: '重置策略', dataIndex: 'resetPolicy', width: 140,
        render: (value: CodeRuleItem['resetPolicy']) => RESET_POLICY_LABELS[value] ?? value },
      { title: '流水位数', dataIndex: 'seqLength', width: 110, align: 'right',
        render: (value: number) => <span className="tabular-nums">{value}</span> },
      { title: '流水复用', dataIndex: 'allowReuse', width: 110,
        render: (value: boolean) => (
          <Badge variant={value ? 'warning' : 'secondary'}>{value ? '允许' : '禁止'}</Badge>
        ) },
      {
        /*
         * ⚠️ 原先这里是 `{ title: '示例', dataIndex: 'sample', …,
         * render: (value) => value ?? '-' }`。
         *
         * 问题不在 render（它确实有兜底），而在 **`sample` 这个字段不存在**：
         * 契约 `CodeRuleItem` 只有 `bizType/bizName/prefix/datePattern/seqLength/
         * resetPolicy/allowReuse/enabled/remark`，服务端 `toCodeRule()` 也从不
         * 产出 `sample`。所以 `value` 恒为 `undefined`，那一列**每一行都只显示
         * `-`** —— 一个永远给不出信息的占位列。
         *
         * 为什么 `tsc` 没拦住：antd 的 `DataIndex<T>` 含
         * `SpecialString<T> = T | (string & {})`，任意字符串都通过类型检查，
         * 写错字段名**完全不报错**。同一张表里的 `dataIndex: 'name'`
         * （正确字段是 `bizName`）就是同一类错误，本轮一并修掉了。
         *
         * 改为按规则**推算**：示例 = `前缀 + 日期段 + 补零流水`，三者都已在本行
         * 数据里，因此无需新增契约字段、也无需改服务端。推算逻辑抽到纯函数模块
         * `./code-rule-sample`（11 条断言：三种日期段、**业务时区**跨月跨年、
         * 非法 `seqLength` 回落、前缀为空）。
         *
         * ⚠️ 用 `key` 而不是 `dataIndex`：这一列的值由 `render` 完全算出，
         * 保留 `dataIndex: 'sample'` 只会继续指向一个不存在的字段
         * （并让下一个读代码的人以为服务端会下发它）。
         */
        title: '示例',
        key: 'sample',
        width: 180,
        ellipsis: true,
        render: (_: unknown, rule: CodeRuleItem) => codeRuleSample(rule),
      },
    ],
    [],
  );
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

      <DictionaryItemsPanel
        items={items}
        typeFilter={typeFilter}
        loading={dicts.loading}
        error={dicts.error}
        deletingKey={deletingKey}
        onRetry={() => void dicts.reload()}
        onEdit={openEdit}
        onDelete={handleDelete}
      />

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
            {/* §5.5（F4）：编号规则改 antd `<Table>`（只读展示） */}
            <Table<CodeRuleItem>
              columns={codeRuleColumns}
              dataSource={codeRules.data ?? []}
              loading={codeRules.loading}
              rowKey="bizType"
              size="small"
              scroll={{ x: 900 }}
              pagination={{
                pageSize: 20,
                showSizeChanger: false,
                showTotal: (total: number) => `共 ${total} 条规则`,
              }}
              locale={{ emptyText: '暂无编号规则配置' }}
            />
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

      <DictionaryItemDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) setDialogOpen(false);
        }}
        editingKey={editingKey}
        form={form}
        setForm={setForm}
        formError={formError}
        setFormError={setFormError}
        onSaved={dicts.reload}
      />
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
        {/*
          a11y（§5.10 / P2-3）：Radix Select 触发器是 <button>，
          `htmlFor` 不适用，改用 `aria-labelledby` 指向本标签 id。
        */}
        <Label
          className="text-xs text-muted-foreground"
          id="dict-retention-action-label"
        >
          到期动作
        </Label>
        <Select
          value={action}
          onValueChange={(value) => setAction(value as RetentionPolicyItem['action'])}
        >
          <SelectTrigger
            className="w-[180px]"
            aria-labelledby="dict-retention-action-label"
          >
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
