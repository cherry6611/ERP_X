/**
 * 固定资产面板（列表编排 + 筛选区）
 *
 * §5.9（F8）：主文件只保留**布局编排与筛选区**（页头筛选 / 统计卡 / 失败重试 /
 * 表格 / 两个弹窗的挂载），区块拆到同目录：
 *
 * | 拆出的东西 | 去处 |
 * |---|---|
 * | 「新增资产」弹窗（含 `assetFormSchema` / `EMPTY_ASSET_FORM` / `useForm` / 提交处理函数） | `dialogs/AssetCreateDialog.tsx` |
 * | 「发起资产变更」弹窗（含 `changeFormSchema` / `EMPTY_CHANGE_FORM` / JSX / 提交处理函数） | `dialogs/AssetChangeDialog.tsx` |
 * | `TableColumnsType<AssetItem>` 列定义（含「操作」列的「发起变更」按钮） | `asset-columns.tsx`（工厂函数，注入 `openChangeDialog`） |
 *
 * ## 留在本文件的东西，以及为什么
 *
 * · `changeForm`（`useForm` 实例）、`changeOpen`、以及 `openChangeDialog` —— 见下
 *   "reset 语义"。三者跨越**表格行按钮**与**弹窗**两处，搬进弹窗就必须用
 *   `useEffect` 补 reset，那是行为变更。
 * · `operating` —— 两个弹窗**共用**同一个提交中标志（任一弹窗提交时两处提交按钮一起
 *   置灰），按同名 props 下传，语义逐字不变。
 * · `items` —— 既喂表格 `dataSource`，又是「发起变更」弹窗的资产下拉数据源，
 *   按 prop 下传。
 * · 数据查询（`useAsyncData`：列表 / 总览 / 部门 / 项目）与筛选区 —— 本文件职责。
 *
 * ## reset 语义（**已核对**）
 *
 * 原文件共两处 `reset`，触发点拆分后**逐字未变**：
 *   ① `openChangeDialog(asset)` 里的 `changeForm.reset({...})`（**打开之前**，
 *      同步发生在点击那一刻）—— 原样留在本文件，`changeForm` / `changeOpen` 按
 *      同名 prop 传给弹窗；
 *   ② 提交成功后 `changeForm.reset(EMPTY_CHANGE_FORM)` —— 随 handler 搬进
 *      `AssetChangeDialog.tsx`。
 * 「新增资产」弹窗**没有** reset-on-open（只有 ②），拆分后同样没有。
 */
import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { ASSET_CATEGORY_LABELS, ASSET_STATUS_LABELS } from './AssetStatusBadge';
import { assetColumns } from './asset-columns';
import AssetCreateDialog from './dialogs/AssetCreateDialog';
import AssetChangeDialog, {
  changeFormSchema,
  EMPTY_CHANGE_FORM,
} from './dialogs/AssetChangeDialog';
import { Button } from '@client/src/components/ui/button';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { assetApi, hrApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, formatNumber } from '@client/src/utils/format';
import type {
  AssetItem,
  AssetOverview,
  Department,
  Project,
} from '@shared/api.interface';

const PAGE_SIZE = 20;

const StatCard: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <div className="rounded-xl border border-border/80 bg-card p-4">
    <p className="text-sm text-muted-foreground">{label}</p>
    <p className="text-lg font-semibold">{value}</p>
  </div>
);

const AssetPanel: React.FC = () => {
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData(
    () =>
      assetApi.listAssets({
        page,
        pageSize: PAGE_SIZE,
        status: statusFilter !== 'all' ? statusFilter : undefined,
        category: categoryFilter !== 'all' ? categoryFilter : undefined,
        projectId: projectFilter !== 'all' ? projectFilter : undefined,
      }),
    [page, statusFilter, categoryFilter, projectFilter],
  );

  const {
    data: overview,
    reload: reloadOverview,
  } = useAsyncData<AssetOverview>(() => assetApi.getOverview(), []);

  const { data: departments } = useAsyncData<Department[]>(
    () => hrApi.listDepartments(),
    [],
  );
  const { data: projects } = useAsyncData<Project[]>(
    () => projectsApi.listProjects(),
    [],
  );

  const changeForm = useForm<
    z.input<typeof changeFormSchema>,
    unknown,
    z.output<typeof changeFormSchema>
  >({
    resolver: zodResolver(changeFormSchema),
    defaultValues: EMPTY_CHANGE_FORM,
  });

  const openChangeDialog = (asset: AssetItem) => {
    changeForm.reset({
      ...EMPTY_CHANGE_FORM,
      assetId: asset.id,
      changeType: asset.status === 'idle' ? 'receive' : '',
    });
    setChangeOpen(true);
  };

  const items: AssetItem[] = data?.items ?? [];

  const columns: TableColumnsType<AssetItem> = assetColumns({
    openChangeDialog,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-5 gap-4" data-ai-section-type="card-stat">
        <StatCard
          label="资产原值合计"
          value={formatMoney(overview?.totalOriginalValue)}
        />
        <StatCard
          label="资产净值合计"
          value={formatMoney(overview?.totalNetValue)}
        />
        <StatCard
          label="在用资产"
          value={formatNumber(overview?.inUseCount)}
        />
        <StatCard
          label="已报废资产"
          value={formatNumber(overview?.scrappedCount)}
        />
        <StatCard label="GPU 服务器" value={formatNumber(overview?.gpuCount)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-card px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="asset-status-filter">状态</Label>
            <Select
              value={statusFilter}
              onValueChange={(v: string) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger id="asset-status-filter" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {Object.entries(ASSET_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="asset-category-filter">类别</Label>
            <Select
              value={categoryFilter}
              onValueChange={(v: string) => {
                setCategoryFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger id="asset-category-filter" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类别</SelectItem>
                {Object.entries(ASSET_CATEGORY_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="asset-project-filter">项目</Label>
            <Select
              value={projectFilter}
              onValueChange={(v: string) => {
                setProjectFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger id="asset-project-filter" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部项目</SelectItem>
                {(projects ?? []).map((p: Project) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <CanCapabilityWrite capability="pur_asset">
          <Button onClick={() => setCreateOpen(true)} data-ai-section-type="button">
            <Plus className="mr-1 h-4 w-4" />
            新增资产
          </Button>
        </CanCapabilityWrite>
      </div>

      {error ? (
        <p className="text-sm text-destructive">
          {error}
          <Button
            variant="ghost"
            size="sm"
            className="ml-2"
            onClick={() => void reload()}
          >
            重试
          </Button>
        </p>
      ) : null}

      <Table
        columns={columns}
        dataSource={items}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1100, y: 500 }}
        locale={{ emptyText: '暂无资产数据，点击右上角新增资产' }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          onChange: (p: number) => setPage(p),
        }}
      />

      {/* 新增资产 Dialog */}
      <AssetCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        departments={departments}
        projects={projects}
        operating={operating}
        setOperating={setOperating}
        setPage={setPage}
        onSaved={() => Promise.all([reload(), reloadOverview()])}
      />

      {/* 发起变更 Dialog */}
      <AssetChangeDialog
        changeOpen={changeOpen}
        setChangeOpen={setChangeOpen}
        changeForm={changeForm}
        items={items}
        departments={departments}
        projects={projects}
        operating={operating}
        setOperating={setOperating}
      />
    </div>
  );
};

export default AssetPanel;



