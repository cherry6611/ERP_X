import React, { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Info, Lock, Pencil, RefreshCw } from 'lucide-react';
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
import { Textarea } from '@client/src/components/ui/textarea';
import { Table, type TableColumnsType } from 'antd';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as systemConfigApi from '@client/src/api/system-config';
import type { SystemParamItem } from '@shared/api.interface';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';

/** 参数设置（B-03）：按 paramGroup 分组；editable=false 为系统内部参数，禁止修改 */
const ParameterSettings: React.FC = () => {
  const [editing, setEditing] = useState<SystemParamItem | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const params = useAsyncData<SystemParamItem[]>(() => systemConfigApi.listParams(), []);

  const groups = useMemo(() => {
    const map = new Map<string, SystemParamItem[]>();
    for (const item of params.data ?? []) {
      map.set(item.paramGroup, [...(map.get(item.paramGroup) ?? []), item]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [params.data]);

  /*
   * `openEdit` 包成 `useCallback`：它要作为 `paramColumns`（useMemo）的依赖，
   * 每次渲染新建的闭包会让 useMemo 每次都失效 → antd 表头重建。
   */
  const openEdit = useCallback((item: SystemParamItem) => {
    setEditing(item);
    setDraft(item.paramValue);
  }, []);

  const handleSave = async () => {
    if (!editing) return;
    const value = draft.trim();
    if (editing.valueType === 'number' && !Number.isFinite(Number(value))) {
      toast.error('该参数为数值类型，请输入合法数字');
      return;
    }
    if (editing.valueType === 'boolean' && !['0', '1', 'true', 'false'].includes(value)) {
      toast.error('该参数为布尔类型，请输入 1/0 或 true/false');
      return;
    }
    if (editing.valueType === 'json') {
      try {
        JSON.parse(value);
      } catch {
        toast.error('该参数为 JSON 类型，请输入合法 JSON');
        return;
      }
    }
    setSaving(true);
    try {
      await systemConfigApi.updateParam(editing.paramKey, value);
      toast.success(`参数 ${editing.paramKey} 已保存`);
      setEditing(null);
      await params.reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  /**
   * §5.5（F4）：参数表的列定义。
   *
   * ## 两个要点都不是可选的
   *
   * ① `useMemo` 稳定引用：antd Table 收到新的 `columns` 数组会重建表头
   *    （丢失排序/筛选状态）。依赖 `openEdit` 同理，故把它包成 `useCallback`。
   *
   * ② `ellipsis: true` 取代原 `max-w-[280px] truncate`：参数值常是长 JSON，
   *    `truncate` **静默截断**且没有 tooltip；`ellipsis` 自带 tooltip。
   *    这是**信息可得性**的差别，不是样式偏好 —— 使用者原先看不到完整参数值，
   *    只能去数据库里查。
   */
  const paramColumns = useMemo<TableColumnsType<SystemParamItem>>(
    () => [
      {
        title: '参数键',
        dataIndex: 'paramKey',
        width: 260,
        render: (value: string) => (
          <span className="font-mono text-xs tabular-nums">{value}</span>
        ),
        sorter: (a, b) => a.paramKey.localeCompare(b.paramKey),
      },
      {
        title: '参数值',
        dataIndex: 'paramValue',
        width: 300,
        ellipsis: true,
        render: (value: string) => (
          <span className="font-mono text-xs">{value || '(空)'}</span>
        ),
      },
      {
        title: '值类型',
        dataIndex: 'valueType',
        width: 100,
      },
      {
        title: '说明',
        dataIndex: 'description',
        width: 280,
        ellipsis: true,
        render: (value: string | null) => value ?? '-',
      },
      {
        title: '可编辑',
        dataIndex: 'editable',
        width: 130,
        // 原实现没有筛选，而"哪些参数我能改"是这一页最常见的诉求
        filters: [
          { text: '可编辑', value: true },
          { text: '系统锁定', value: false },
        ],
        onFilter: (value, record) => record.editable === value,
        render: (value: boolean) =>
          value ? (
            <Badge variant="info">可编辑</Badge>
          ) : (
            <Badge variant="secondary">
              <Lock className="mr-1 size-3" />
              系统锁定
            </Badge>
          ),
      },
      {
        title: '操作',
        key: 'action',
        width: 150,
        fixed: 'right',
        render: (_value, record) =>
          record.editable ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => openEdit(record)}
            >
              <Pencil className="size-3" />
              编辑
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">
              系统内部参数，禁止修改
            </span>
          ),
      },
    ],
    [openEdit],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void params.reload()}
          disabled={params.loading}
        >
          <RefreshCw className="size-4" />
          刷新
        </Button>
        <span className="text-xs text-muted-foreground">
          参数改动立即生效，字典/参数缓存会在写接口内失效。
        </span>
      </div>

      <DataBoundary
        loading={params.loading}
        error={params.error}
        skeleton="table"
        empty={!params.loading && !params.error && groups.length === 0}
        emptyText="暂无系统参数；参数由后端 sys_param 表种子化"
        onRetry={() => void params.reload()}
      >
        <div className="flex flex-col gap-6">
          {groups.map(([group, rows]) => (
            <div key={group} className="flex flex-col gap-2">
              <SectionTitle>
                {group}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  共 {rows.length} 项
                </span>
              </SectionTitle>
              <div className="rounded-lg border bg-card">
                {/*
                  §5.5（F4）：参数表改 antd `<Table>`，与全仓数据表同轨。
                  原先用 shadcn `Table`（纯样式表格）：无分页、无排序、
                  无 `ellipsis`（参数值可长达数千字符的 JSON，`truncate` 会
                  静默截断且看不到全文）、无空态钩子。
                */}
                <Table<SystemParamItem>
                  columns={paramColumns}
                  dataSource={rows}
                  rowKey="paramKey"
                  size="small"
                  scroll={{ x: 1100 }}
                  pagination={false}
                  locale={{ emptyText: '该分组暂无参数' }}
                />
              </div>
            </div>
          ))}
        </div>
      </DataBoundary>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>编辑参数</DialogTitle>
            <DialogDescription>
              {editing?.paramKey}（{editing?.valueType}）
              {editing?.description ? ` · ${editing.description}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="param-value">参数值</Label>
            {editing?.valueType === 'json' ? (
              <Textarea
                id="param-value"
                rows={5}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : (
              <Input
                id="param-value"
                value={draft}
                placeholder={
                  editing?.valueType === 'boolean'
                    ? '1 / 0 / true / false'
                    : editing?.valueType === 'number'
                      ? '数字'
                      : '文本值'
                }
                onChange={(e) => setDraft(e.target.value)}
              />
            )}
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Info className="size-3" />
              保存后立即写入 sys_param 并清空后端缓存。
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditing(null)}
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

export default ParameterSettings;
