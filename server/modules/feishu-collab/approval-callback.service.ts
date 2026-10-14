import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import {
  compFeishuApproval,
  crmQuotation,
  finExpenseClaim,
  hrLeaveRequest,
  hrPayroll,
  purRequest,
} from '@server/database/schema';
import { HrCoreService } from '@server/modules/hr/hr-core.service';
import { HrPayService } from '@server/modules/hr/hr-pay.service';

type ApprovalOutcome = 'approved' | 'rejected' | 'canceled';

/** 飞书审批事件 → ERP 单据状态回写（幂等：按 instance_code） */
@Injectable()
export class ApprovalCallbackService {
  private readonly logger = new Logger(ApprovalCallbackService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly hrCore: HrCoreService,
    private readonly hrPay: HrPayService,
  ) {}

  async handleEvent(payload: Record<string, unknown>): Promise<void> {
    const event = (payload.event ?? payload) as Record<string, unknown>;
    const instanceCode =
      (event.instance_code as string | undefined) ??
      (event.instanceCode as string | undefined) ??
      '';
    if (!instanceCode) return;

    const statusRaw = String(
      event.status ?? event.instance_status ?? event.approval_status ?? '',
    ).toUpperCase();
    const outcome = this.mapOutcome(statusRaw);
    if (!outcome) {
      this.logger.debug(`忽略未识别审批状态 instance=${instanceCode} status=${statusRaw}`);
      return;
    }

    const rows = await this.db
      .select()
      .from(compFeishuApproval)
      .where(eq(compFeishuApproval.instanceCode, instanceCode))
      .limit(1);
    if (rows.length === 0) {
      this.logger.warn(`无本地审批映射 instance=${instanceCode}`);
      return;
    }
    const row = rows[0];
    const prev = row.status ?? 'pending';
    // 已终态（approved/rejected）则幂等返回；canceled/pending 可继续处理
    if (prev === outcome) return;
    if (prev === 'approved' || prev === 'rejected') return;

    await this.applyBiz(row.bizType, row.bizCode, outcome);
    await this.db
      .update(compFeishuApproval)
      .set({ status: outcome })
      .where(eq(compFeishuApproval.id, row.id));
    this.logger.log(
      `审批回写 ${row.bizType}/${row.bizCode} → ${outcome} (instance=${instanceCode})`,
    );
  }

  private mapOutcome(status: string): ApprovalOutcome | null {
    if (['APPROVED', 'APPROVE', 'PASS', 'DONE'].includes(status)) return 'approved';
    if (['REJECTED', 'REJECT', 'REFUSED'].includes(status)) return 'rejected';
    if (['CANCELED', 'CANCELLED', 'DELETED', 'REVERTED'].includes(status)) {
      return 'canceled';
    }
    return null;
  }

  private async applyBiz(
    bizType: string,
    bizCode: string,
    outcome: ApprovalOutcome,
  ): Promise<void> {
    const type = bizType.toLowerCase();
    if (type === 'leave') {
      await this.applyLeave(bizCode, outcome);
      return;
    }
    if (type === 'expense') {
      await this.applyExpense(bizCode, outcome);
      return;
    }
    if (type === 'payroll') {
      await this.applyPayroll(bizCode, outcome);
      return;
    }
    if (type === 'quotation') {
      await this.applyQuotation(bizCode, outcome);
      return;
    }
    if (type === 'purchase') {
      await this.applyPurchase(bizCode, outcome);
      return;
    }
    this.logger.warn(`未实现的审批业务类型 bizType=${bizType}`);
  }

  /**
   * F4X-13：请假审批走 HrCoreService（含余额扣减与 F4X-21 行锁校验），
   * 禁止只改 status 而跳过 usedDays。
   */
  private async applyLeave(code: string, outcome: ApprovalOutcome): Promise<void> {
    if (outcome === 'canceled') {
      // 飞书撤销：仅当仍为 pending 时保持可重新发起，不做余额变更
      await this.db
        .update(hrLeaveRequest)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(
          and(eq(hrLeaveRequest.code, code), eq(hrLeaveRequest.status, 'pending')),
        );
      return;
    }
    const rows = await this.db
      .select({ id: hrLeaveRequest.id, status: hrLeaveRequest.status })
      .from(hrLeaveRequest)
      .where(eq(hrLeaveRequest.code, code))
      .limit(1);
    if (rows.length === 0) {
      this.logger.warn(`请假单不存在 code=${code}，跳过飞书回写`);
      return;
    }
    const { id, status } = rows[0];
    if (outcome === 'approved') {
      if (status === 'approved') return;
      if (status !== 'pending') {
        this.logger.warn(`请假单 ${code} 状态=${status}，跳过批准回写`);
        return;
      }
      await this.hrCore.handleLeaveRequestAction(id, 'approve');
      return;
    }
    if (status === 'rejected') return;
    if (status !== 'pending') {
      this.logger.warn(`请假单 ${code} 状态=${status}，跳过驳回回写`);
      return;
    }
    await this.hrCore.handleLeaveRequestAction(id, 'reject');
  }

  private async applyExpense(code: string, outcome: ApprovalOutcome): Promise<void> {
    const status =
      outcome === 'approved' ? 'approved' : outcome === 'rejected' ? 'rejected' : 'pending';
    await this.db
      .update(finExpenseClaim)
      .set({ status, updatedAt: new Date() })
      .where(
        and(eq(finExpenseClaim.code, code), eq(finExpenseClaim.status, 'pending')),
      );
  }

  /**
   * F4X-13：工资审批走 HrPayService.payrollAction（含分摊/成本/红冲预提/凭证），
   * 禁止只改 status 导致「已批准但无凭证」。
   */
  private async applyPayroll(code: string, outcome: ApprovalOutcome): Promise<void> {
    if (outcome === 'canceled') {
      this.logger.debug(`工资单 ${code} 飞书审批撤销，不改本地状态`);
      return;
    }
    const rows = await this.db
      .select({ id: hrPayroll.id, status: hrPayroll.status })
      .from(hrPayroll)
      .where(eq(hrPayroll.code, code))
      .limit(1);
    if (rows.length === 0) {
      this.logger.warn(`工资单不存在 code=${code}，跳过飞书回写`);
      return;
    }
    const { id, status } = rows[0];
    if (outcome === 'approved') {
      if (status === 'approved') return;
      if (status !== 'submitted') {
        this.logger.warn(`工资单 ${code} 状态=${status}，跳过批准回写`);
        return;
      }
      await this.hrPay.payrollAction(id, 'approve');
      return;
    }
    if (status === 'rejected') return;
    if (status !== 'submitted') {
      this.logger.warn(`工资单 ${code} 状态=${status}，跳过驳回回写`);
      return;
    }
    await this.hrPay.payrollAction(id, 'reject');
  }

  private async applyQuotation(code: string, outcome: ApprovalOutcome): Promise<void> {
    if (outcome === 'approved') {
      await this.db
        .update(crmQuotation)
        .set({ status: 'approved', updatedAt: new Date() })
        .where(
          and(
            eq(crmQuotation.code, code),
            eq(crmQuotation.status, 'pending_approval'),
          ),
        );
      return;
    }
    if (outcome === 'rejected' || outcome === 'canceled') {
      await this.db
        .update(crmQuotation)
        .set({ status: 'draft', updatedAt: new Date() })
        .where(
          and(
            eq(crmQuotation.code, code),
            eq(crmQuotation.status, 'pending_approval'),
          ),
        );
    }
  }

  private async applyPurchase(code: string, outcome: ApprovalOutcome): Promise<void> {
    const status =
      outcome === 'approved' ? 'approved' : outcome === 'rejected' ? 'rejected' : 'pending';
    await this.db
      .update(purRequest)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(purRequest.code, code), eq(purRequest.status, 'pending')));
  }
}
