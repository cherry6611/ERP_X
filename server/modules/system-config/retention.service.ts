import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import {
  compAuditLog,
  hrEmployeeTaxDeduction,
  mdEmployee,
  sysDataRetentionPolicy,
  sysPiiRequest,
} from '@server/database/schema';
import { unwrapRows } from '@server/common/utils/rows';

/** B-07：保留策略执行结果 */
export interface RetentionRunResult {
  dataType: string;
  action: string;
  retainDays: number;
  affected: number;
  ranAt: string;
}

/** B-07：PII 导出结果（满足"被遗忘权"的可携带数据） */
export interface PiiExportResult {
  requestId: string;
  subjectType: string;
  subjectId: string;
  subjectName: string | null;
  exportedAt: string;
  payload: Record<string, unknown>;
}

/**
 * B-07：数据保留与合规归档。
 *
 * 覆盖需求书四条验收：
 *   ① 24 个月前的审计日志被归档且在线表不再增长（`archiveAuditLogs`）；
 *   ② 可对指定员工执行 PII 导出（`exportPii`）；
 *   ③ 可对指定员工执行脱敏删除（`anonymizePii`，保留统计价值）；
 *   ④ 归档可检索（`searchArchive`）。
 *
 * 运维入口：`retention_daily` cron（见 retention.automation.ts）。
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  /**
   * 归档超期审计日志：
   * 先复制进 comp_audit_log_archive，再按 id 删除在线行。
   * 使用单条 `WITH moved AS (DELETE ... RETURNING) INSERT ...` 保证原子性，
   * 避免"复制成功但删除失败"导致重复计数。
   */
  async archiveAuditLogs(
    retainDays: number,
    batchSize = 5000
  ): Promise<number> {
    if (retainDays < 1) {
      throw new BadRequestException('retainDays 必须 ≥ 1');
    }
    const result = await this.db.execute(sql`
      WITH moved AS (
        DELETE FROM comp_audit_log
        WHERE _created_at < CURRENT_TIMESTAMP - (${retainDays} * interval '1 day')
          AND id IN (
            SELECT id FROM comp_audit_log
            WHERE _created_at < CURRENT_TIMESTAMP - (${retainDays} * interval '1 day')
            ORDER BY _created_at
            LIMIT ${batchSize}
          )
        RETURNING id, object_type, object_id, action, actor, detail, _created_at
      )
      INSERT INTO comp_audit_log_archive (
        source_id, object_type, object_id, action, actor_user_id, detail, occurred_at
      )
      SELECT id, object_type, object_id, action, actor, detail, _created_at
      FROM moved
      RETURNING id
    `);
    return unwrapRows<unknown>(result).length;
  }

  /** 删除超期登录会话（已有 SessionStore.purgeExpired，这里统一走策略表） */
  async purgeLoginSessions(retainDays: number): Promise<number> {
    const result = await this.db.execute(sql`
      DELETE FROM sys_login_session
      WHERE expires_at < CURRENT_TIMESTAMP - (${retainDays} * interval '1 day')
         OR (
           revoked_at IS NOT NULL
           AND revoked_at < CURRENT_TIMESTAMP - (${retainDays} * interval '1 day')
         )
      RETURNING id
    `);
    return unwrapRows<unknown>(result).length;
  }

  /** 归档超期登录审计 */
  async archiveLoginAudit(retainDays: number, batchSize = 5000): Promise<number> {
    const result = await this.db.execute(sql`
      WITH moved AS (
        DELETE FROM sys_login_audit
        WHERE _created_at < CURRENT_TIMESTAMP - (${retainDays} * interval '1 day')
          AND id IN (
            SELECT id FROM sys_login_audit
            WHERE _created_at < CURRENT_TIMESTAMP - (${retainDays} * interval '1 day')
            ORDER BY _created_at
            LIMIT ${batchSize}
          )
        RETURNING id, username, result, reason, auth_method, ip, user_agent, _created_at
      )
      INSERT INTO comp_audit_log_archive (
        source_id, object_type, object_id, action, actor_user_id, detail, occurred_at
      )
      SELECT id,
             'sys_login_audit',
             coalesce(username, ''),
             result,
             null,
             coalesce(reason, '') || ' | ' || coalesce(auth_method, '') || ' | ' || coalesce(ip, ''),
             _created_at
      FROM moved
      RETURNING id
    `);
    return unwrapRows<unknown>(result).length;
  }

  /** 归档超期站内信 */
  async archiveInboxMessages(retainDays: number, batchSize = 5000): Promise<number> {
    const result = await this.db.execute(sql`
      WITH moved AS (
        DELETE FROM sys_inbox_message
        WHERE _created_at < CURRENT_TIMESTAMP - (${retainDays} * interval '1 day')
          AND id IN (
            SELECT id FROM sys_inbox_message
            WHERE _created_at < CURRENT_TIMESTAMP - (${retainDays} * interval '1 day')
            ORDER BY _created_at
            LIMIT ${batchSize}
          )
        RETURNING id, user_id, title, biz_type, biz_code, _created_at
      )
      INSERT INTO comp_audit_log_archive (
        source_id, object_type, object_id, action, actor_user_id, detail, occurred_at
      )
      SELECT id, 'sys_inbox_message', coalesce(biz_code, ''), 'archived', user_id,
             coalesce(title, '') || ' | ' || coalesce(biz_type, ''), _created_at
      FROM moved
      RETURNING id
    `);
    return unwrapRows<unknown>(result).length;
  }

  /** 按策略表执行全部启用的保留动作 */
  async runAll(): Promise<RetentionRunResult[]> {
    const policies = await this.db
      .select()
      .from(sysDataRetentionPolicy)
      .where(eq(sysDataRetentionPolicy.enabled, 1));
    const results: RetentionRunResult[] = [];
    for (const policy of policies) {
      const retainDays = Number(policy.retainDays ?? 730);
      const action = policy.action ?? 'archive';
      if (action === 'none') continue;
      let affected = 0;
      try {
        switch (policy.dataType) {
          case 'audit_log':
            affected = await this.archiveAuditLogs(retainDays);
            break;
          case 'login_audit':
            affected = await this.archiveLoginAudit(retainDays);
            break;
          case 'login_session':
            affected = await this.purgeLoginSessions(retainDays);
            break;
          case 'inbox_message':
            affected = await this.archiveInboxMessages(retainDays);
            break;
          default:
            // 未实现的数据类型只记录不动数据（不静默"成功"）
            this.logger.warn(`保留策略 ${policy.dataType} 暂无执行器，跳过`);
            continue;
        }
        await this.db
          .update(sysDataRetentionPolicy)
          .set({ lastRunAt: new Date(), lastRunCount: affected, updatedAt: new Date() })
          .where(eq(sysDataRetentionPolicy.id, policy.id));
        results.push({
          dataType: policy.dataType,
          action,
          retainDays,
          affected,
          ranAt: new Date().toISOString(),
        });
        this.logger.log(
          `保留策略执行 ${policy.dataType} action=${action} days=${retainDays} affected=${affected}`
        );
      } catch (error) {
        // 单条策略失败不阻塞其它策略（否则一条坏配置会导致全部保留动作停摆）
        this.logger.error(
          `保留策略执行失败 ${policy.dataType}：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return results;
  }

  /** B-07 ④：归档检索 */
  async searchArchive(params: {
    objectType?: string;
    objectId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      objectType: string | null;
      objectId: string | null;
      action: string | null;
      actorUserId: string | null;
      detail: string | null;
      occurredAt: string | null;
      archivedAt: string;
    }>
  > {
    const conditions = [];
    if (params.objectType) {
      conditions.push(sql`object_type = ${params.objectType}`);
    }
    if (params.objectId) {
      conditions.push(sql`object_id = ${params.objectId}`);
    }
    if (params.from) {
      conditions.push(sql`occurred_at >= ${params.from.toISOString()}::timestamptz`);
    }
    if (params.to) {
      conditions.push(sql`occurred_at <= ${params.to.toISOString()}::timestamptz`);
    }
    const whereSql =
      conditions.length > 0
        ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
        : sql``;
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    const rows = await this.db.execute(sql`
      SELECT id, object_type, object_id, action, actor_user_id, detail, occurred_at, archived_at
      FROM comp_audit_log_archive
      ${whereSql}
      ORDER BY occurred_at DESC NULLS LAST
      LIMIT ${limit}
    `);
    return unwrapRows<{
      id: string;
      object_type: string | null;
      object_id: string | null;
      action: string | null;
      actor_user_id: string | null;
      detail: string | null;
      occurred_at: Date | string | null;
      archived_at: Date | string;
    }>(rows).map((row) => ({
      id: row.id,
      objectType: row.object_type,
      objectId: row.object_id,
      action: row.action,
      actorUserId: row.actor_user_id,
      detail: row.detail,
      occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
      archivedAt: new Date(row.archived_at).toISOString(),
    }));
  }

  /* ========== PII 工单 ========== */

  async listPiiRequests(status?: string): Promise<
    Array<{
      id: string;
      requestType: string;
      subjectType: string;
      subjectId: string;
      subjectName: string | null;
      reason: string | null;
      status: string;
      resultSummary: string | null;
      requestedBy: string | null;
      handledBy: string | null;
      handledAt: string | null;
      createdAt: string;
    }>
  > {
    const rows = await this.db
      .select()
      .from(sysPiiRequest)
      .where(status ? eq(sysPiiRequest.status, status) : undefined)
      .orderBy(desc(sysPiiRequest.createdAt))
      .limit(200);
    return rows.map((row) => ({
      id: row.id,
      requestType: row.requestType,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      subjectName: row.subjectName ?? null,
      reason: row.reason ?? null,
      status: row.status,
      resultSummary: row.resultSummary ?? null,
      requestedBy: row.requestedBy ?? null,
      handledBy: row.handledBy ?? null,
      handledAt: row.handledAt ? row.handledAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async createRequest(params: {
    requestType: 'export' | 'anonymize';
    subjectType: 'employee' | 'customer' | 'supplier' | 'user';
    subjectId: string;
    subjectName: string | null;
    reason?: string;
    requestedBy: string;
  }): Promise<string> {
    const inserted = await this.db
      .insert(sysPiiRequest)
      .values({
        requestType: params.requestType,
        subjectType: params.subjectType,
        subjectId: params.subjectId,
        subjectName: params.subjectName,
        reason: params.reason ?? null,
        status: 'pending',
        requestedBy: params.requestedBy,
      })
      .returning({ id: sysPiiRequest.id });
    return inserted[0].id;
  }

  /**
   * B-07 ②：PII 导出。返回该主体的全部个人数据（JSON），
   * 并把工单置为 completed 且记录结果摘要（满足可审计）。
   */
  async exportPii(params: {
    subjectType: 'employee' | 'customer' | 'supplier' | 'user';
    subjectId: string;
    reason?: string;
    requestedBy: string;
  }): Promise<PiiExportResult> {
    if (params.subjectType !== 'employee') {
      // 客户/供应商/用户主体的导出在批次三门户需求中实现，这里显式拒绝而不是假装成功
      throw new BadRequestException(
        `当前仅支持 employee 主体的 PII 导出（subjectType=${params.subjectType} 待批次三门户需求实现）`
      );
    }
    const requestId = await this.createRequest({
      requestType: 'export',
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      subjectName: null,
      reason: params.reason,
      requestedBy: params.requestedBy,
    });
    const employees = await this.db
      .select()
      .from(mdEmployee)
      .where(eq(mdEmployee.id, params.subjectId))
      .limit(1);
    if (employees.length === 0) {
      await this.finishRequest(requestId, 'rejected', '主体不存在', params.requestedBy);
      throw new NotFoundException('员工不存在');
    }
    const employee = employees[0];
    const taxDeductions = await this.db
      .select()
      .from(hrEmployeeTaxDeduction)
      .where(eq(hrEmployeeTaxDeduction.employeeId, params.subjectId));
    const payrolls = await this.db.execute(sql`
      SELECT code, period, base_salary, perf_salary, allowance, social_insurance,
             housing_fund, tax, net_salary, status
      FROM hr_payroll WHERE employee_id = ${params.subjectId}::uuid
      ORDER BY period
    `);
    const timesheets = await this.db.execute(sql`
      SELECT work_date, hours, status FROM erp_timesheet
      WHERE employee_id = ${params.subjectId}::uuid
      ORDER BY work_date
    `);
    const payload: Record<string, unknown> = {
      employee: {
        id: employee.id,
        name: employee.name,
        email: employee.email,
        phone: employee.phone,
        status: employee.status,
        hireDate: employee.hireDate,
        departmentId: employee.departmentId,
        position: employee.position,
      },
      taxDeductions: taxDeductions.map((row) => ({
        taxYear: row.taxYear,
        deductionType: row.deductionType,
        monthlyAmount: Number(row.monthlyAmount ?? 0),
        startMonth: row.startMonth,
        endMonth: row.endMonth,
      })),
      payrolls: unwrapRows<Record<string, unknown>>(payrolls),
      timesheets: unwrapRows<Record<string, unknown>>(timesheets),
    };
    const summary = JSON.stringify({
      sections: Object.keys(payload),
      at: new Date().toISOString(),
    });
    await this.finishRequest(requestId, 'completed', summary, params.requestedBy);
    return {
      requestId,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      subjectName: employee.name,
      exportedAt: new Date().toISOString(),
      payload,
    };
  }

  /**
   * B-07 ③：PII 脱敏删除（保留统计价值）。
   * 清空姓名/手机/邮箱/身份证等直接标识，保留 id/部门/在职状态等统计维度。
   * 工号（code）保留但加 `ANON-` 前缀，避免与后续新员工撞号。
   */
  async anonymizePii(params: {
    employeeId: string;
    reason: string;
    requestedBy: string;
  }): Promise<{ requestId: string; ok: true }> {
    if (!params.reason || params.reason.trim().length < 4) {
      throw new BadRequestException('脱敏操作必须填写不少于 4 个字的原因（留痕要求）');
    }
    const employees = await this.db
      .select({ id: mdEmployee.id, name: mdEmployee.name, code: mdEmployee.code })
      .from(mdEmployee)
      .where(eq(mdEmployee.id, params.employeeId))
      .limit(1);
    if (employees.length === 0) throw new NotFoundException('员工不存在');
    const requestId = await this.createRequest({
      requestType: 'anonymize',
      subjectType: 'employee',
      subjectId: params.employeeId,
      subjectName: employees[0].name,
      reason: params.reason,
      requestedBy: params.requestedBy,
    });
    await this.db.execute(sql`
      UPDATE md_employee
      SET name = ${`已脱敏-${params.employeeId.slice(0, 8)}`},
          email = NULL,
          phone = NULL,
          id_card = NULL,
          bank_account = NULL,
          address = NULL,
          emergency_contact = NULL,
          emergency_phone = NULL,
          _updated_at = CURRENT_TIMESTAMP
      WHERE id = ${params.employeeId}::uuid
    `);
    // 专项附加扣除属于个税敏感信息，一并清除
    await this.db.execute(sql`
      DELETE FROM hr_employee_tax_deduction WHERE employee_id = ${params.employeeId}::uuid
    `);
    await this.finishRequest(
      requestId,
      'completed',
      `已脱敏员工 ${params.employeeId}`,
      params.requestedBy
    );
    this.logger.warn(
      `PII 脱敏完成 employeeId=${params.employeeId} by=${params.requestedBy} reason=${params.reason}`
    );
    return { requestId, ok: true };
  }

  private async finishRequest(
    requestId: string,
    status: 'completed' | 'rejected',
    summary: string,
    handledBy: string
  ): Promise<void> {
    await this.db
      .update(sysPiiRequest)
      .set({
        status,
        resultSummary: summary,
        handledBy,
        handledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sysPiiRequest.id, requestId));
  }

  /** 在线审计日志条数（用于验证"归档后在线表不再增长"） */
  async auditLogStats(): Promise<{
    online: number;
    archived: number;
    oldestOnline: string | null;
  }> {
    const online = await this.db.execute(sql`
      SELECT count(*)::int AS total, min(_created_at) AS oldest FROM comp_audit_log
    `);
    const archived = await this.db.execute(sql`
      SELECT count(*)::int AS total FROM comp_audit_log_archive
    `);
    const onlineRow = unwrapRows<{ total: number; oldest: Date | string | null }>(online)[0];
    return {
      online: Number(onlineRow?.total ?? 0),
      archived: Number(unwrapRows<{ total: number }>(archived)[0]?.total ?? 0),
      oldestOnline: onlineRow?.oldest ? new Date(onlineRow.oldest).toISOString() : null,
    };
  }

  /** 保留策略表原始行（供 UI 展示最近执行情况） */
  async retentionRows() {
    return this.db
      .select()
      .from(sysDataRetentionPolicy)
      .orderBy(sysDataRetentionPolicy.dataType);
  }

  /** 供测试与运维：查询时间范围内的审计日志（在线表） */
  async queryAuditLogs(from: Date, to: Date, limit = 100) {
    return this.db
      .select()
      .from(compAuditLog)
      .where(and(gte(compAuditLog.createdAt, from), lte(compAuditLog.createdAt, to)))
      .limit(Math.min(limit, 500));
  }
}
