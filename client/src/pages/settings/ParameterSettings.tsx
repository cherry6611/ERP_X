import React, { useMemo, useState } from 'react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@client/src/components/ui/table';
import { Textarea } from '@client/src/components/ui/textarea';
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

  const openEdit = (item: SystemParamItem) => {
    setEditing(item);
    setDraft(item.paramValue);
  };

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
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[240px]">参数键</TableHead>
                      <TableHead>参数值</TableHead>
                      <TableHead className="w-[100px]">值类型</TableHead>
                      <TableHead className="min-w-[220px]">说明</TableHead>
                      <TableHead className="w-[120px]">可编辑</TableHead>
                      <TableHead className="w-[110px]">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.paramKey}>
                        <TableCell className="tabular-nums">{row.paramKey}</TableCell>
                        <TableCell className="max-w-[280px] truncate font-mono text-xs">
                          {row.paramValue || '(空)'}
                        </TableCell>
                        <TableCell>{row.valueType}</TableCell>
                        <TableCell className="max-w-[320px] truncate">
                          {row.description ?? '-'}
                        </TableCell>
                        <TableCell>
                          {row.editable ? (
                            <Badge variant="info">可编辑</Badge>
                          ) : (
                            <Badge variant="secondary">
                              <Lock className="mr-1 size-3" />
                              系统锁定
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {row.editable ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(row)}
                            >
                              <Pencil className="size-3" />
                              编辑
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              系统内部参数，禁止修改
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
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
