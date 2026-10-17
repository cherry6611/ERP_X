/**
 * §5.9 拆分：「确认申报底稿」弹窗从 `TaxDeclarationPage` 抽出。
 *
 * 抽出的收益：这一块封装了**一条业务规则**（差异说明至少 `minReasonLength` 个字）
 * 与它的两个表现（错误提示、提交禁用）。规则和表现放在一起，改规则时不会漏改提示。
 *
 * ⚠️ 保留的行为细节（容易在重构中丢掉）：
 *   · 用户把说明改到够长时**立即清掉错误提示**（`onReasonChange` 里的判断），
 *     而不是等再次提交才消失；
 *   · 台账与总账不一致时额外给一条警示 —— 但不阻止提交（由使用者判断），
 *     真正决定能不能提交的是"说明是否够长"。
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Button } from '@client/src/components/ui/button';
import { Label } from '@client/src/components/ui/label';
import { Textarea } from '@client/src/components/ui/textarea';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  period: string;
  /** 底稿上的纳税主体名（"全部主体"时为 null/undefined，文案里省略这一段） */
  taxEntityName?: string | null;
  /** 台账与总账是否一致（不一致时多给一条警示，不阻止提交） */
  reconciled: boolean;
  reason: string;
  onReasonChange: (value: string) => void;
  reasonError: string | null;
  /** 说明已够长时通知父页面清掉错误提示（清错时机由本组件判定，父页面只执行） */
  onReasonErrorClear: () => void;
  /** 差异说明最少字数，由父页面按同一常量传入，避免两处各写一个数字 */
  minReasonLength: number;
  submitting: boolean;
  onConfirm: () => void;
}

const VatConfirmDialog: React.FC<Props> = ({
  open,
  onOpenChange,
  period,
  taxEntityName,
  reconciled,
  reason,
  onReasonChange,
  reasonError,
  onReasonErrorClear,
  minReasonLength,
  submitting,
  onConfirm,
}) => (
  <Dialog
    open={open}
    onOpenChange={(next) => {
      if (!next) onOpenChange(false);
    }}
  >
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>确认申报底稿</DialogTitle>
        <DialogDescription>
          期间 {period}
          {taxEntityName ? ` · ${taxEntityName}` : ''}
          ，确认后底稿进入已确认状态并记录留痕；差异说明必填。
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Label htmlFor="vat-reason">差异说明（至少 {minReasonLength} 个字）</Label>
        <Textarea
          id="vat-reason"
          rows={4}
          value={reason}
          placeholder="例如：本期存在跨期开票，发票在次月确认收入，差异已核对无误"
          onChange={(e) => {
            const value = e.target.value;
            onReasonChange(value);
            /*
             * 用户把说明改到够长时**立即清掉错误提示**，不要等再次提交才消失。
             * 这条清错逻辑**只在本组件里**（`onReasonChange` 的通知方不再重复判断）——
             * 两处都写会出现"两个地方各自决定何时清错"，改一处漏一处。
             */
            if (reasonError && value.trim().length >= minReasonLength) {
              onReasonErrorClear();
            }
          }}
        />
        {reasonError ? <p className="text-xs text-destructive">{reasonError}</p> : null}
        {!reconciled ? (
          <p className="text-xs text-warning">
            当前台账与总账口径不一致，请确认差异原因已核实。
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={submitting}
        >
          取消
        </Button>
        <Button type="button" onClick={() => void onConfirm()} disabled={submitting}>
          {submitting ? '提交中…' : '确认底稿'}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export default VatConfirmDialog;
