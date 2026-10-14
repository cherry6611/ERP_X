import {
  costConfirmLines,
  inputCapitalizeLines,
  inputIssueLines,
  inputVoidLines,
  outputIssueLines,
  outputVoidLines,
  type PostingLine,
} from './posting';
import { VAT_RATES } from '@shared/tax';

function totals(lines: PostingLine[]) {
  return {
    debit: lines.reduce((sum, l) => sum + Number(l.debit ?? 0), 0),
    credit: lines.reduce((sum, l) => sum + Number(l.credit ?? 0), 0),
  };
}

function assertBalanced(lines: PostingLine[], label: string) {
  const { debit, credit } = totals(lines);
  // 与 VoucherHookService 的口径一致：按分比较；带上 label 便于失败时定位入参
  expect({
    label,
    debit: Math.round(debit * 100),
    credit: Math.round(credit * 100),
  }).toEqual({
    label,
    debit: Math.round(debit * 100),
    credit: Math.round(credit * 100),
  });
}

describe('会计分录模板', () => {
  const amounts = [0, 0.01, 1, 99.99, 5300, 10600, 123456.78];

  it('销项分录在全部法定税率下借贷平衡', () => {
    for (const rate of VAT_RATES) {
      for (const gross of amounts) {
        assertBalanced(outputIssueLines(gross, rate), `outputIssue ${gross}@${rate}`);
      }
    }
  });

  it('销项红冲分录在全部法定税率下借贷平衡', () => {
    for (const rate of VAT_RATES) {
      for (const gross of amounts) {
        assertBalanced(outputVoidLines(gross, rate), `outputVoid ${gross}@${rate}`);
      }
    }
  });

  it('进项分录在全部法定税率下借贷平衡', () => {
    for (const rate of VAT_RATES) {
      for (const gross of amounts) {
        assertBalanced(inputIssueLines(gross, rate), `inputIssue ${gross}@${rate}`);
      }
    }
  });

  it('进项红冲分录在全部法定税率下借贷平衡', () => {
    for (const rate of VAT_RATES) {
      for (const gross of amounts) {
        assertBalanced(inputVoidLines(gross, rate), `inputVoid ${gross}@${rate}`);
      }
    }
  });

  it('红冲分录是正向分录的等额反向', () => {
    for (const rate of VAT_RATES) {
      const issue = totals(outputIssueLines(10000, rate));
      const voided = totals(outputVoidLines(10000, rate));
      expect(voided.debit).toBe(issue.credit);
      expect(voided.credit).toBe(issue.debit);
    }
  });

  it('方向正确：销项借应收、贷收入与销项税', () => {
    const lines = outputIssueLines(10600, 6);
    const byCode = new Map(lines.map((l) => [l.accountCode, l]));
    expect(byCode.get('1122')?.debit).toBe(10600);
    expect(byCode.get('6001')?.credit).toBe(10000);
    expect(byCode.get('222101')?.credit).toBe(600);
  });

  it('方向正确：进项借管理费用与进项税、贷应付', () => {
    const lines = inputIssueLines(1060, 6);
    const byCode = new Map(lines.map((l) => [l.accountCode, l]));
    expect(byCode.get('6602')?.debit).toBe(1000);
    expect(byCode.get('222102')?.debit).toBe(60);
    expect(byCode.get('2202')?.credit).toBe(1060);
  });

  it('成本确认借贷等额', () => {
    assertBalanced(costConfirmLines(5000), 'costConfirm');
    const lines = costConfirmLines(5000);
    expect(lines[0].debit).toBe(5000);
    expect(lines[1].credit).toBe(5000);
  });

  it('固定资产资本化分录在全部法定税率下借贷平衡', () => {
    for (const rate of VAT_RATES) {
      for (const gross of amounts) {
        assertBalanced(
          inputCapitalizeLines(gross, rate),
          `inputCapitalize ${gross}@${rate}`,
        );
      }
    }
  });

  it('方向正确：资本化借固定资产与进项税、贷应付，不进 6602', () => {
    const lines = inputCapitalizeLines(1060, 6);
    const byCode = new Map(lines.map((l) => [l.accountCode, l]));
    expect(byCode.get('1601')?.debit).toBe(1000);
    expect(byCode.get('222102')?.debit).toBe(60);
    expect(byCode.get('2202')?.credit).toBe(1060);
    expect(byCode.has('6602')).toBe(false);
  });
});
