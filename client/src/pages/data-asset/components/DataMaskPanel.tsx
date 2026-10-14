import React, { useState } from 'react';
import { toast } from 'sonner';
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
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as dataAssetApi from '@client/src/api/data-asset';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type {
  DatasetFieldItem,
  DatasetItem,
  GrantItem,
  GrantRevokeLogItem,
  GrantRevokeReason,
  MaskLevelOption,
  SensitiveFieldKind,
} from '@shared/api.interface';

const FIELD_KIND_LABELS: Record<SensitiveFieldKind, string> = {
  name: '姓名',
  phone: '手机号',
  email: '邮箱',
  id_card: '身份证号',
  bank_account: '银行账号',
  address: '地址',
  amount: '金额',
  location: '定位',
  other: '其它',
};

const REVOKE_REASON_LABELS: Record<GrantRevokeReason, string> = {
  expired: '到期自动回收',
  manual: '人工主动回收',
  contract_terminated: '合同终止',
  violation: '违规使用',
  project_closed: '项目结项',
};

/**
 * C-13：脱敏字段登记 + 授权回收审计。
 *
 * 设计要点：
 * 1. **导出前先预览**：业务方常常在黑盒导出后才发现关键列被抹掉或阻断，
 *    因此本页提供"样例脱敏预览"，把 L3/L4 的结果显式摊开。
 * 2. **L4 的回收表单动态加字段**：选中 L4 数据集时，界面主动要求
 *    「复核人」与「销毁凭证」，而不是等提交后报 400。
 * 3. **审计留痕不可编辑**：回收记录只读展示，避免事后篡改。
 */
const DataMaskPanel: React.FC = () => {
  const [selectedDataset, setSelectedDataset] = useState<string>('');
  const [fieldOpen, setFieldOpen] = useState(false);
  const [columnName, setColumnName] = useState('');
  const [fieldKind, setFieldKind] = useState<SensitiveFieldKind>('phone');
  const [fieldLabel, setFieldLabel] = useState('');
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
  const [revokeReason, setRevokeReason] =
    useState<GrantRevokeReason>('manual');
  const [reviewedBy, setReviewedBy] = useState('');
  const [destructionProof, setDestructionProof] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: levels } = useAsyncData<MaskLevelOption[]>(
    () => dataAssetApi.listMaskLevels(),
    [],
  );
  const { data: datasets } = useAsyncData(
    () => dataAssetApi.listDatasets({ pageSize: 200 }),
    [],
  );
  const { data: grants, reload: reloadGrants } = useAsyncData(
    () => dataAssetApi.listGrants({ pageSize: 200 }),
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
  const activeDataset = datasetOptions.find((d) => d.id === selectedDataset);
  const targetLevel = levelOptions.find(
    (level) => level.level === activeDataset?.maskLevel,
  );
  const revokeNeedsDualControl = targetLevel?.destroyProofRequired ?? false;

  const saveField = async () => {
    if (!selectedDataset) {
      toast.error('请先选择数据集');
      return;
    }
    if (!columnName.trim()) {
      toast.error('请填写列名');
      return;
    }
    setBusy(true);
    try {
      await dataAssetApi.upsertDatasetField(selectedDataset, {
        columnName: columnName.trim(),
        fieldKind,
        fieldLabel: fieldLabel || undefined,
      });
      toast.success('字段登记已保存');
      setFieldOpen(false);
      setColumnName('');
      setFieldLabel('');
      reloadFields();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '保存失败'));
    } finally {
      setBusy(false);
    }
  };

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

  const submitRevoke = async () => {
    if (!revokeTarget) return;
    setBusy(true);
    try {
      const result = await dataAssetApi.revokeGrant(revokeTarget.id, {
        reason: revokeReason,
        reviewedBy: reviewedBy || undefined,
        destructionProof: destructionProof || undefined,
      });
      toast.success(
        `授权已回收，审计记录 ${result.logId.slice(0, 8)}…（${
          REVOKE_REASON_LABELS[revokeReason]
        }）`,
      );
      setRevokeTarget(null);
      setReviewedBy('');
      setDestructionProof('');
      reloadGrants();
      reloadLogs();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '回收失败'));
    } finally {
      setBusy(false);
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
              <Label className="text-xs">数据集</Label>
              <Select
                value={selectedDataset}
                onValueChange={setSelectedDataset}
              >
                <SelectTrigger className="w-72">
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
            <Label className="text-xs">样例数据（JSON）</Label>
            <Input
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

      <Dialog open={fieldOpen} onOpenChange={setFieldOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>登记脱敏字段</DialogTitle>
            <DialogDescription>
              列名必须与导出文件中的列头一致，否则该列会按「其它」处理（L4 下被阻断）。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="mask-column">列名</Label>
              <Input
                id="mask-column"
                value={columnName}
                placeholder="customerName"
                onChange={(event) => setColumnName(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mask-kind">字段语义</Label>
              <Select
                value={fieldKind}
                onValueChange={(value) =>
                  setFieldKind(value as SensitiveFieldKind)
                }
              >
                <SelectTrigger id="mask-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(FIELD_KIND_LABELS) as SensitiveFieldKind[]).map(
                    (key) => (
                      <SelectItem key={key} value={key}>
                        {FIELD_KIND_LABELS[key]}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mask-label">说明</Label>
              <Input
                id="mask-label"
                value={fieldLabel}
                onChange={(event) => setFieldLabel(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setFieldOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={busy} onClick={saveField}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              回收授权 {revokeTarget?.code}
              {revokeNeedsDualControl && '（L4 核心数据）'}
            </DialogTitle>
            <DialogDescription>
              {revokeNeedsDualControl
                ? '该数据集为 L4 核心等级：必须由他人复核，并登记对方删除副本的凭证。'
                : '违规回收必须登记销毁凭证；其余情况可选填。'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="revoke-reason">回收原因</Label>
              <Select
                value={revokeReason}
                onValueChange={(value) =>
                  setRevokeReason(value as GrantRevokeReason)
                }
              >
                <SelectTrigger id="revoke-reason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(REVOKE_REASON_LABELS) as GrantRevokeReason[]).map(
                    (key) => (
                      <SelectItem key={key} value={key}>
                        {REVOKE_REASON_LABELS[key]}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="revoke-reviewer">
                复核人{revokeNeedsDualControl ? '（必填，且不能是操作人本人）' : ''}
              </Label>
              <Input
                id="revoke-reviewer"
                value={reviewedBy}
                placeholder="复核人 妙搭 userId"
                onChange={(event) => setReviewedBy(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="revoke-proof">
                销毁凭证
                {revokeNeedsDualControl || revokeReason === 'violation'
                  ? '（必填）'
                  : ''}
              </Label>
              <Input
                id="revoke-proof"
                value={destructionProof}
                placeholder="对方出具的删除确认函编号"
                onChange={(event) => setDestructionProof(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRevokeTarget(null)}
            >
              取消
            </Button>
            <Button type="button" disabled={busy} onClick={submitRevoke}>
              {busy ? '提交中…' : '确认回收'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DataMaskPanel;
