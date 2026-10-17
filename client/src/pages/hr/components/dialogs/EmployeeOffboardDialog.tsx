/**
 * 「员工离职」弹窗
 *
 * §5.9（F8）：从 `EmployeePanel.tsx` 抽出的 `<Dialog open={resignTarget !== null}>` 块
 * （原第 798–860 行）及其状态与提交处理函数。
 *
 * ## 逐字搬运，三处"父组件 state/回调变 props"
 *
 *   · `resignTarget` 由父组件 state 改为**同名 prop** —— 于是 JSX 里的
 *     `open={resignTarget !== null}`、`resignTarget?.name`、`resignTarget?.code`
 *     一字未改；
 *   · `resetOffboardDialog` 里的 `setResignTarget(null)` → `onClose()`
 *     （父组件传 `() => setResignTarget(null)`）；
 *   · `doOffboard` 成功后的 `await reload()` → `await onSaved()`。
 *
 * `resignDate` / `resignRemark` / `offboardResult` / `operating` 原就是**只被本弹窗读写**
 * 的状态，一并搬进本组件（`operating` 原与两个表单弹窗共用，说明见
 * `EmployeeFormDialog.tsx`；三个弹窗互斥，可见行为一致）。
 *
 * ## reset 语义（原样保留）
 *
 * 本弹窗**没有** reset-on-open：`resignDate` / `resignRemark` / `offboardResult` 只在
 * `resetOffboardDialog()` 里被清空，即"关闭弹窗时"与"离职成功且无待交接项目时"两个触发点。
 * 也就是说：上一次填了离职日期、中途点遮罩关掉 → 已清空；办理成功后有待交接项目 → 结果视图
 * 保留在弹窗里。两条都按原样复现，未新增 reset。
 */
import React, { useState } from 'react';
import { toast } from 'sonner';
import DateField from '@client/src/components/erp/DateField';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { hrApi } from '@client/src/api';
import type {
  Employee,
  HandoverProject,
  OffboardEmployeeDto,
  OffboardResult,
} from '@shared/api.interface';

interface EmployeeOffboardDialogProps {
  /** 待离职员工；null 表示弹窗关闭（父组件 `resignTarget`） */
  resignTarget: Employee | null;
  /** 关闭弹窗并清空父组件的 `resignTarget`（父组件 `setResignTarget(null)`） */
  onClose: () => void;
  /** 写成功后的刷新（父组件传 `reload`，原 `await reload()`） */
  onSaved: () => void | Promise<void>;
}

const EmployeeOffboardDialog: React.FC<EmployeeOffboardDialogProps> = ({
  resignTarget,
  onClose,
  onSaved,
}) => {
  const [resignDate, setResignDate] = useState<string | undefined>(undefined);
  const [resignRemark, setResignRemark] = useState('');
  const [offboardResult, setOffboardResult] = useState<OffboardResult | null>(null);
  const [operating, setOperating] = useState(false);

  const resetOffboardDialog = () => {
    onClose();
    setResignDate(undefined);
    setResignRemark('');
    setOffboardResult(null);
  };

  const doOffboard = async () => {
    if (!resignTarget) return;
    if (!resignDate) {
      toast.error('请选择离职日期');
      return;
    }
    setOperating(true);
    try {
      const dto: OffboardEmployeeDto = {
        resignDate,
        remark: resignRemark.trim() || undefined,
      };
      const result = await hrApi.offboardEmployee(resignTarget.id, dto);
      if (result.handoverProjects.length === 0) {
        toast.success('离职手续已办理');
        resetOffboardDialog();
      } else {
        setOffboardResult(result);
        toast.success(`办理成功，待交接项目 ${result.handoverProjects.length} 个`);
      }
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setOperating(false);
    }
  };

  return (
    <Dialog
      open={resignTarget !== null}
      onOpenChange={(open: boolean) => {
        if (!open) resetOffboardDialog();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>员工离职</DialogTitle>
        </DialogHeader>
        {offboardResult ? (
          <div className="space-y-4">
            <p className="text-sm text-success">
              办理成功，待交接项目 {offboardResult.handoverProjects.length} 个：
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {offboardResult.handoverProjects.map((p: HandoverProject) => (
                <li key={p.projectId}>
                  {p.projectName}（已确认工时 {p.confirmedHours} 小时）
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              请及时安排项目交接，交接完成后再关闭项目。
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              确认为 {resignTarget?.name}（{resignTarget?.code}）办理离职手续？
            </p>
            <div className="space-y-2">
              <Label id="resign-date-label" htmlFor="resign-date">
                离职日期 <span aria-hidden="true" className="text-destructive">*</span>
              </Label>
              <div id="resign-date">
                {/*
                 * 本弹窗**没有** `useForm`（`resignDate` 只是一个 useState），
                 * 因此不能给 `DateField` 套 `FormControl` —— 那会让
                 * `useFormContext()` 为 null 并把整页交给错误边界
                 * （走查实测：点「离职」即白屏，弹窗根本打不开）。
                 * 改为把标签 id 传给控件，由它自己加 `aria-labelledby`，
                 * 标签与控件的关联仍然成立。
                 */}
                <DateField
                  value={resignDate}
                  onChange={setResignDate}
                  labelledBy="resign-date-label"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="resign-remark">备注</Label>
              <Input
                id="resign-remark"
                placeholder="离职原因、交接安排等（可选）"
                value={resignRemark}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setResignRemark(e.target.value)
                }
              />
            </div>
          </div>
        )}
        <DialogFooter>
          {offboardResult ? (
            <Button onClick={resetOffboardDialog}>关闭</Button>
          ) : (
            <Button onClick={() => void doOffboard()} disabled={operating}>
              确认离职
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default EmployeeOffboardDialog;
