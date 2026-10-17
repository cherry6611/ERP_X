import {
  allowsRequest,
  fallbackCapabilityFor,
  httpMethodAccess,
} from './guards';
import { ROUTE_CAPABILITY_RULES } from '@server/common/auth/route-capability';
import { hasWriteCapability } from '@shared/rbac';

describe('allowsRequest', () => {
  it('lets public routes through', () => {
    expect(allowsRequest({ isPublic: true, needLogin: true })).toBe('ok');
  });

  it('requires a user when login is marked', () => {
    expect(allowsRequest({ isPublic: false, needLogin: true })).toBe('unauthorized');
  });

  it('forbids a user missing the role', () => {
    expect(
      allowsRequest({
        isPublic: false,
        needLogin: true,
        userId: 'u',
        requiredRoles: ['admin'],
        userRoles: ['hr_manager'],
      }),
    ).toBe('forbidden');
  });

  it('allows a matching role', () => {
    expect(
      allowsRequest({
        isPublic: false,
        needLogin: true,
        userId: 'u',
        requiredRoles: ['admin', 'finance_viewer'],
        userRoles: ['finance_viewer'],
      }),
    ).toBe('ok');
  });
});

/**
 * S1：**权限守卫不得 fail-open**（回归锁）。
 *
 * ## 为什么需要这组测试
 *
 * `RolesGuard` 原先在"方法级与类级都没有权限注解"时**直接放行** —— 因为
 * `allowsRequest` 在 `requiredRoles` 与 `requiredCapability` 都为空时返回 `'ok'`。
 * 而 `route-capability.ts` 精心维护的 34 条"路由前缀 → 能力码"规则，
 * 其 `resolveCapability()` 在全仓**零调用方**。于是兜底机制形同不存在：
 * 新增一个敏感接口而忘记加注解 → 守卫放行、CI 全绿、评审无感。
 *
 * 这类缺陷不会报错、不会 500，只能靠"把判定逻辑当纯函数逐个断言"来钉死。
 * 因此本测试直接调用 `fallbackCapabilityFor`（守卫内部的真实判定），
 * 而不是复述一份可能与代码脱节的清单。
 */
describe('S1 权限守卫兜底（不得 fail-open）', () => {
  it('已有注解时不兜底（返回 null，交由注解判定）', () => {
    expect(
      fallbackCapabilityFor({
        controllerPath: '/api/finance',
        httpMethod: 'POST',
        hasAnnotation: true,
        hasExplicitRoles: false,
        userId: 'u1',
      })
    ).toBeNull();
  });

  it('已有 @CanRole 时不兜底（返回 null）', () => {
    expect(
      fallbackCapabilityFor({
        controllerPath: '/api/finance',
        httpMethod: 'POST',
        hasAnnotation: false,
        hasExplicitRoles: true,
        userId: 'u1',
      })
    ).toBeNull();
  });

  it('未登录时不兜底（登录语义由 LoginGuard 负责，避免登录页 403）', () => {
    expect(
      fallbackCapabilityFor({
        controllerPath: '/api/finance',
        httpMethod: 'GET',
        hasAnnotation: false,
        hasExplicitRoles: false,
        userId: undefined,
      })
    ).toBeNull();
  });

  it('无注解 + 已登录 → 解析出路由表中登记的能力码', () => {
    // 这四条正是审计 §6.2.1 列出的"无能力注解但合理"的端点：
    // 兜底后它们各自落到与人工核验一致的能力码上，行为不变。
    expect(
      fallbackCapabilityFor({
        controllerPath: '/api/notifications',
        httpMethod: 'POST',
        hasAnnotation: false,
        hasExplicitRoles: false,
        userId: 'u1',
      })
    ).toEqual({ capability: 'dashboard', access: 'rw' });
    expect(
      fallbackCapabilityFor({
        controllerPath: '/api/attachments',
        httpMethod: 'DELETE',
        hasAnnotation: false,
        hasExplicitRoles: false,
        userId: 'u1',
      })
    ).toEqual({ capability: 'dashboard', access: 'rw' });
    expect(
      fallbackCapabilityFor({
        controllerPath: '/api/files',
        httpMethod: 'POST',
        hasAnnotation: false,
        hasExplicitRoles: false,
        userId: 'u1',
      })
    ).toEqual({ capability: 'dashboard', access: 'rw' });
    expect(
      fallbackCapabilityFor({
        controllerPath: '/api/semantic',
        httpMethod: 'GET',
        hasAnnotation: false,
        hasExplicitRoles: false,
        userId: 'u1',
      })
    ).toEqual({ capability: 'dashboard', access: 'r' });
  });

  it('只有 GET/HEAD/OPTIONS 算读，其余一律算写（防止把 DELETE 当只读放行）', () => {
    expect(httpMethodAccess('GET')).toBe('r');
    expect(httpMethodAccess('get')).toBe('r');
    expect(httpMethodAccess('HEAD')).toBe('r');
    expect(httpMethodAccess('OPTIONS')).toBe('r');
    expect(httpMethodAccess('POST')).toBe('rw');
    expect(httpMethodAccess('PUT')).toBe('rw');
    expect(httpMethodAccess('PATCH')).toBe('rw');
    expect(httpMethodAccess('DELETE')).toBe('rw');
    // method 缺失时保守按读处理（真实 Express 请求一定有 method；此处只为不抛错）
    expect(httpMethodAccess('')).toBe('r');
  });

  it('敏感前缀在无注解时必须落到**严格**能力码，而不是兜底的 dashboard', () => {
    // 兜底表的价值就在这里：把"漏注解"从"放行"变成"按前缀收紧"。
    // 最长前缀优先，且写语义必须命中 write 能力码。
    //
    // 注：`api/notifications` / `api/files` / `api/attachments` 这些前缀的
    // `write: null`（读能力码即写能力码），但它们的控制器方法都有 `@Public()`
    // 或服务层 ACL，**不会**走到兜底 —— 兜底只对"真漏注解"的新接口生效。
    expect(
      fallbackCapabilityFor({
        controllerPath: '/api/master-data/customers',
        httpMethod: 'POST',
        hasAnnotation: false,
        hasExplicitRoles: false,
        userId: 'u1',
      })
    ).toEqual({ capability: 'crm_write', access: 'rw' });
    expect(
      fallbackCapabilityFor({
        controllerPath: '/api/master-data/tax-entities',
        httpMethod: 'POST',
        hasAnnotation: false,
        hasExplicitRoles: false,
        userId: 'u1',
      })
    ).toEqual({ capability: 'tax_entity', access: 'rw' });
    expect(
      fallbackCapabilityFor({
        controllerPath: '/api/admin/users',
        httpMethod: 'DELETE',
        hasAnnotation: false,
        hasExplicitRoles: false,
        userId: 'u1',
      })
    ).toEqual({ capability: 'admin_ops', access: 'rw' });
    expect(
      fallbackCapabilityFor({
        controllerPath: '/api/voucher',
        httpMethod: 'POST',
        hasAnnotation: false,
        hasExplicitRoles: false,
        userId: 'u1',
      })
    ).toEqual({ capability: 'finance_write', access: 'rw' });
  });

  it('兜底表覆盖所有已登记前缀（防止接线后误拦自家接口）', () => {
    // 每个已登记前缀的读/写都必须解析出能力码 —— 否则接线兜底后
    // 该前缀下所有无注解端点会立刻 403（把合法用户挡在门外，属可用性事故）。
    const unresolved: string[] = [];
    for (const rule of ROUTE_CAPABILITY_RULES) {
      for (const method of ['GET', 'POST'] as const) {
        const resolved = fallbackCapabilityFor({
          controllerPath: rule.prefix,
          httpMethod: method,
          hasAnnotation: false,
          hasExplicitRoles: false,
          userId: 'u1',
        });
        if (!resolved) unresolved.push(`${method} ${rule.prefix}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it('`api` 兜底规则保证任何 api/* 路径都有能力码（不会因接线而 500/403 自家接口）', () => {
    // `resolveCapability` 的最后一条规则前缀是 `api`，因此**所有** `/api/...`
    // 路径都能解析出能力码（写接口沿用读能力码 = dashboard 的 `r`）。
    // 本断言把这个"兜底之所以安全"的前提钉死：一旦有人把 `api` 那条规则删掉，
    // 未注解接口会立刻从"放行"变成"403"，需要显式修正而不是静默。
    const apiRule = ROUTE_CAPABILITY_RULES.find((rule) => rule.prefix === 'api');
    expect(apiRule).toBeDefined();
    expect(apiRule?.read).toBe('dashboard');
  });

  it('兜底后仍走 allowsRequest：无角色用户拿不到需要角色的能力', () => {
    const requirement = fallbackCapabilityFor({
      controllerPath: '/api/admin/users',
      httpMethod: 'POST',
      hasAnnotation: false,
      hasExplicitRoles: false,
      userId: 'u1',
    });
    expect(requirement).not.toBeNull();
    expect(requirement).not.toBeUndefined();
    // 无角色用户：`_default` 不含 admin_ops 写权限 → 拒绝
    expect(
      allowsRequest({
        isPublic: false,
        needLogin: false,
        userId: 'u1',
        userRoles: [],
        requiredCapability: requirement ?? undefined,
      })
    ).toBe('forbidden');
  });
});

describe('self_service：登录即用的自助能力', () => {
  it('任何角色（含无角色）都具备写权限', () => {
    expect(hasWriteCapability(['admin'], 'self_service')).toBe(true);
    expect(hasWriteCapability(['finance_viewer'], 'self_service')).toBe(true);
    expect(hasWriteCapability(['hr_manager'], 'self_service')).toBe(true);
    expect(hasWriteCapability([], 'self_service')).toBe(true);
  });

  it('不会把 dashboard 的默认读权限误当成写权限', () => {
    expect(hasWriteCapability(['finance_viewer'], 'dashboard')).toBe(false);
    expect(hasWriteCapability([], 'dashboard')).toBe(false);
  });
});
