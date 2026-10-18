import React, { useMemo, useState } from 'react';
import { Table, TableColumnsType } from 'antd';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import PageShell from '@client/src/components/PageShell';
import FilterBar from '@client/src/components/erp/FilterBar';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@client/src/components/ui/sheet';
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
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as auditApi from '@client/src/api/audit';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { todayIso } from '@client/src/utils/format';
import AuditChainPanel from './components/AuditChainPanel';
import type { AuditLog } from '@shared/api.interface';

/**
 * 模块标签。
 *
 * ⚠️ 这张表原先只有 9 个键，而 `comp_audit_log` 实际写入的 `object_type` 有
 * `users` / `auth` / `asset` / `pur` / `voucher` / `hr` / `purchase` /
 * 
otifications` / `fin-budget` / `quotation` / `data-asset` 等 —— 界面上
 * 那一列于是显示成生僻的英文单词（`users`、`fin-budget`），
 * 与筛选下拉里的中文标签对不上，用户根本对不出"我筛的是这个模块吗"。
 */
const OBJECT_TYPE_LABELS: Record<string, string> = {
  'master-data': '主数据',
  crm: 'CRM',
  contracts: '合同',
  projects: '项目',
  costs: '成本',
  revenues: '收入',
  finance: '财务',
  bi: 'BI',
  audit: '审计',
  'data-asset': '数据资产',
  users: '用户',
  auth: '登录认证',
  asset: '资产',
  pur: '采购',
  purchase: '采购通知',
  voucher: '凭证',
  hr: '人事',
  notifications: '通知',
  'fin-budget': '预算',
  quotation: '报价单',
};

/**
 * 操作类型标签。
 *
 * 实际写入的 `action` 除 create/update/delete 外还有 
otify`、
 * `identity.create`、`identity.set_roles`、`invoice_verify`、`invoice_certify`
 * 等（见 `comp_audit_log` 的分布）。缺标签时会显示原始英文，
 * 而筛选下拉里也没有这些选项 —— 用户无法按它们筛选。
 */
const ACTION_LABELS: Record<string, string> = {
  create: '创建',
  update: '更新',
  delete: '删除',
  notify: '通知',
  probe: '自检探针',
  'identity.create': '身份创建',
  'identity.set_roles': '设置角色',
  invoice_verify: '发票查验',
  invoice_certify: '发票认证',
};

/** 操作人若不是妙搭 userId（如 anonymous / system / 历史文本），不要走用户解析 */
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTOR_LABELS: Record<string, string> = {
  anonymous: '匿名（未登录）',
  system: '系统',
};

function actorText(actor: string): string {
  return ACTOR_LABELS[actor] ?? actor;
}

function ActorCell({ actor }: { actor: string }): React.ReactElement {
  if (USER_ID_PATTERN.test(actor)) {
    return <UserDisplay userId={actor} size="small" />;
  }
  return <span className="text-muted-foreground">{actorText(actor)}</span>;
}

/** 触发浏览器下载（CSV 由服务端生成，含 BOM，Excel 不会乱码） */
function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const AuditPage: React.FC = () => {
  const [objectType, setObjectType] = useState<string>('all');
  const [action, setAction] = useState<string>('all');
  const [actor, setActor] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [limit, setLimit] = useState(100);
  const [exporting, setExporting] = useState(false);
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  /*
   * ⚠️ 筛选变化必须**重新请求**（服务端过滤），不是在本地 filter。
   * 本地 filter 只能过滤"已经取回来的那 100 行"，用户会以为"没有更多了"。
   */
  const params = useMemo(
    () => ({
      objectType: objectType !== 'all' ? objectType : undefined,
      action: action !== 'all' ? action : undefined,
      actor: actor !== 'all' ? actor : undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      limit,
    }),
    [objectType, action, actor, dateFrom, dateTo, limit],
  );

  const { data, loading, error, reload } = useAsyncData(
    () => auditApi.listAuditLogs(params),
    [params],
  );
  const { data: actors } = useAsyncData(() => auditApi.listAuditActors(), []);

  const rows: AuditLog[] = data?.items ?? [];
  const total = data?.total ?? 0;

  const exportCsv = async (): Promise<void> => {
    setExporting(true);
    try {
      const result = await auditApi.exportAuditLogs(params);
      downloadCsv(result.csv, `审计日志_${todayIso()}.csv`);
      if (result.truncated) {
        toast.warning(
          `命中 ${result.total} 条，已导出最新 ${result.rowCount} 条（超出上限）`,
        );
      } else {
        toast.success(`已导出 ${result.rowCount} 条`);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, '导出失败'));
    } finally {
      setExporting(false);
    }
  };

  const columns: TableColumnsType<AuditLog> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      fixed: 'left',
      width: 170,
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '操作人',
      dataIndex: 'actor',
      width: 170,
      render: (v: string) => <ActorCell actor={v} />,
    },
    {
      title: '操作',
      dataIndex: 'action',
      width: 110,
      render: (a: string) => (
        <Badge variant="secondary">{ACTION_LABELS[a] ?? a}</Badge>
      ),
    },
    {
      title: '模块',
      dataIndex: 'objectType',
      width: 110,
      render: (t: string) => OBJECT_TYPE_LABELS[t] ?? t,
    },
    { title: '对象编号', dataIndex: 'objectCode', width: 150 },
    {
      title: '状态变化',
      key: 'statusChange',
      width: 180,
      render: (_, record) =>
        record.statusAfter
          ? `${record.statusBefore ?? '-'} → ${record.statusAfter}`
          : '-',
    },
    {
      title: '详情',
      dataIndex: 'detail',
      render: (d: string | null) => (
        <span className="text-muted-foreground text-xs break-all line-clamp-2" title={d ?? ''}>
          {d ?? '-'}
        </span>
      ),
    },
    {
      title: '',
      key: 'view',
      width: 72,
      fixed: 'right',
      render: (_v: unknown, record: AuditLog) => (
        <Button
          variant="link"
          size="sm"
          onClick={() => setSelectedLog(record)}
        >
          查看
        </Button>
      ),
    },
  ];

  /** 被筛掉的选项也要能选回来：把当前值并进候选，避免"筛了之后选项消失" */
  const objectTypeOptions = useMemo(() => {
    const keys = new Set([
      ...Object.keys(OBJECT_TYPE_LABELS),
      ...rows.map((r) => r.objectType).filter(Boolean),
    ]);
    return [...keys].sort();
  }, [rows]);

  const actionOptions = useMemo(() => {
    const keys = new Set([
      ...Object.keys(ACTION_LABELS),
      ...rows.map((r) => r.action).filter(Boolean),
    ]);
    return [...keys].sort();
  }, [rows]);

  return (
    <PageShell title="审计日志" description="全局写操作审计记录（只追加，不可篡改）">
      <AuditChainPanel />
      <FilterBar>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-object-type">模块</Label>
          <Select value={objectType} onValueChange={setObjectType}>
            <SelectTrigger id="audit-object-type" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部模块</SelectItem>
              {objectTypeOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  {OBJECT_TYPE_LABELS[value] ?? value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-action">操作类型</Label>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger id="audit-action" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部操作</SelectItem>
              {actionOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  {ACTION_LABELS[value] ?? value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-actor">操作人</Label>
          <Select value={actor} onValueChange={setActor}>
            <SelectTrigger id="audit-actor" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部操作人</SelectItem>
              {(actors ?? []).map((item) => (
                <SelectItem key={item.actor} value={item.actor}>
                  {ACTOR_LABELS[item.actor] ?? item.actor}（{item.count}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-date-from">起始日期</Label>
          <Input
            id="audit-date-from"
            type="date"
            className="w-40"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-date-to">结束日期</Label>
          <Input
            id="audit-date-to"
            type="date"
            className="w-40"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-limit">条数</Label>
          <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
            <SelectTrigger id="audit-limit" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="50">50 条</SelectItem>
              <SelectItem value="100">100 条</SelectItem>
              <SelectItem value="200">200 条</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={exporting}
          onClick={() => void exportCsv()}
        >
          <Download className="mr-2 h-4 w-4" aria-hidden />
          {exporting ? '导出中…' : '导出 CSV'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setObjectType('all');
            setAction('all');
            setActor('all');
            setDateFrom('');
            setDateTo('');
          }}
        >
          重置筛选
        </Button>
      </FilterBar>
      {error ? (
        <p className="text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reload()}>
            重试
          </Button>
        </p>
      ) : null}
      <Table
        columns={columns}
        dataSource={rows}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1200, y: 500 }}
        pagination={{
          pageSize: 10,
          /*
           * 用服务端返回的 `total`，不是 antd 传进来的 `t`。
           * `t` 只是**已加载行数**（≤ limit），拿它当"共 N 条"会在
           * 命中数超过 limit 时低报 —— 审计人员据此判断"就这些了"。
           */
          showTotal: () =>
            total > rows.length
              ? `共 ${total} 条（已加载最新 ${rows.length} 条）`
              : `共 ${total} 条`,
        }}
        locale={{ emptyText: '暂无审计日志，系统写操作将自动记录' }}
      />
      {data && total > rows.length ? (
        <p className="text-xs text-muted-foreground">
          筛选命中 {total} 条，当前显示最新 {rows.length} 条；需要完整数据请用「导出 CSV」。
        </p>
      ) : null}
      <Sheet
        open={selectedLog !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedLog(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-[640px] gap-0 bg-card p-0 sm:max-w-[640px]"
        >
          <SheetHeader className="h-14 flex-row items-center border-b border-border/80 px-5 py-0">
            <SheetTitle className="text-[14px]">审计详情</SheetTitle>
          </SheetHeader>
          {selectedLog ? (
            <div className="flex-1 space-y-5 overflow-y-auto p-5">
              <div className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-3 text-[12px]">
                <span className="text-muted-foreground">时间</span>
                <span>{new Date(selectedLog.createdAt).toLocaleString('zh-CN')}</span>
                <span className="text-muted-foreground">操作人</span>
                <span><ActorCell actor={selectedLog.actor} /></span>
                <span className="text-muted-foreground">操作</span>
                <span>{ACTION_LABELS[selectedLog.action] ?? selectedLog.action}</span>
                <span className="text-muted-foreground">模块</span>
                <span>{OBJECT_TYPE_LABELS[selectedLog.objectType] ?? selectedLog.objectType}</span>
                <span className="text-muted-foreground">对象编号</span>
                <span className="font-mono">{selectedLog.objectCode ?? '-'}</span>
                <span className="text-muted-foreground">状态变化</span>
                <span>
                  {selectedLog.statusAfter
                    ? `${selectedLog.statusBefore ?? '-'} → ${selectedLog.statusAfter}`
                    : '-'}
                </span>
              </div>
              <div className="space-y-2">
                <p className="text-[12px] font-medium">原始详情</p>
                <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border border-border/80 bg-muted/30 p-3 font-mono text-[11px] leading-5 text-muted-foreground">
                  {selectedLog.detail ?? '-'}
                </pre>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </PageShell>
  );
};

export default AuditPage;






