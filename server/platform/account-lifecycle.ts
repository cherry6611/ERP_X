import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { sysRoleMember, sysUser } from '@server/database/schema';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from './tokens';
import { SessionStore } from './session-store';

@Injectable()
export class AccountLifecycleService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly sessions: SessionStore,
  ) {}

  async disableEmployeeAccount(employeeId: string): Promise<number> {
    const users = await this.db
      .select({ id: sysUser.id })
      .from(sysUser)
      .where(eq(sysUser.employeeId, employeeId));
    for (const user of users) {
      await this.db
        .update(sysUser)
        .set({ status: 'disabled', updatedAt: new Date() })
        .where(eq(sysUser.id, user.id));
      await this.db.delete(sysRoleMember).where(eq(sysRoleMember.userId, user.id));
      await this.sessions.revokeUser(user.id);
    }
    return users.length;
  }
}
