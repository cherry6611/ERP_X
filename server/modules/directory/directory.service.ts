import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ilike, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { hrDepartment, mdEmployee, sysDepartment, sysUser } from '@server/database/schema';
import { DRIZZLE_DATABASE } from '@server/platform/tokens';

interface UserCard {
  userID: string;
  larkUserID: string;
  name: { zh_cn: string; en_us: string };
  avatar?: { image?: { large?: string } };
  userType: string;
  email?: string | null;
  department?: { departmentID: string; name: { zh_cn: string } };
}

@Injectable()
export class DirectoryService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async searchUsers(query: string, pageSize: number): Promise<UserCard[]> {
    const pattern = `%${query}%`;
    const accounts = await this.db
      .select()
      .from(sysUser)
      .where(or(ilike(sysUser.displayName, pattern), ilike(sysUser.username, pattern)))
      .limit(pageSize);
    const employees = await this.db
      .select()
      .from(mdEmployee)
      .where(ilike(mdEmployee.name, pattern))
      .limit(pageSize);
    const cards = [
      ...accounts.map((row) => this.accountCard(row.id, row.displayName, row.email, row.feishuOpenId)),
      ...employees.map((row) =>
        this.accountCard(String(row.platformUserId ?? row.id), row.name, null, null),
      ),
    ];
    const seen = new Set<string>();
    return cards.filter((card) => {
      if (seen.has(card.userID)) return false;
      seen.add(card.userID);
      return true;
    });
  }

  async usersByIds(ids: string[]): Promise<Record<string, UserCard>> {
    const map: Record<string, UserCard> = {};
    if (ids.length === 0) return map;
    const accounts = await this.db.select().from(sysUser);
    for (const row of accounts) {
      if (ids.includes(row.id) || (row.feishuOpenId && ids.includes(row.feishuOpenId))) {
        const card = this.accountCard(row.id, row.displayName, row.email, row.feishuOpenId);
        map[row.id] = card;
        if (row.feishuOpenId) map[row.feishuOpenId] = card;
      }
    }
    const employees = await this.db.select().from(mdEmployee);
    for (const row of employees) {
      const bound = String(row.platformUserId ?? '');
      if (ids.includes(row.id) || (bound && ids.includes(bound))) {
        const card = this.accountCard(bound || row.id, row.name, null, bound);
        map[row.id] = card;
        if (bound) map[bound] = card;
      }
    }
    return map;
  }

  async profile(id: string) {
    const map = await this.usersByIds([id]);
    const card = map[id];
    return {
      useLarkCard: false as const,
      userProfileInfo: {
        name: card?.name.zh_cn ?? '未知用户',
        email: card?.email ?? undefined,
        userStatus: 2,
        userType: '_employee' as const,
      },
    };
  }

  async searchDepartments(query: string, pageSize: number) {
    const pattern = `%${query}%`;
    const hr = await this.db.select().from(hrDepartment).where(ilike(hrDepartment.name, pattern)).limit(pageSize);
    const extra = await this.db.select().from(sysDepartment).where(ilike(sysDepartment.name, pattern)).limit(pageSize);
    return [...hr, ...extra].map((row) => ({
      departmentID: row.id,
      larkDepartmentID: row.id,
      name: { zh_cn: row.name, en_us: row.name },
    }));
  }

  private accountCard(id: string, name: string, email: string | null, openId: string | null): UserCard {
    return {
      userID: id,
      larkUserID: openId ?? '',
      name: { zh_cn: name, en_us: name },
      userType: '_employee',
      email,
    };
  }
}

export const directorySql = sql;
