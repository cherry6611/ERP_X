import { HttpStatus } from '@nestjs/common';
import { duplicateContractConflict } from './contract-name-guard';

/**
 * 「同名合同」拒绝的回归锁。
 *
 * 被钉住的是**两条转合同路径的口径一致性**：报价转合同与商机转合同都会把
 * CRM 单据变成同名合同，两份同名合同各自可立项、各自确认收入 → **收入虚增一倍**。
 *
 * 走查实测：报价侧一直拦（409），商机侧**从来不拦**；把文案与判据收到
 * `duplicateContractConflict` 之后，两边不可能再分叉。
 */
describe('duplicateContractConflict —— 同名合同必须被 409 拒绝且提示可读', () => {
  const make = (sourceLabel: string) =>
    duplicateContractConflict({
      name: '[API_TEST] 数据中台建设',
      existingCode: 'CTR2026100029',
      sourceLabel,
    });

  it('是 409 Conflict（不是 400 —— 这是"状态冲突"而非"参数不合法"）', () => {
    expect(make('报价单标题').getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it('文案含合同名与已存在编号，可定位到具体是哪一份', () => {
    const message = make('报价单标题').message;
    expect(message).toContain('[API_TEST] 数据中台建设');
    expect(message).toContain('CTR2026100029');
  });

  it('文案给出可执行的下一步（改标题以区分），而不是只说"失败"', () => {
    const message = make('报价单标题').message;
    expect(message).toContain('请确认后再转换');
    expect(message).toContain('请先修改报价单标题以区分');
  });

  it('来源单据名由调用点给出：商机路径说"商机名称"，两条路径文案各自自洽', () => {
    expect(make('商机名称').message).toContain('请先修改商机名称以区分');
    expect(make('商机名称').message).not.toContain('报价单标题');
  });

  it('是同一条可读中文（不含英文校验腔、不含裸 SQL）', () => {
    const message = make('报价单标题').message;
    expect(message).toMatch(/[\u4e00-\u9fa5]/);
    expect(message).not.toMatch(/must be|should not exist|SELECT|INSERT/i);
  });
});
