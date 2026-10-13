import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { erpProject, hrDepartment, mdEmployee } from '@server/database/schema';
import { ActorAccessService } from '@server/common/auth/actor-access.service';
import type { RequestActor } from '@server/common/auth/actor';

interface BoundEmployee {
  id: string;
  name: string;
  departmentName: string | null;
}

@Injectable()
export class ProjectAclService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly actorAccess: ActorAccessService
  ) {}

  /** admin / finance_viewer 看全部；其余仅负责人、创建人、同部门或已有工时的项目 */
  async visibilitySql(actor: RequestActor): Promise<SQL | undefined> {
    const privileged: boolean = await this.actorAccess.hasAnyRole(actor.userId, [
      'admin',
      'finance_viewer',
    ]);
    if (privileged) return undefined;
    const employee: BoundEmployee | null = await this.findEmployee(actor.userId);
    const parts: SQL[] = [
      sql`(${erpProject.createdBy}).user_id = ${actor.userId}`,
    ];
    if (actor.userName) parts.push(eq(erpProject.pm, actor.userName));
    if (employee) {
      parts.push(eq(erpProject.pm, employee.name));
      if (employee.departmentName) {
        parts.push(eq(erpProject.deptName, employee.departmentName));
      }
      parts.push(
        sql`exists (
          select 1 from erp_timesheet t
          where t.project_id = ${erpProject.id}
            and t.employee_id = ${employee.id}
        )`
      );
    }
    return or(...parts);
  }

  async assertVisible(projectId: string, actor: RequestActor): Promise<void> {
    const ok: boolean = await this.canSee(projectId, actor);
    if (!ok) throw new NotFoundException('项目不存在');
  }

  /** 可编辑 = admin，或项目负责人 */
  async assertEditable(projectId: string, actor: RequestActor): Promise<void> {
    const rows = await this.db
      .select({ id: erpProject.id, pm: erpProject.pm })
      .from(erpProject)
      .where(eq(erpProject.id, projectId))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('项目不存在');
    const isAdmin: boolean = await this.actorAccess.hasAnyRole(actor.userId, [
      'admin',
    ]);
    if (isAdmin) return;
    const employee: BoundEmployee | null = await this.findEmployee(actor.userId);
    const ownerName: string = rows[0].pm ?? '';
    const isOwner: boolean =
      ownerName.length > 0 &&
      (ownerName === actor.userName || ownerName === employee?.name);
    if (!isOwner) {
      throw new ForbiddenException('仅项目负责人或管理员可提交变更');
    }
  }

  private async canSee(projectId: string, actor: RequestActor): Promise<boolean> {
    const extra: SQL | undefined = await this.visibilitySql(actor);
    const where: SQL = extra
      ? and(eq(erpProject.id, projectId), extra) ?? eq(erpProject.id, projectId)
      : eq(erpProject.id, projectId);
    const rows = await this.db
      .select({ id: erpProject.id })
      .from(erpProject)
      .where(where)
      .limit(1);
    return rows.length > 0;
  }

  private async findEmployee(userId: string): Promise<BoundEmployee | null> {
    const rows = await this.db
      .select({
        id: mdEmployee.id,
        name: mdEmployee.name,
        departmentName: hrDepartment.name,
      })
      .from(mdEmployee)
      .leftJoin(hrDepartment, eq(mdEmployee.departmentId, hrDepartment.id))
      .where(or(eq(mdEmployee.feishuUnionId, userId), eq(mdEmployee.platformUserId, userId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      departmentName: row.departmentName,
    };
  }
}
