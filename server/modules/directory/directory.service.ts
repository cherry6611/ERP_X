import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { hrDepartment, mdEmployee, sysDepartment, sysUser } from '@server/database/schema';
import { DRIZZLE_DATABASE } from '@server/platform/tokens';
import { ilikeEscaped, likeContains } from '@server/common/utils/sql-like';

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

  async searchUsers(
    query: string,
    pageSize: number,
    includePii = false
  ): Promise<UserCard[]> {
    // S4：`%`/`_` 必须转义 + 显式 `ESCAPE`（见 sql-like.ts 的说明）。
    // 原实现把 `%${query}%` 直接交给 ilike：传 `%` 就匹配全表。
    // 关键字为空时 `likeContains` 返回 null —— 此时退化为"不搜索"，
    // 而不是拿 `%%` 匹配全表（那正是原缺陷的形状）。
    const pattern = likeContains(query);
    const accounts = await this.db
      .select()
      .from(sysUser)
      .where(
        pattern
          ? or(
              ilikeEscaped(sysUser.displayName, pattern),
              ilikeEscaped(sysUser.username, pattern)
            )
          : undefined
      )
      .limit(pageSize);
    const employees = await this.db
      .select()
      .from(mdEmployee)
      .where(pattern ? ilikeEscaped(mdEmployee.name, pattern) : undefined)
      .limit(pageSize);
    const cards = [
      ...accounts.map((row) =>
        this.accountCard(row.id, row.displayName, row.email, row.feishuOpenId, includePii)
      ),
      ...employees.map((row) =>
        this.accountCard(
          String(row.platformUserId ?? row.id),
          row.name,
          null,
          null,
          includePii
        )
      ),
    ];
    const seen = new Set<string>();
    return cards.filter((card) => {
      if (seen.has(card.userID)) return false;
      seen.add(card.userID);
      return true;
    });
  }

  async usersByIds(
    ids: string[],
    includePii = false
  ): Promise<Record<string, UserCard>> {
    const map: Record<string, UserCard> = {};
    if (ids.length === 0) return map;
    const uuidIds = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (uuidIds.length > 0) {
      const accounts = await this.db
        .select()
        .from(sysUser)
        .where(
          or(inArray(sysUser.id, uuidIds), inArray(sysUser.feishuOpenId, ids))
        );
      for (const row of accounts) {
        const card = this.accountCard(
          row.id,
          row.displayName,
          row.email,
          row.feishuOpenId,
          includePii
        );
        map[row.id] = card;
        if (row.feishuOpenId) map[row.feishuOpenId] = card;
      }
      const employees = await this.db
        .select()
        .from(mdEmployee)
        .where(inArray(mdEmployee.id, uuidIds));
      for (const row of employees) {
        const bound = row.feishuUnionId || String(row.platformUserId ?? '');
        const card = this.accountCard(
          bound || row.id,
          row.name,
          row.email,
          row.feishuOpenId,
          includePii
        );
        map[row.id] = card;
        if (bound) map[bound] = card;
      }
    } else {
      const accounts = await this.db
        .select()
        .from(sysUser)
        .where(inArray(sysUser.feishuOpenId, ids));
      for (const row of accounts) {
        const card = this.accountCard(
          row.id,
          row.displayName,
          row.email,
          row.feishuOpenId,
          includePii
        );
        map[row.id] = card;
        if (row.feishuOpenId) map[row.feishuOpenId] = card;
      }
    }
    return map;
  }

  async profile(id: string) {
    const map = await this.usersByIds([id], true);
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
    // S4：与 searchUsers 同一修法（转义 + ESCAPE）
    const pattern = likeContains(query);
    const hr = await this.db
      .select()
      .from(hrDepartment)
      .where(pattern ? ilikeEscaped(hrDepartment.name, pattern) : undefined)
      .limit(pageSize);
    const extra = await this.db
      .select()
      .from(sysDepartment)
      .where(pattern ? ilikeEscaped(sysDepartment.name, pattern) : undefined)
      .limit(pageSize);
    return [...hr, ...extra].map((row) => ({
      departmentID: row.id,
      larkDepartmentID: row.id,
      name: { zh_cn: row.name, en_us: row.name },
    }));
  }

  private accountCard(
    id: string,
    name: string,
    email: string | null,
    openId: string | null,
    includePii = false
  ): UserCard {
    return {
      userID: id,
      larkUserID: openId ?? '',
      name: { zh_cn: name, en_us: name },
      userType: '_employee',
      email: includePii ? email : null,
    };
  }
}

export const directorySql = sql;
