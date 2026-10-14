import { Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { asc, eq, like, or, type SQL } from 'drizzle-orm';
import { finAccount } from '@server/database/schema';
import { isSummaryAccountCode } from '@server/common/tax/account-codes';

export interface ResolvedAccount {
  id: string;
  code: string;
  name: string;
  /** 请求的语义编码 */
  requestedCode: string;
  /** 是否因为请求的是汇总科目而下钻到末级 */
  drilledDown: boolean;
}

interface AccountNode {
  id: string;
  code: string;
  name: string;
  status: string | null;
  isLeaf: number;
  parentCode: string | null;
  level: number;
}

/**
 * 会计科目解析：把分录模板里的"语义编码"解析为可做账的末级科目。
 *
 * A-10 要求"只能对末级科目做账"，但分录模板使用准则一级编码（如 6602 管理费用、
 * 1002 银行存款）。本服务在两者之间做桥接：
 *   1. 若请求编码本身是启用中的末级科目 → 直接使用；
 *   2. 若是汇总科目（有子科目 / SUMMARY_ACCOUNT_CODES / level 标记 is_leaf=0）
 *      → 按编码字典序取第一个启用末级后代；
 *   3. 都没有 → 返回 null，由调用方决定报错或入补偿队列。
 */
@Injectable()
export class AccountResolverService {
  private cache = new Map<string, { account: ResolvedAccount | null; at: number }>();
  private static readonly TTL_MS = 60_000;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  /** 清空解析缓存（科目表被修改后调用） */
  invalidate(): void {
    this.cache.clear();
  }

  async resolve(requestedCode: string): Promise<ResolvedAccount | null> {
    const cached = this.cache.get(requestedCode);
    if (cached && Date.now() - cached.at < AccountResolverService.TTL_MS) {
      return cached.account;
    }
    const account = await this.resolveUncached(requestedCode);
    this.cache.set(requestedCode, { account, at: Date.now() });
    return account;
  }

  /** 批量解析，返回 requestedCode → ResolvedAccount 映射（缺失项不在 map 中） */
  async resolveMany(codes: string[]): Promise<Map<string, ResolvedAccount>> {
    const unique = Array.from(new Set(codes.filter((code) => code)));
    const result = new Map<string, ResolvedAccount>();
    const missing: string[] = [];
    for (const code of unique) {
      const hit = this.cache.get(code);
      if (hit && Date.now() - hit.at < AccountResolverService.TTL_MS) {
        if (hit.account) result.set(code, hit.account);
        continue;
      }
      missing.push(code);
    }
    if (missing.length > 0) {
      const nodes = await this.loadNodes(missing);
      const byCode = new Map<string, AccountNode>();
      const children = new Map<string, AccountNode[]>();
      for (const node of nodes) {
        byCode.set(node.code, node);
        if (node.parentCode) {
          const list = children.get(node.parentCode) ?? [];
          list.push(node);
          children.set(node.parentCode, list);
        }
      }
      for (const list of children.values()) {
        list.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      }
      for (const code of missing) {
        const account = this.pick(code, byCode, children);
        this.cache.set(code, { account, at: Date.now() });
        if (account) result.set(code, account);
      }
    }
    return result;
  }

  private async resolveUncached(
    requestedCode: string
  ): Promise<ResolvedAccount | null> {
    const nodes = await this.loadNodes([requestedCode]);
    const byCode = new Map<string, AccountNode>();
    const children = new Map<string, AccountNode[]>();
    for (const node of nodes) {
      byCode.set(node.code, node);
      if (node.parentCode) {
        const list = children.get(node.parentCode) ?? [];
        list.push(node);
        children.set(node.parentCode, list);
      }
    }
    for (const list of children.values()) {
      list.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    }
    return this.pick(requestedCode, byCode, children);
  }

  /**
   * 加载请求编码本身 + 其所有后代（parent_code 递归）。
   * 一级编码最多 4 位，层级上限 6，使用 like 前缀匹配足够且可用索引。
   */
  private async loadNodes(codes: string[]): Promise<AccountNode[]> {
    if (codes.length === 0) return [];
    const conditions: SQL[] = [];
    for (const code of codes) {
      conditions.push(eq(finAccount.code, code));
      conditions.push(like(finAccount.code, `${code}%`));
    }
    const rows = await this.db
      .select({
        id: finAccount.id,
        code: finAccount.code,
        name: finAccount.name,
        status: finAccount.status,
        isLeaf: finAccount.isLeaf,
        parentCode: finAccount.parentCode,
        level: finAccount.level,
      })
      .from(finAccount)
      .where(or(...conditions))
      .orderBy(asc(finAccount.code));
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      status: row.status,
      isLeaf: Number(row.isLeaf ?? 1),
      parentCode: row.parentCode,
      level: Number(row.level ?? 1),
    }));
  }

  private pick(
    requestedCode: string,
    byCode: Map<string, AccountNode>,
    children: Map<string, AccountNode[]>
  ): ResolvedAccount | null {
    const self = byCode.get(requestedCode);
    if (!self) return null;
    const active = (node: AccountNode): boolean =>
      (node.status ?? 'active') === 'active';
    const hasChildren = (children.get(requestedCode)?.length ?? 0) > 0;
    const summary =
      self.isLeaf !== 1 || hasChildren || isSummaryAccountCode(requestedCode);
    if (!summary && active(self)) {
      return {
        id: self.id,
        code: self.code,
        name: self.name,
        requestedCode,
        drilledDown: false,
      };
    }
    // 汇总科目 → 深度优先取第一个启用的末级后代
    const leaf = this.firstLeaf(self.code, children, active);
    if (!leaf) return null;
    return {
      id: leaf.id,
      code: leaf.code,
      name: leaf.name,
      requestedCode,
      drilledDown: leaf.code !== requestedCode,
    };
  }

  private firstLeaf(
    parentCode: string,
    children: Map<string, AccountNode[]>,
    active: (node: AccountNode) => boolean
  ): AccountNode | null {
    for (const child of children.get(parentCode) ?? []) {
      if (!active(child)) continue;
      if (child.isLeaf === 1) return child;
      const deeper = this.firstLeaf(child.code, children, active);
      if (deeper) return deeper;
    }
    return null;
  }
}
