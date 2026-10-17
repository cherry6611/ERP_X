import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import {
  erpDeliverable,
  erpProject,
  erpProjectChange,
  erpProjectMilestone,
  erpProjectMinutes,
  hrDepartment,
  mdEmployee,
} from '@server/database/schema';
import { ActorAccessService } from '@server/common/auth/actor-access.service';
import {
  DataScopeService,
  type ResolvedScope,
} from '@server/common/auth/data-scope.service';
import type { RequestActor } from '@server/common/auth/actor';

interface BoundEmployee {
  id: string;
  name: string;
  departmentName: string | null;
}

@Injectable()
export class ProjectAclService {
  private readonly logger = new Logger(ProjectAclService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly actorAccess: ActorAccessService,
    private readonly dataScope: DataScopeService
  ) {}

  /**
   * B-02：项目行级可见范围。
   *
   * 优先使用 `sys_data_scope` 的 `project` 配置（若存在）：
   *   - `self`           → `erp_project.pm_user_id = 当前用户`
   *   - `dept`/`dept_and_child` → `erp_project.dept_name ∈ 本部门(及下级) 名称`
   *   - `custom`         → `erp_project.id ∈ custom_ids`
   * 未配置（`from === 'default'`）时回退到本服务既有的可见性规则，
   * 保证"未配置不改行为、配置后才收紧"（需求书 B-02 要求复用既有 ProjectAclService）。
   */
  private async scopeCondition(
    actor: RequestActor
  ): Promise<SQL | undefined> {
    const resolved: ResolvedScope = await this.dataScope.resolveScope(
      actor.roles ?? [],
      'project'
    );
    if (resolved.from !== 'config') return undefined;
    return this.dataScope.conditionFor(
      'project',
      actor,
      {
        primary: erpProject.id,
        self: erpProject.pmUserId,
        dept: erpProject.deptName,
      },
      { departmentValueKind: 'name', resolved }
    );
  }

  /** admin / finance_viewer 看全部；其余按 data_scope 配置或既有负责人/同部门规则 */
  async visibilitySql(actor: RequestActor): Promise<SQL | undefined> {
    const privileged: boolean = await this.actorAccess.hasAnyRole(actor.userId, [
      'admin',
      'finance_viewer',
    ]);
    if (privileged) return undefined;
    const scoped: SQL | undefined = await this.scopeCondition(actor);
    if (scoped) return scoped;
    const employee: BoundEmployee | null = await this.findEmployee(actor.userId);
    // L15：不再按 displayName 裸匹配 pm（同名误关联），仅通过已绑定员工档案关联
    const parts: SQL[] = [
      sql`(${erpProject.createdBy}).user_id = ${actor.userId}`,
    ];
    // F7：可见性优先 pmUserId，姓名仅作未回填时的兼容
    parts.push(eq(erpProject.pmUserId, actor.userId));
    if (employee) {
      parts.push(
        and(
          sql`(${erpProject.pmUserId} IS NULL OR ${erpProject.pmUserId} = '')`,
          eq(erpProject.pm, employee.name),
        )!,
      );
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

  /**
   * 当前 actor 可见的项目 id 集合；`undefined` 表示不受限（admin/finance）。
   *
   * 成本/收入表只有 project_id，没有 dept/pm 列；把 ProjectAcl 的可见性
   * 翻译成 id 集合，查询侧直接 `inArray(table.projectId, ids)` 即可，
   * 不必为了过滤去 join erp_project。空数组表示 fail-closed（无可见项目）。
   */
  async visibleProjectIds(actor: RequestActor): Promise<string[] | undefined> {
    const privileged: boolean = await this.actorAccess.hasAnyRole(actor.userId, [
      'admin',
      'finance_viewer',
    ]);
    if (privileged) return undefined;
    const where = await this.visibilitySql(actor);
    if (!where) return undefined;
    const rows = await this.db
      .select({ id: erpProject.id })
      .from(erpProject)
      .where(where);
    return rows.map((row) => row.id);
  }

  /**
   * B-02 验收标准③：越权直连接口返回 403（区分"不存在"的 404，便于排障），
   * 并且**记 warn 日志**（需求细化④"审计：越权访问尝试记 warn"）。
   */
  async assertVisible(projectId: string, actor: RequestActor): Promise<void> {
    const exists = await this.db
      .select({ id: erpProject.id })
      .from(erpProject)
      .where(eq(erpProject.id, projectId))
      .limit(1);
    if (exists.length === 0) throw new NotFoundException('项目不存在');
    const visible = await this.canSee(projectId, actor);
    if (visible) return;
    const resolved: ResolvedScope = await this.dataScope.resolveScope(
      actor.roles ?? [],
      'project'
    );
    this.logger.warn(
      `越权访问项目被拦截：project=${projectId} user=${actor.userId} ` +
        `role=${resolved.roleCode ?? '-'} scope=${resolved.from === 'config' ? resolved.scope : 'project_acl'}`,
    );
    throw new ForbiddenException('没有访问该项目的数据权限');
  }

  /** 可编辑 = admin，或项目负责人 */
  async assertEditable(projectId: string, actor: RequestActor): Promise<void> {
    const rows = await this.db
      .select({
        id: erpProject.id,
        pm: erpProject.pm,
        pmUserId: erpProject.pmUserId,
      })
      .from(erpProject)
      .where(eq(erpProject.id, projectId))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('项目不存在');
    const isAdmin: boolean = await this.actorAccess.hasAnyRole(actor.userId, [
      'admin',
    ]);
    if (isAdmin) return;
    const pmUserId: string = rows[0].pmUserId ?? '';
    if (pmUserId.length > 0) {
      if (pmUserId !== actor.userId) {
        throw new ForbiddenException('仅项目负责人或管理员可修改项目');
      }
      return;
    }
    const employee: BoundEmployee | null = await this.findEmployee(actor.userId);
    const ownerName: string = rows[0].pm ?? '';
    const isOwner: boolean =
      ownerName.length > 0 &&
      !!employee &&
      ownerName === employee.name;
    if (!isOwner) {
      throw new ForbiddenException('仅项目负责人或管理员可修改项目');
    }
  }

  /** 由交付物 id 反查项目，再按项目负责人校验（写接口不能只看"有 projects_write"）。 */
  async assertEditableByDeliverable(
    deliverableId: string,
    actor: RequestActor,
  ): Promise<void> {
    const rows = await this.db
      .select({ projectId: erpDeliverable.projectId })
      .from(erpDeliverable)
      .where(eq(erpDeliverable.id, deliverableId))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('交付物不存在');
    const projectId = rows[0].projectId;
    if (!projectId) throw new ForbiddenException('交付物未关联项目，无法校验项目权限');
    await this.assertEditable(projectId, actor);
  }

  /** 由里程碑 id 反查项目。 */
  async assertEditableByMilestone(
    milestoneId: string,
    actor: RequestActor,
  ): Promise<void> {
    const rows = await this.db
      .select({ projectId: erpProjectMilestone.projectId })
      .from(erpProjectMilestone)
      .where(eq(erpProjectMilestone.id, milestoneId))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('里程碑不存在');
    const projectId = rows[0].projectId;
    if (!projectId) throw new ForbiddenException('里程碑未关联项目，无法校验项目权限');
    await this.assertEditable(projectId, actor);
  }

  /** 由项目变更 id 反查项目。 */
  async assertEditableByChange(
    changeId: string,
    actor: RequestActor,
  ): Promise<void> {
    const rows = await this.db
      .select({ projectId: erpProjectChange.projectId })
      .from(erpProjectChange)
      .where(eq(erpProjectChange.id, changeId))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('项目变更不存在');
    const projectId = rows[0].projectId;
    if (!projectId) throw new ForbiddenException('变更未关联项目，无法校验项目权限');
    await this.assertEditable(projectId, actor);
  }

  /** 由周报/纪要 id 反查项目。 */
  async assertEditableByMinutes(
    minutesId: string,
    actor: RequestActor,
  ): Promise<void> {
    const rows = await this.db
      .select({ projectId: erpProjectMinutes.projectId })
      .from(erpProjectMinutes)
      .where(eq(erpProjectMinutes.id, minutesId))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('纪要不存在');
    const projectId = rows[0].projectId;
    if (!projectId) throw new ForbiddenException('纪要未关联项目，无法校验项目权限');
    await this.assertEditable(projectId, actor);
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
