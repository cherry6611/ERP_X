import { ApprovalCallbackService } from './approval-callback.service';

describe('ApprovalCallbackService', () => {
  const map = (svc: ApprovalCallbackService, s: string) =>
    (svc as unknown as { mapOutcome(s: string): string | null }).mapOutcome(s);

  function createSvc(overrides?: {
    db?: Partial<{ select: unknown; update: unknown }>;
    hrCore?: { handleLeaveRequestAction: jest.Mock };
    hrPay?: { payrollAction: jest.Mock };
  }) {
    const hrCore = overrides?.hrCore ?? {
      handleLeaveRequestAction: jest.fn().mockResolvedValue({}),
    };
    const hrPay = overrides?.hrPay ?? {
      payrollAction: jest.fn().mockResolvedValue({}),
    };
    const limit = jest.fn();
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const db = {
      select,
      update: jest.fn(),
      ...overrides?.db,
    };
    const svc = new ApprovalCallbackService(
      db as never,
      hrCore as never,
      hrPay as never,
    );
    return { svc, hrCore, hrPay, select, from, where, limit };
  }

  describe('mapOutcome', () => {
    it('maps approved statuses', () => {
      const { svc } = createSvc();
      expect(map(svc, 'APPROVED')).toBe('approved');
      expect(map(svc, 'PASS')).toBe('approved');
    });

    it('maps rejected and canceled', () => {
      const { svc } = createSvc();
      expect(map(svc, 'REJECTED')).toBe('rejected');
      expect(map(svc, 'CANCELED')).toBe('canceled');
    });

    it('ignores unknown', () => {
      const { svc } = createSvc();
      expect(map(svc, 'PENDING')).toBeNull();
    });
  });

  describe('F4X-13 applyLeave / applyPayroll', () => {
    it('批准请假时调用 HrCoreService.handleLeaveRequestAction', async () => {
      const { svc, hrCore, limit } = createSvc();
      limit.mockResolvedValue([{ id: 'leave-1', status: 'pending' }]);
      await (
        svc as unknown as {
          applyLeave(code: string, outcome: string): Promise<void>;
        }
      ).applyLeave('LV001', 'approved');
      expect(hrCore.handleLeaveRequestAction).toHaveBeenCalledWith(
        'leave-1',
        'approve',
      );
    });

    it('批准工资时调用 HrPayService.payrollAction', async () => {
      const { svc, hrPay, limit } = createSvc();
      limit.mockResolvedValue([{ id: 'pay-1', status: 'submitted' }]);
      await (
        svc as unknown as {
          applyPayroll(code: string, outcome: string): Promise<void>;
        }
      ).applyPayroll('SAL001', 'approved');
      expect(hrPay.payrollAction).toHaveBeenCalledWith('pay-1', 'approve');
    });

    it('已批准工资单幂等跳过，不重复调用审批用例', async () => {
      const { svc, hrPay, limit } = createSvc();
      limit.mockResolvedValue([{ id: 'pay-1', status: 'approved' }]);
      await (
        svc as unknown as {
          applyPayroll(code: string, outcome: string): Promise<void>;
        }
      ).applyPayroll('SAL001', 'approved');
      expect(hrPay.payrollAction).not.toHaveBeenCalled();
    });
  });
});
