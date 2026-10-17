/**
 * §5.9 拆分：把「申报表行次」从 `TaxDeclarationPage` 抽出。
 *
 * ## 为什么抽这一块
 *
 * 按 §5.9 的收益判据，抽出的理由**不是"行数超了"**，而是这一块自带语义：
 *   · 它是"底稿主体 + 一致性徽章 + 差异行高亮 + 合计行口径"四件事的封装；
 *   · 合计行有一条**易错口径**（只汇总 `summable` 行，不能无条件求和，
 *     否则会得到"销售额+税额−留抵"这种没有会计含义的混合数）。
 *     把这条例外规则和它作用的表格放在同一个文件里，改的人不容易漏。
 *
 * 主文件保留：`PageShell`、筛选区、导出按钮、确认弹窗、跨区块的数据获取。
 */
import { Table } from 'antd';
import type { VatDeclarationLine } from '@shared/api.interface';
import { formatMoney } from '@client/src/utils/format';
import { vatLineColumns } from '../tax-declaration-columns';

interface Props {
  lines: VatDeclarationLine[];
}

/*
 * ⚠️ 这里**故意不接收** `reconciled` / `differenceLineCount`。
 * 一致性徽章与区块标题留在父页面（它们属于"区块头部"，不是表格的一部分），
 * 所以本组件只负责表格本体。我第一版把这两个参数也传了进来却没用到 ——
 * 未使用的 props 会让下一个改的人以为"表格会自己渲染徽章"。
 */
const VatLineTable: React.FC<Props> = ({ lines }) => (
  <Table<VatDeclarationLine>
    columns={vatLineColumns}
    dataSource={lines}
    rowKey="rowNo"
    size="small"
    scroll={{ x: 1100 }}
    pagination={false}
    rowClassName={(record) => (record.difference !== 0 ? 'bg-warning/10' : '')}
    locale={{ emptyText: '该期间无申报表行次' }}
    summary={() => (
      <Table.Summary.Row>
        {/*
          修复：原先对所有行**无条件求和**，把「一、按适用税率计税销售额（不含税）」
          （30,000）与「销项税额」（1,800）、以及留抵余额直接相加，得出 33,600 这种
          「销售额 + 税额 − 留抵」的混合数 —— **没有任何会计含义**，财务看到会误判。
          现在只汇总 `summable` 行（同为"本期发生"口径），并在表头写明口径。
        */}
        <Table.Summary.Cell index={0} colSpan={3}>
          合计（本表口径：仅第 1/11/12/13 行等本期发生项，不含留抵与应纳税额）
        </Table.Summary.Cell>
        <Table.Summary.Cell index={3} align="right">
          <span className="tabular-nums">
            {formatMoney(
              lines.filter((line) => line.summable).reduce((sum, line) => sum + line.amount, 0),
            )}
          </span>
        </Table.Summary.Cell>
        <Table.Summary.Cell index={4} align="right">
          <span className="tabular-nums text-muted-foreground">——</span>
        </Table.Summary.Cell>
        <Table.Summary.Cell index={5} align="right">
          <span className="tabular-nums">
            {formatMoney(lines.reduce((sum, line) => sum + line.difference, 0))}
          </span>
        </Table.Summary.Cell>
        <Table.Summary.Cell index={6} />
      </Table.Summary.Row>
    )}
  />
);

export default VatLineTable;
