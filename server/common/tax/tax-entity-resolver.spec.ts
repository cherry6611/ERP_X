import type { PostgresJsDatabase } from '@server/platform';
import { TaxEntityLookupError, resolveVoucherTaxEntityId } from './tax-entity-resolver';

describe('纳税主体查询失败时不落到默认主体', () => {
  it('数据库故障直接失败，而不是继续用默认主体', async () => {
    let calls = 0;
    const db = {
      execute: async () => {
        calls += 1;
        if (calls === 1) return [];
        const error = new Error('connection refused');
        (error as { code?: string }).code = '08006';
        throw error;
      },
    } as unknown as PostgresJsDatabase;

    await expect(
      resolveVoucherTaxEntityId(db, {
        sourceType: 'cost',
        sourceRef: 'cost:CST2026100001',
      }),
    ).rejects.toBeInstanceOf(TaxEntityLookupError);
  });

  it('表还没建好时按查不到处理', async () => {
    const db = {
      execute: async () => {
        const error = new Error('undefined_table');
        (error as { code?: string }).code = '42P01';
        throw error;
      },
    } as unknown as PostgresJsDatabase;

    await expect(
      resolveVoucherTaxEntityId(db, {
        sourceType: 'expense',
        sourceRef: 'expense-void:EXP2026100001',
      }),
    ).resolves.toBeNull();
  });
});
