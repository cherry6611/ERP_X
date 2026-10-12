import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sysRole, sysRoleMember, sysUser } from '@server/database/schema';
import { DRIZZLE_DATABASE } from './tokens';

export interface ListMembersParams {
  type?: string;
  page?: number;
  pageSize?: number;
  userID?: string;
}

export interface ListMembersResponse {
  members: {
    userList?: Array<{ userID?: string; miaodaUserID?: string; name?: string }>;
  };
  total: number;
  hasMore: boolean;
}

@Injectable()
export class AuthorizationSDK {
  readonly members: { list: (role: string, params?: ListMembersParams) => Promise<ListMembersResponse> };
  readonly roles = {
    list: async () => {
      const rows = await this.db.select().from(sysRole);
      return rows.map((row) => ({ bizID: row.code, name: row.name }));
    },
  };
  readonly search = {
    search: async () => ({ result: {} }),
  };

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {
    this.members = {
      list: (role, params) => this.listMembers(role, params),
    };
  }

  private async listMembers(role: string, params?: ListMembersParams): Promise<ListMembersResponse> {
    const page = params?.page ?? 1;
    const pageSize = params?.pageSize ?? 100;
    const rows = await this.db
      .select({
        userId: sysRoleMember.userId,
        name: sysUser.displayName,
      })
      .from(sysRoleMember)
      .leftJoin(sysUser, sql`${sysUser.id}::text = ${sysRoleMember.userId}`)
      .where(eq(sysRoleMember.roleCode, role));
    const start = (page - 1) * pageSize;
    const slice = rows.slice(start, start + pageSize);
    return {
      members: {
        userList: slice.map((row) => ({
          userID: row.userId,
          miaodaUserID: row.userId,
          name: row.name ?? '',
        })),
      },
      total: rows.length,
      hasMore: start + pageSize < rows.length,
    };
  }
}
