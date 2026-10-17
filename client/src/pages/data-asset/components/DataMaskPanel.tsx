import React, { useState } from 'react';
import { toast } from 'sonner';
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
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as dataAssetApi from '@client/src/api/data-asset';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { FIELD_KIND_LABELS } from './mask-labels';
import FieldRegisterDialog from './dialogs/FieldRegisterDialog';
import RevokeGrantDialog from './dialogs/RevokeGrantDialog';
import type {
  DatasetFieldItem,
  DatasetItem,
  GrantItem,
  GrantRevokeLogItem,
  MaskLevelOption,
} from '@shared/api.interface';

/**
 * C-13：脱敏字段登记 + 授权回收审计。
 *
 * 设计要点：
 * 1. **导出前先预览**：业务方常常在黑盒导出后才发现关键列被抹掉或阻断，
 *    因此本页提供"样例脱敏预览"，把 L3/L4 的结果显式摊开。
 * 2. **L4 的回收表单动态加字段**：被回收的授权所属数据集为 L4 时，界面主动要求
 *    「复核人」与「销毁凭证」，而不是等提交后报 400。
 * 3. **审计留痕不可编辑**：回收记录只读展示，避免事后篡改。
 *
 * ## §5.9（F8）：本文件只做**布局编排**（拆分前 615 行）
 *
 * 上一轮的教训是"只搬纯声明不够 —— JSX 才是体量所在"。本轮把两个**自包含弹窗**
 * （连同只属于它们的 state 与提交处理器）逐字搬到 `components/dialogs/`：
 *
 * | 原位置 | 去向 | 承担什么 |
 * |---|---|---|
 * | `FIELD_KIND_LABELS` / `REVOKE_REASON_LABELS` | `mask-labels.ts` | 文案表；前者**父组件与本弹窗都要用**，故单独成模块 |
 * | 「登记脱敏字段」弹窗 + 三个输入值 + `saveField` | `dialogs/FieldRegisterDialog.tsx` | 自持输入值与 `busy` |
 * | 「回收授权」弹窗 + 三个输入值 + `submitRevoke` | `dialogs/RevokeGrantDialog.tsx` | 自持输入值与 `busy`；只接收被回收的那条授权 |
 *
 * **本文件保留**：五路数据查询（`useAsyncData`）、`revokeNeedsDualControl` 派生值、
 * 脱敏等级卡、字段登记表、脱敏预览、授权与审计两张只读表、以及两个弹窗的挂载。
 *
 * ⚠️ 拆分**不改行为**：两个弹窗都**无条件挂载**（`{open && <X/>}` 会让"取消后重开
 * 仍保留上次输入"这一行为消失）；重置时机一律保持原样 —— 两个弹窗都是**写成功后**
 * 清空输入（`fieldKind` / `revokeReason` 刻意不清），没有任何"打开即重置"。
 */
const DataMaskPanel: React.FC = () => {
  const [selectedDataset, setSelectedDataset] = useState<string>('');
  const [fieldOpen, setFieldOpen] = useState(false);
  const [sampleJson, setSampleJson] = useState(
    '{"customerName":"张三","phone":"13800138000","idCard":"110101199001011234","amount":12345.67}',
  );
  const [preview, setPreview] = useState<{
    maskLevel: string;
    maskLevelLabel: string;
    masked: Record<string, unknown>;
    blockedColumns: string[];
  } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<GrantItem | null>(null);

  const { data: levels } = useAsyncData<MaskLevelOption[]>(
    () => dataAssetApi.listMaskLevels(),
    [],
  );
  const { data: datasets } = useAsyncData(
    () => dataAssetApi.listDatasets({ pageSize: 200 }),
    [],
  );
  /*
   * ⚠️ **必须把 `status: 'active'` 交给服务端**，不能只靠下面的本地筛选。
   *
   * 原先写的是 `listGrants({ pageSize: 200 })`，而服务端
   * `parsePageSize` 把 pageSize **截到 100**（`Math.min(100, …)`）——
   * 于是接口只返回**最新 100 条**授权，而本页要用的是"生效中的授权"
   * （下面的表格与空态都按 `status === 'active'` 本地筛选）。
   *
   * 后果（两个都不可接受）：
   *   ① 第 101 条及更早的**生效中授权根本无法回收** —— 它在界面上不存在，
   *      而"授权回收"恰恰是脱敏合规的核心动作（L4 还必须双人复核 + 销毁凭证）；
   *   ② 当最新 100 条里没有 active 时，空态会显示
   *      **「没有生效中的授权」—— 而实际上有**。这类"谎报空态"比报错更危险：
   *      合规检查者会据此以为无需回收。
   *
   * 契约 `GrantListParams` 本来就有 `status` 字段，服务端
   * `listGrants` 也早就实现 `if (status) conditions.push(eq(daGrant.status, status))`
   * —— 即这个筛选**一直是支持的，只是客户端没用**。改用它之后返回的
   * 全部是生效授权，100 条上限不再是"看不见的数据"而是"这一页的容量"。
   *
   * 服务端按创建时间倒序，因此仍有 100 条上限；若某天真会超过 100 条生效授权，
   * 需要的是分页而不是继续调大 pageSize（后者会被服务端静默截断）。
   */
  const { data: grants, reload: reloadGrants } = useAsyncData(
    () => dataAssetApi.listGrants({ status: 'active', pageSize: 100 }),
    [],
  );
  const { data: logs, reload: reloadLogs } = useAsyncData(
    () => dataAssetApi.listRevokeLogs({ pageSize: 100 }),
    [],
  );
  const {
    data: fields,
    loading: fieldsLoading,
    error: fieldsError,
    reload: reloadFields,
  } = useAsyncData<DatasetFieldItem[]>(
    async () =>
      selectedDataset ? dataAssetApi.listDatasetFields(selectedDataset) : [],
    [selectedDataset],
  );

  const datasetOptions: DatasetItem[] = datasets?.items ?? [];
  const grantRows: GrantItem[] = grants?.items ?? [];
  const logRows: GrantRevokeLogItem[] = logs?.items ?? [];
  const levelOptions = levels ?? [];
  /*
   * ⚠️ 缺陷修复（本轮拆分时发现，与拆分本身无关）：
   * 门禁等级原先取的是「数据集」下拉框的**当前选择**（`selectedDataset`），而不是
   * **被回收的那条授权**所属数据集 —— 弹窗里的「（L4 核心数据）」「（必填）」与
   * 描述文案因此跟着上方那个与本弹窗无关的下拉框变化。两个方向都是错的：
   *   · 未选数据集 → `revokeNeedsDualControl` 恒为 false：L4 授权回收不提示
   *     "必须由他人复核 + 登记销毁凭证"，提交后才被服务端 400 拒绝
   *     （正是本文件头部注释声称要避免的形态）；
   *   · 选了 L4 数据集去回收 L1/L2 授权 → 误报"必须复核 + 销毁凭证"。
   *
   * 证据：服务端 `data-asset.service.ts#revokeGrant()` 用该授权自己的
   * `daGrant.datasetId` 关联 `daDataset.maskLevel` 得到 `maskLevel`，再交给
   * `mask-policy.ts#validateRevoke()` 与 `requiresDestructionProof()`
   * （`level === 'L4'`）校验；`da_dataset.mask_level` 由迁移
   * `2026-10-15-upgrade-c13-data-mask.sql` 的 CHECK 约束收敛为 L1~L4。
   * 契约侧 `shared/api.interface.ts` 的 `GrantItem.datasetId` 即该关联键，
   * `MaskLevelOption.destroyProofRequired` 即 `requiresDestructionProof()` 的投影。
   */
  const revokeDataset = datasetOptions.find(
    (d) => d.id === revokeTarget?.datasetId,
  );
  const targetLevel = levelOptions.find(
    (level) => level.level === revokeDataset?.maskLevel,
  );
  const revokeNeedsDualControl = targetLevel?.destroyProofRequired ?? false;

  const removeField = async (field: DatasetFieldItem) => {
    const ok = await confirmDanger(
      `确认删除字段登记「${field.columnName}」？删除后该列将按「其它」处理（L4 下会被阻断导出）。`,
      { title: '删除字段登记' },
    );
    if (!ok) return;
    try {
      await dataAssetApi.deleteDatasetField(field.datasetId, field.columnName);
      toast.success('已删除');
      reloadFields();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '删除失败'));
    }
  };

  const runPreview = async () => {
    if (!selectedDataset) {
      toast.error('请先选择数据集');
      return;
    }
    let sample: Record<string, unknown>;
    try {
      sample = JSON.parse(sampleJson) as Record<string, unknown>;
    } catch {
      toast.error('样例数据必须是合法 JSON');
      return;
    }
    try {
      setPreview(await dataAssetApi.previewMasking(selectedDataset, sample));
    } catch (err) {
      toast.error(getApiErrorMessage(err, '预览失败'));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        脱敏等级 L1 公开 / L2 内部（联系方式掩码）/ L3 敏感（姓名地址掩码、金额区间化）/
        L4 核心（身份证号与完整银行账号**禁止导出**，回收授权需双人确认 + 销毁凭证）。
        未登记的列按「其它」处理，L4 下会被阻断。
      </p>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {levelOptions.map((level) => (
          <div
            key={level.level}
            className="flex flex-col gap-1 rounded-lg border bg-card p-4"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{level.label}</span>
              {level.destroyProofRequired && (
                <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                  需销毁凭证
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{level.description}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h3 className="text-base font-semibold">脱敏字段登记</h3>
          <div className="flex items-end gap-2">
            <div className="grid gap-1">
              {/*
                a11y（§5.10 / P2-3）：Radix Select 的触发器是 <button>，
                `htmlFor` 不适用，改用 `aria-labelledby` 指向本标签 id。
              */}
              <Label className="text-xs" id="data-mask-dataset-label">
                数据集
              </Label>
              <Select
                value={selectedDataset}
                onValueChange={setSelectedDataset}
              >
                <SelectTrigger
                  className="w-72"
                  aria-labelledby="data-mask-dataset-label"
                >
                  <SelectValue placeholder="选择数据集" />
                </SelectTrigger>
                <SelectContent>
                  {datasetOptions.map((dataset) => (
                    <SelectItem key={dataset.id} value={dataset.id}>
                      {dataset.code} {dataset.name}（{dataset.maskLevel}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!selectedDataset}
              onClick={() => setFieldOpen(true)}
            >
              登记字段
            </Button>
          </div>
        </div>

        <DataBoundary
          loading={fieldsLoading}
          error={fieldsError}
          empty={(fields ?? []).length === 0}
          emptyText="该数据集尚未登记脱敏字段；未登记的列在 L4 下会被阻断导出"
          onRetry={reloadFields}
        >
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-2 font-medium">列名</th>
                  <th className="p-2 font-medium">字段语义</th>
                  <th className="p-2 font-medium">说明</th>
                  <th className="p-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {(fields ?? []).map((field) => (
                  <tr key={field.id} className="border-t">
                    <td className="p-2 font-mono text-xs">{field.columnName}</td>
                    <td className="p-2">{FIELD_KIND_LABELS[field.fieldKind]}</td>
                    <td className="p-2 text-muted-foreground">
                      {field.fieldLabel ?? '—'}
                    </td>
                    <td className="p-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => removeField(field)}
                      >
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataBoundary>

        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <h4 className="text-sm font-semibold">脱敏预览</h4>
          <div className="grid gap-2">
            <Label className="text-xs" htmlFor="data-mask-sample-json">
              样例数据（JSON）
            </Label>
            <Input
              id="data-mask-sample-json"
              value={sampleJson}
              onChange={(event) => setSampleJson(event.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={!selectedDataset}
              onClick={runPreview}
            >
              预览脱敏结果
            </Button>
          </div>
          {preview && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                等级 {preview.maskLevelLabel}
                {preview.blockedColumns.length > 0 &&
                  `；被阻断导出的列：${preview.blockedColumns.join('、')}`}
              </p>
              <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
                {JSON.stringify(preview.masked, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">授权回收</h3>
        <DataBoundary
          loading={false}
          error={null}
          empty={grantRows.filter((g) => g.status === 'active').length === 0}
          emptyText="没有生效中的授权"
        >
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-2 font-medium">授权编号</th>
                  <th className="p-2 font-medium">数据集</th>
                  <th className="p-2 font-medium">客户/项目</th>
                  <th className="p-2 font-medium">有效期</th>
                  <th className="p-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {grantRows
                  .filter((grant) => grant.status === 'active')
                  .map((grant) => (
                    <tr key={grant.id} className="border-t">
                      <td className="p-2 font-mono text-xs">{grant.code}</td>
                      <td className="p-2">{grant.datasetName}</td>
                      <td className="p-2">
                        {grant.customerName ?? grant.projectName ?? '—'}
                      </td>
                      <td className="p-2 text-xs">
                        {grant.startDate} ~ {grant.endDate}
                      </td>
                      <td className="p-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setRevokeTarget(grant)}
                        >
                          回收
                        </Button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </DataBoundary>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">回收审计记录</h3>
        <DataBoundary
          loading={false}
          error={null}
          empty={logRows.length === 0}
          emptyText="暂无回收记录"
        >
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-2 font-medium">授权编号</th>
                  <th className="p-2 font-medium">数据集</th>
                  <th className="p-2 font-medium">等级</th>
                  <th className="p-2 font-medium">原因</th>
                  <th className="p-2 font-medium">操作人</th>
                  <th className="p-2 font-medium">复核人</th>
                  <th className="p-2 font-medium">销毁凭证</th>
                  <th className="p-2 font-medium">时间</th>
                </tr>
              </thead>
              <tbody>
                {logRows.map((log) => (
                  <tr key={log.id} className="border-t">
                    <td className="p-2 font-mono text-xs">{log.grantCode}</td>
                    <td className="p-2">{log.datasetName ?? '—'}</td>
                    <td className="p-2">{log.maskLevel}</td>
                    <td className="p-2">{log.reasonLabel}</td>
                    <td className="p-2">{log.operator}</td>
                    <td className="p-2">
                      {log.reviewedBy ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="p-2 text-xs">
                      {log.destructionProof ? (
                        log.destructionProof
                      ) : log.destroyRequired ? (
                        <span className="text-destructive">缺失</span>
                      ) : (
                        <span className="text-muted-foreground">不要求</span>
                      )}
                    </td>
                    <td className="p-2 text-xs">
                      {new Date(log.createdAt).toLocaleString('zh-CN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataBoundary>
      </div>

      <FieldRegisterDialog
        open={fieldOpen}
        onOpenChange={setFieldOpen}
        selectedDataset={selectedDataset}
        reloadFields={reloadFields}
      />

      <RevokeGrantDialog
        revokeTarget={revokeTarget}
        setRevokeTarget={setRevokeTarget}
        revokeNeedsDualControl={revokeNeedsDualControl}
        reloadGrants={reloadGrants}
        reloadLogs={reloadLogs}
      />
    </div>
  );
};

export default DataMaskPanel;
