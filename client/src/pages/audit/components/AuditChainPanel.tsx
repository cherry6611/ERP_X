import React from 'react';
import { toast } from 'sonner';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import StatCard from '@client/src/components/erp/StatCard';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as auditApi from '@client/src/api/audit';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  AuditChainAnchor,
  AuditChainVerification,
  AuditImmutabilityProbe,
} from '@shared/api.interface';

/**
 * D-09 / NFR-S8：审计日志防篡改校验面板。
 *
 * 面板要让审计/合规人员**自己**能回答三个问题，而不是听开发口头保证：
 * 1. 日志有没有被改过？→ 「校验链」按钮（在线重算全部校验和与链关系）
 * 2. 数据库层面真的禁止改删吗？→ 「只追加自检」按钮（真的去 UPDATE/DELETE 一次，
 *    断言被拒绝。这比展示"迁移里有触发器"有说服力）
 * 3. 怎么证明不是整体重写？→ 「导出锚点」把 (末序号, 末校验和, 行数) 保存到外部系统；
 *    下次再导出时对比锚点即可发现整体重写（在线校验做不到这点，因为改完重算 hash 也能通过）
 */
const AuditChainPanel: React.FC = () => {
  const [verification, setVerification] =
    React.useState<AuditChainVerification | null>(null);
  const [anchor, setAnchor] = React.useState<AuditChainAnchor | null>(null);
  const [probe, setProbe] = React.useState<AuditImmutabilityProbe | null>(null);
  const [verifying, setVerifying] = React.useState(false);
  const [anchoring, setAnchoring] = React.useState(false);
  const [probing, setProbing] = React.useState(false);

  const runVerify = async () => {
    setVerifying(true);
    try {
      const result = await auditApi.verifyAuditChain(5000);
      setVerification(result);
      if (result.intact) {
        toast.success(`校验通过：${result.checkedRows} 行链完整`);
      } else {
        toast.error(`发现 ${result.broken.length} 处异常，请立即排查`);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, '校验失败'));
    } finally {
      setVerifying(false);
    }
  };

  const runAnchor = async () => {
    setAnchoring(true);
    try {
      const result = await auditApi.getAuditChainAnchor();
      setAnchor(result);
      toast.success('锚点已生成，请复制到外部系统留存');
    } catch (err) {
      toast.error(getApiErrorMessage(err, '生成锚点失败'));
    } finally {
      setAnchoring(false);
    }
  };

  const runProbe = async () => {
    setProbing(true);
    try {
      const result = await auditApi.probeAuditImmutability();
      setProbe(result);
      if (result.updateBlocked && result.deleteBlocked) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, '自检失败'));
    } finally {
      setProbing(false);
    }
  };

  const shown = verification;
  const shownAnchor = anchor;

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">防篡改校验（等保 / NFR-S8）</h3>
          <p className="text-sm text-muted-foreground">
            每条日志按插入顺序串成校验和链：任何一行被改动，其后所有行的链都会失配。
            表上另有只追加触发器，UPDATE 一律拒绝，DELETE 仅允许带归档标记的清理。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void runVerify()}>
            {verifying ? '校验中…' : '校验链'}
          </Button>
          <Button type="button" variant="outline" onClick={() => void runProbe()}>
            {probing ? '自检中…' : '只追加自检'}
          </Button>
          <Button type="button" variant="outline" onClick={() => void runAnchor()}>
            {anchoring ? '生成中…' : '导出锚点'}
          </Button>
        </div>
      </div>

      {shown && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="校验结果"
              value={shown.intact ? '链完整' : `${shown.broken.length} 处异常`}
              tone={shown.intact ? 'success' : 'warning'}
            />
            <StatCard label="已检查行数" value={String(shown.checkedRows)} />
            <StatCard label="在线日志总行数" value={String(shown.totalOnlineRows)} />
            <StatCard
              label="链序号区间"
              value={`${shown.firstSeq ?? '-'} ~ ${shown.lastSeq ?? '-'}`}
            />
          </div>

          {!shown.intact && (
            <div className="overflow-x-auto rounded-md border border-destructive/40">
              <table className="w-full text-sm">
                <thead className="bg-destructive/5">
                  <tr className="text-left">
                    <th className="p-2 font-medium">链序号</th>
                    <th className="p-2 font-medium">原因</th>
                    <th className="p-2 font-medium">期望值</th>
                    <th className="p-2 font-medium">实际值</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.broken.map((item) => (
                    <tr key={`${item.id}-${item.reason}`} className="border-t">
                      <td className="p-2 tabular-nums">{item.chainSeq}</td>
                      <td className="p-2">{item.reason}</td>
                      <td className="p-2 font-mono text-xs">{item.expected}</td>
                      <td className="p-2 font-mono text-xs">{item.actual}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            校验时间：{new Date(shown.checkedAt).toLocaleString('zh-CN')}
            {shown.lastHash && ` · 链尾校验和 ${shown.lastHash}`}
          </p>
        </div>
      )}

      {probe && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge variant={probe.updateBlocked ? 'default' : 'destructive'}>
            UPDATE {probe.updateBlocked ? '已拒绝' : '未被拒绝'}
          </Badge>
          <Badge variant={probe.deleteBlocked ? 'default' : 'destructive'}>
            DELETE {probe.deleteBlocked ? '已拒绝' : '未被拒绝'}
          </Badge>
          <span className="text-muted-foreground">{probe.message}</span>
        </div>
      )}

      {shownAnchor && (
        <div className="flex flex-col gap-2 rounded-md bg-muted p-3">
          <p className="text-xs text-muted-foreground">
            把下面四个值复制到**外部系统**（另一台机器 / 独立日志 / 时间戳服务）留存。
            在线校验无法发现"改完内容再重算全部校验和"的整体重写，外部锚点可以。
          </p>
          <pre className="overflow-x-auto text-xs">
            {JSON.stringify(shownAnchor, null, 2)}
          </pre>
        </div>
      )}

      {!shown && !probe && (
        <p className="text-sm text-muted-foreground">
          点击「校验链」检查日志是否被改动；点击「只追加自检」验证数据库确实拒绝改写。
        </p>
      )}
    </div>
  );
};

export default AuditChainPanel;
