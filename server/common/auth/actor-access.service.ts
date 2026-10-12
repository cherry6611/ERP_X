import { Injectable, Logger } from '@nestjs/common';
import {
  AuthorizationSDK,
  type ListMembersParams,
  type ListMembersResponse,
} from '@server/platform';

const CACHE_MS = 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

interface RoleCache {
  ids: Set<string>;
  at: number;
}

@Injectable()
export class ActorAccessService {
  private readonly logger = new Logger(ActorAccessService.name);
  private readonly cache = new Map<string, RoleCache>();

  constructor(private readonly authzSDK: AuthorizationSDK) {}

  /** 调用者是否具备任一角色。角色不存在或查询失败时视为不具备。 */
  async hasAnyRole(userId: string, roles: string[]): Promise<boolean> {
    if (!userId) return false;
    for (const role of roles) {
      const ids = await this.memberIds(role);
      if (ids.has(userId)) return true;
    }
    return false;
  }

  private async memberIds(roleBizId: string): Promise<Set<string>> {
    const cached = this.cache.get(roleBizId);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.ids;
    const ids = new Set<string>();
    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const query: ListMembersParams = {
          type: 'User',
          page,
          pageSize: PAGE_SIZE,
        };
        const res: ListMembersResponse = await this.authzSDK.members.list(
          roleBizId,
          query
        );
        for (const user of res.members.userList ?? []) {
          const userId: string | undefined = user.userID ?? user.miaodaUserID;
          if (userId) ids.add(userId);
        }
        if (!res.hasMore) break;
      }
    } catch (error: unknown) {
      const message: string =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(`读取角色成员失败 role=${roleBizId} ${message}`);
    }
    this.cache.set(roleBizId, { ids, at: Date.now() });
    return ids;
  }
}
