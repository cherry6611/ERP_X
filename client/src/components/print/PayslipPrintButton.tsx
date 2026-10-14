import React, { useCallback } from 'react';
import type { PayrollItem } from '@shared/api.interface';
import { cellText, compactFields, metaField } from '@client/src/components/print';
import type { PrintPackSeed } from '@client/src/components/print';
import PrintButton from './PrintButton';
import { PAYROLL_STATUS_LABELS } from '@client/src/pages/hr/components/HrStatusBadge';

interface PayslipPrintButtonProps {
  payroll: PayrollItem;
  stopPropagation?: boolean;
  className?: string;
}

/**
 * C-06 工资条打印入口（薪酬管理列表与员工自助「我的工资条」共用）。
 *
 * 单独成文件的原因：工资条组包逻辑要在两处复用（HR 薪酬面板 / 员工自助面板），
 * 放在页面组件里会造成两份实现漂移。
 */
const PayslipPrintButton: React.FC<PayslipPrintButtonProps> = ({
  payroll,
  stopPropagation = false,
  className,
}) => {
  const build = useCallback(
    (): PrintPackSeed => ({
      kind: 'payslip',
      code: payroll.code,
      title: '工资条',
      subtitle: `期间：${payroll.period}`,
      meta: compactFields([
        metaField('员工', payroll.employeeName),
        metaField('工资单编号', payroll.code),
        metaField('期间', payroll.period),
        metaField('状态', PAYROLL_STATUS_LABELS[payroll.status] ?? payroll.status),
      ]),
      tableTitle: '应发与应扣明细',
      columns: [
        { key: 'item', label: '项目' },
        { key: 'amount', label: '金额（元）', widthMm: 30, align: 'right' },
        { key: 'direction', label: '性质', widthMm: 20, align: 'center' },
      ],
      rows: [
        { cells: { item: '基本工资', amount: cellText(payroll.baseSalary), direction: '应发' } },
        { cells: { item: '绩效工资', amount: cellText(payroll.perfSalary), direction: '应发' } },
        { cells: { item: '补贴', amount: cellText(payroll.allowance), direction: '应发' } },
        {
          cells: {
            item: '社会保险',
            amount: cellText(payroll.socialInsurance),
            direction: '应扣',
          },
        },
        {
          cells: {
            item: '住房公积金',
            amount: cellText(payroll.housingFund),
            direction: '应扣',
          },
        },
        { cells: { item: '个人所得税', amount: cellText(payroll.tax), direction: '应扣' } },
      ],
      totals: [
        { label: '实发工资', amount: payroll.netSalary, inWords: true, emphasize: true },
      ],
      clauses: [
        payroll.remark ? `备注：${payroll.remark}` : '',
        '工资条为个人薪酬信息，请勿转借他人或对外公开。',
      ].filter(Boolean),
      signatures: [
        { slot: 'prepared', label: '员工签收', signer: null },
        { slot: 'reviewed', label: '人事复核', signer: null },
        { slot: 'chief_accountant', label: '财务主管', signer: null },
      ],
      footerNote: '本工资条由晟笙 ERP 系统生成，最终以银行到账金额为准。',
      sourceNote: '数据来源：人力资源薪酬模块',
    }),
    [payroll],
  );

  return (
    <PrintButton
      build={build}
      label="工资条"
      variant="ghost"
      className={className}
      stopPropagation={stopPropagation}
    />
  );
};

export default PayslipPrintButton;
