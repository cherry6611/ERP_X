import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import { AccountLifecycleService, DRIZZLE_DATABASE, type PostgresJsDatabase } from '@server/platform';
import {
  mdEmployee,
  sysDepartment,
  sysFeishuSyncConflict,
  sysFeishuSyncState,
  sysUser,
} from '@server/database/schema';
import { FeishuClientService } from '@server/modules/feishu-drive/feishu-client.service';

const OFFBOARD_MS = 7 * 24 * 60 * 60 * 1000;

interface FeishuDepartment {
  department_id?: string;
  open_department_id?: string;
  name?: string;
  parent_department_id?: string;
  order?: string;
  leader_user_id?: string;
  status?: { is_deleted?: boolean };
}

interface FeishuContactUser {
  union_id?: string;
  open_id?: string;
  name?: string;
  email?: string;
  mobile?: string;
  avatar?: { avatar_origin?: string };
  department_ids?: string[];
  status?: { is_frozen?: boolean; is_resigned?: boolean; is_activated?: boolean };
}

@Injectable()
export class FeishuContactService {
  private readonly logger = new Logger(FeishuContactService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly feishu: FeishuClientService,
    private readonly accounts: AccountLifecycleService,
  ) {}

  async fullSync(): Promise<{ departments: number; users: number; conflicts: number }> {
    const departments = await this.syncDepartments();
    const users = await this.syncUsers();
    await this.db.insert(sysFeishuSyncState).values({
      id: 'contact',
      fullSyncedAt: new Date(),
      incrementalSyncedAt: new Date(),
    }).onConflictDoUpdate({
      target: sysFeishuSyncState.id,
      set: { fullSyncedAt: new Date(), incrementalSyncedAt: new Date() },
    });
    return { departments, users: users.users, conflicts: users.conflicts };
  }

  async incrementalSync(): Promise<{ users: number; conflicts: number }> {
    const result = await this.syncUsers();
    await this.db.insert(sysFeishuSyncState).values({
      id: 'contact',
      incrementalSyncedAt: new Date(),
    }).onConflictDoUpdate({
      target: sysFeishuSyncState.id,
      set: { incrementalSyncedAt: new Date() },
    });
    return result;
  }

  async listConflicts(): Promise<Array<{ id: string; unionId: string | null; reason: string; status: string }>> {
    return this.db
      .select({
        id: sysFeishuSyncConflict.id,
        unionId: sysFeishuSyncConflict.unionId,
        reason: sysFeishuSyncConflict.reason,
        status: sysFeishuSyncConflict.status,
      })
      .from(sysFeishuSyncConflict)
      .where(eq(sysFeishuSyncConflict.status, 'open'))
      .limit(200);
  }

  private async syncDepartments(): Promise<number> {
    const items = await this.paged<FeishuDepartment>(
      '/open-apis/contact/v3/departments/0/children',
      { fetch_child: 'true', department_id_type: 'department_id' },
      'items',
    );
    let count = 0;
    for (const item of items) {
      const feishuId = item.department_id || item.open_department_id;
      if (!feishuId || !item.name) continue;
      const existing = await this.db.select({ id: sysDepartment.id }).from(sysDepartment).where(eq(sysDepartment.feishuDepartmentId, feishuId)).limit(1);
      const patch = {
        name: item.name,
        feishuDepartmentId: feishuId,
        feishuParentId: item.parent_department_id ?? null,
        sortOrder: Number(item.order ?? 0) || 0,
        status: item.status?.is_deleted ? 'disabled' : 'active',
        syncedAt: new Date(),
      };
      if (existing[0]) {
        await this.db.update(sysDepartment).set(patch).where(eq(sysDepartment.id, existing[0].id));
      } else {
        await this.db.insert(sysDepartment).values(patch);
      }
      count += 1;
    }
    return count;
  }

  private async syncUsers(): Promise<{ users: number; conflicts: number }> {
    const departments = await this.db.select({ feishuDepartmentId: sysDepartment.feishuDepartmentId }).from(sysDepartment);
    const ids = departments.map((row) => row.feishuDepartmentId).filter((id): id is string => Boolean(id));
    if (!ids.includes('0')) ids.push('0');
    let users = 0;
    let conflicts = 0;
    for (const departmentId of ids) {
      const people = await this.paged<FeishuContactUser>(
        '/open-apis/contact/v3/users/find_by_department',
        { department_id: departmentId, department_id_type: 'department_id' },
        'items',
      );
      for (const person of people) {
        const outcome = await this.upsertUser(person, departmentId);
        users += 1;
        conflicts += outcome;
      }
    }
    await this.applyOffboardBuffer();
    return { users, conflicts };
  }

  private async upsertUser(person: FeishuContactUser, departmentId: string): Promise<number> {
    const unionId = person.union_id;
    const openId = person.open_id;
    if (!unionId || !openId) return 0;
    const resigned = Boolean(person.status?.is_resigned || person.status?.is_frozen);
    const found = await this.db.select().from(sysUser).where(eq(sysUser.feishuUnionId, unionId)).limit(1);
    const dept = await this.db.select({ id: sysDepartment.id, name: sysDepartment.name }).from(sysDepartment).where(eq(sysDepartment.feishuDepartmentId, departmentId)).limit(1);
    const base = {
      feishuOpenId: openId,
      feishuUnionId: unionId,
      email: person.email ?? null,
      mobile: person.mobile ?? null,
      avatarUrl: person.avatar?.avatar_origin ?? null,
      departmentId: dept[0]?.id ?? null,
      departmentName: dept[0]?.name ?? null,
      authType: 'feishu',
      syncedAt: new Date(),
      updatedAt: new Date(),
    };
    let userId = found[0]?.id;
    if (!userId) {
      const [created] = await this.db.insert(sysUser).values({
        ...base,
        username: unionId,
        displayName: person.name || unionId,
        status: 'active',
      }).returning({ id: sysUser.id });
      userId = created.id;
    } else if (!found[0].employeeId) {
      await this.db.update(sysUser).set({ ...base, displayName: person.name || found[0].displayName }).where(eq(sysUser.id, userId));
    } else {
      await this.db.update(sysUser).set(base).where(eq(sysUser.id, userId));
    }
    const conflict = await this.matchEmployee(userId, unionId, person, dept[0]?.name);
    if (resigned) await this.markPendingOffboard(unionId, userId);
    return conflict;
  }

  private async matchEmployee(userId: string, unionId: string, person: FeishuContactUser, departmentName?: string): Promise<number> {
    const byUnion = await this.db.select({ id: mdEmployee.id }).from(mdEmployee).where(eq(mdEmployee.feishuUnionId, unionId)).limit(2);
    if (byUnion.length === 1) {
      await this.bindEmployee(userId, byUnion[0].id, person);
      return 0;
    }
    if (person.email) {
      const byEmail = await this.db.select({ id: mdEmployee.id }).from(mdEmployee).where(eq(mdEmployee.email, person.email)).limit(2);
      if (byEmail.length === 1) {
        await this.bindEmployee(userId, byEmail[0].id, person);
        return 0;
      }
      if (byEmail.length > 1) return this.openConflict(unionId, 'multi_employee', person);
    }
    if (person.mobile) {
      const byMobile = await this.db.select({ id: mdEmployee.id }).from(mdEmployee).where(eq(mdEmployee.phone, person.mobile)).limit(2);
      if (byMobile.length === 1) {
        await this.bindEmployee(userId, byMobile[0].id, person);
        return 0;
      }
      if (byMobile.length > 1) return this.openConflict(unionId, 'multi_employee', person);
    }
    if (person.name && departmentName) {
      const byName = await this.db.select({ id: mdEmployee.id }).from(mdEmployee).where(and(eq(mdEmployee.name, person.name), eq(mdEmployee.orgName, departmentName))).limit(2);
      if (byName.length > 0) return this.openConflict(unionId, 'name_dept', person);
    }
    return 0;
  }

  private async bindEmployee(userId: string, employeeId: string, person: FeishuContactUser): Promise<void> {
    const taken = await this.db.select({ id: sysUser.id }).from(sysUser).where(eq(sysUser.employeeId, employeeId)).limit(1);
    if (taken[0] && taken[0].id !== userId) {
      if (person.union_id) await this.openConflict(person.union_id, 'multi_employee', person);
      return;
    }
    await this.db.update(sysUser).set({ employeeId }).where(eq(sysUser.id, userId));
    await this.db.update(mdEmployee).set({
      email: person.email ?? undefined,
      phone: person.mobile ?? undefined,
      feishuUnionId: person.union_id,
      feishuOpenId: person.open_id,
      avatarUrl: person.avatar?.avatar_origin,
      syncedAt: new Date(),
    }).where(eq(mdEmployee.id, employeeId));
  }

  private async openConflict(unionId: string, reason: string, person: FeishuContactUser): Promise<number> {
    const open = await this.db.select({ id: sysFeishuSyncConflict.id }).from(sysFeishuSyncConflict).where(and(eq(sysFeishuSyncConflict.unionId, unionId), eq(sysFeishuSyncConflict.reason, reason), eq(sysFeishuSyncConflict.status, 'open'))).limit(1);
    if (open[0]) return 0;
    await this.db.insert(sysFeishuSyncConflict).values({
      unionId,
      reason,
      payload: JSON.stringify({ name: person.name ?? null, email: person.email ?? null, mobile: person.mobile ?? null }),
    });
    this.logger.warn(`通讯录匹配需要人工确认 union=${unionId} reason=${reason}`);
    return 1;
  }

  private async markPendingOffboard(unionId: string, userId: string): Promise<void> {
    const open = await this.db.select({ id: sysFeishuSyncConflict.id, createdAt: sysFeishuSyncConflict.createdAt }).from(sysFeishuSyncConflict).where(and(eq(sysFeishuSyncConflict.unionId, unionId), eq(sysFeishuSyncConflict.reason, 'pending_offboard'), eq(sysFeishuSyncConflict.status, 'open'))).limit(1);
    if (!open[0]) {
      await this.db.insert(sysFeishuSyncConflict).values({ unionId, reason: 'pending_offboard', payload: JSON.stringify({ userId }) });
      return;
    }
    if (Date.now() - open[0].createdAt.getTime() < OFFBOARD_MS) return;
    const user = await this.db.select({ employeeId: sysUser.employeeId }).from(sysUser).where(eq(sysUser.id, userId)).limit(1);
    if (user[0]?.employeeId) await this.accounts.disableEmployeeAccount(user[0].employeeId);
    else {
      await this.db.update(sysUser).set({ status: 'disabled' }).where(eq(sysUser.id, userId));
    }
    await this.db.update(sysFeishuSyncConflict).set({ status: 'done' }).where(eq(sysFeishuSyncConflict.id, open[0].id));
  }

  private async applyOffboardBuffer(): Promise<void> {
    const due = new Date(Date.now() - OFFBOARD_MS);
    const rows = await this.db.select().from(sysFeishuSyncConflict).where(and(eq(sysFeishuSyncConflict.reason, 'pending_offboard'), eq(sysFeishuSyncConflict.status, 'open'), lt(sysFeishuSyncConflict.createdAt, due))).limit(100);
    for (const row of rows) {
      if (!row.unionId) continue;
      const users = await this.db.select({ id: sysUser.id, employeeId: sysUser.employeeId }).from(sysUser).where(eq(sysUser.feishuUnionId, row.unionId)).limit(1);
      if (users[0]?.employeeId) await this.accounts.disableEmployeeAccount(users[0].employeeId);
      else if (users[0]) await this.db.update(sysUser).set({ status: 'disabled' }).where(eq(sysUser.id, users[0].id));
      await this.db.update(sysFeishuSyncConflict).set({ status: 'done' }).where(eq(sysFeishuSyncConflict.id, row.id));
    }
  }

  private async paged<T>(path: string, query: Record<string, string>, key: string): Promise<T[]> {
    const all: T[] = [];
    let pageToken = '';
    for (let page = 0; page < 50; page += 1) {
      const data = await this.feishu.request<Record<string, unknown>>('GET', path, {
        query: { ...query, page_size: '50', ...(pageToken ? { page_token: pageToken } : {}) },
      });
      const items = data[key];
      if (Array.isArray(items)) all.push(...(items as T[]));
      const token = typeof data.page_token === 'string' ? data.page_token : '';
      if (!data.has_more || !token) break;
      pageToken = token;
    }
    return all;
  }
}
