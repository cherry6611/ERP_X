import { splitTax } from '@shared/tax';

export interface PostingLine {
  accountCode: string;
  debit?: number;
  credit?: number;
}

function keep(lines: PostingLine[]): PostingLine[] {
  return lines.filter(
    (line) => Number(line.debit ?? 0) !== 0 || Number(line.credit ?? 0) !== 0
  );
}

/** 销项开票 / 收入确认：借 1122 价税合计，贷 6001 不含税，贷 222101 销项税。 */
export function outputIssueLines(gross: number, rate: number): PostingLine[] {
  const { net, tax } = splitTax(gross, rate);
  return keep([
    { accountCode: '1122', debit: gross },
    { accountCode: '6001', credit: net },
    { accountCode: '222101', credit: tax },
  ]);
}

export function outputVoidLines(gross: number, rate: number): PostingLine[] {
  const { net, tax } = splitTax(gross, rate);
  return keep([
    { accountCode: '6001', debit: net },
    { accountCode: '222101', debit: tax },
    { accountCode: '1122', credit: gross },
  ]);
}

/**
 * 进项登记：借 6602 不含税，借 222102 进项税，贷 2202 价税合计。
 * 进项费用化走管理费用，不进主营业务成本。
 */
export function inputIssueLines(gross: number, rate: number): PostingLine[] {
  const { net, tax } = splitTax(gross, rate);
  return keep([
    { accountCode: '6602', debit: net },
    { accountCode: '222102', debit: tax },
    { accountCode: '2202', credit: gross },
  ]);
}

/** 进项红冲：进项费用化走管理费用，不进主营业务成本。 */
export function inputVoidLines(gross: number, rate: number): PostingLine[] {
  const { net, tax } = splitTax(gross, rate);
  return keep([
    { accountCode: '2202', debit: gross },
    { accountCode: '6602', credit: net },
    { accountCode: '222102', credit: tax },
  ]);
}

/** 成本确认：借 6401，贷 2202（非增值税，无税金分录）。 */
export function costConfirmLines(amount: number): PostingLine[] {
  return [
    { accountCode: '6401', debit: amount },
    { accountCode: '2202', credit: amount },
  ];
}
