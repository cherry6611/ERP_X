/**
 * 增值税申报底稿的 **antd 表格列定义**（§5.9 / F8 拆分）。
 *
 * 从 `TaxDeclarationPage.tsx` 抽出两块 `useMemo`（原 L159-329，含注释约 171 行）：
 * 申报表行次的 `lineColumns` 与申报历史的 `historyColumns`。
 *
 * ## 为什么单独成文件
 *
 * 列定义恰恰是"改错看不出来"的地方，且本页的错法都有**合规含义**：
 *   · `dataIndex` 指向契约里不存在的字段 → 该列永久渲染 `-`，
 *     页面上看不出异常（`tsc` 也拦不住：antd 的 `DataIndex<T>` 接受任意字符串）；
 *   · 「已说明」列的 `filters` / `onFilter` 配对写错 → **筛不出未说明的差异行**，
 *     而"筛出未说明差异"正是底稿复核的核心动作；
 *   · 历史表里四个金额列由 `dataIndex` 映射表生成，字段名写错
 *     （`closingCredit` 写成 `payableTax`）会让**期末留抵显示成应纳税额** ——
 *     数字看着正常，含义完全相反。
 * 拆出来后这些都能逐列断言，不用渲染整页。
 *
 * ## 为什么是常量数组而不是工厂函数
 *
 * ⚠️ 关键判断：本页两块列定义**没有闭包任何父组件状态或处理函数** ——
 * `render` 只用到 `formatMoney` / `Badge` / `VAT_CATEGORY_LABELS`（都是模块级），
 * 故不需要 `purOrderColumns({ onAccept, onCancel })` 那种工厂形态
 * （工厂是为 "`render` 闭包了随父组件每次渲染而变的 handler" 准备的）。
 *
 * ⚠️ **列数组的引用稳定性必须与原先等价**：原代码是 `useMemo(..., [])` ——
 * 空依赖，即**整个组件生命周期内同一个数组引用**（这正是页面上 §5.5 注释担心的
 * "`?? []` 每次渲染产生新数组 → 让下游 useMemo 失效"的另一面：列定义**不能**
 * 每次渲染换新引用，否则 antd 会重置排序/筛选状态）。
 * 本文件导出模块级常量，天然满足"跨渲染同一引用"，且**比 `useMemo` 更强**：
 * 跨组件实例（多次进出本页）也保持同一引用。
 *
 * `TaxDeclarationPage.tsx` 的 §5.5 注释还指出：若模块级常量的标识符**被用到**
 * （如 `dataIndex: COLUMNS_LABELS.x`），它就必须进依赖数组；本文件的两个常量
 * 只作为 `<Table columns={...}>` 的值使用，**其标识符没有被引用进任何
 * `useMemo` 回调体**，因此父组件不再需要 `useMemo` 包裹（见页面侧说明）。
 *
 * 列头文案、宽度、`fixed` / `dataIndex` / `render` / `filters` / `sorter`
 * 全部**逐字搬运**，未改一个字符；唯一改动是「类别」列的标签表由页面级
 * `CATEGORY_LABELS` 变为从 `./tax-declaration-export-columns` 导入的同一张表
 * （导出列与表格列共用一份，原先是同文件内共用，语义不变）。
 */
import { TableColumnsType } from 'antd';
import { Badge } from '@client/src/components/ui/badge';
import { formatMoney } from '@client/src/utils/format';
import type {
  VatDeclarationHistoryItem,
  VatDeclarationLine,
} from '@shared/api.interface';
import { VAT_CATEGORY_LABELS as CATEGORY_LABELS } from './tax-declaration-export-columns';

/**
 * §5.5（F4）：申报表行次的列定义。
 *
 * 差异金额用条件类名着色（非零=warning 加粗）—— 与原先的 `cn(...)` 等价。
 * 「已说明」列改用 `filters`：底稿复核的核心诉求正是**筛出未说明的差异行**，
 * 原先只能逐行肉眼找。
 */
export const vatLineColumns: TableColumnsType<VatDeclarationLine> = [
  {
    title: '行次',
    dataIndex: 'rowNo',
    width: 80,
    fixed: 'left',
    render: (value: string) => (
      <span className="tabular-nums">{value}</span>
    ),
  },
  {
    title: '项目',
    dataIndex: 'rowName',
    width: 300,
    fixed: 'left',
  },
  {
    title: '类别',
    dataIndex: 'category',
    width: 120,
    render: (value: string) => CATEGORY_LABELS[value] ?? value,
  },
  {
    title: '申报表金额',
    dataIndex: 'amount',
    width: 150,
    align: 'right',
    render: (value: number) => (
      <span className="tabular-nums">{formatMoney(value)}</span>
    ),
    sorter: (a, b) => Number(a.amount ?? 0) - Number(b.amount ?? 0),
  },
  {
    title: '总账口径金额',
    dataIndex: 'ledgerAmount',
    width: 150,
    align: 'right',
    render: (value: number) => (
      <span className="tabular-nums">{formatMoney(value)}</span>
    ),
  },
  {
    title: '差异',
    dataIndex: 'difference',
    width: 140,
    align: 'right',
    render: (value: number) => (
      <span
        className={
          value !== 0
            ? 'tabular-nums font-medium text-warning'
            : 'tabular-nums text-muted-foreground'
        }
      >
        {formatMoney(value)}
      </span>
    ),
    // 默认按差异绝对值倒序的思路：复核者最关心差异最大的行
    sorter: (a, b) =>
      Math.abs(Number(b.difference ?? 0)) - Math.abs(Number(a.difference ?? 0)),
    defaultSortOrder: 'ascend',
  },
  {
    title: '已说明',
    dataIndex: 'explained',
    width: 100,
    filters: [
      { text: '已说明', value: true },
      { text: '未说明', value: false },
    ],
    onFilter: (value, record) => record.explained === value,
    render: (value: boolean) =>
      value ? (
        <Badge variant="success">已说明</Badge>
      ) : (
        <Badge variant="secondary">未说明</Badge>
      ),
  },
];

/** §5.5（F4）：申报历史的列定义 */
export const vatHistoryColumns: TableColumnsType<VatDeclarationHistoryItem> = [
  { title: '期间', dataIndex: 'period', width: 100 },
  {
    title: '纳税主体',
    dataIndex: 'taxEntityName',
    width: 200,
    render: (value: string | null) => value ?? '全部主体',
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 100,
    filters: [
      { text: '已确认', value: 'confirmed' },
      { text: '草稿', value: 'draft' },
    ],
    onFilter: (value, record) => record.status === value,
    render: (value: string) => (
      <Badge variant={value === 'confirmed' ? 'success' : 'secondary'}>
        {value === 'confirmed' ? '已确认' : '草稿'}
      </Badge>
    ),
  },
  ...[
    ['销项税额', 'outputTax'],
    ['进项税额', 'inputTax'],
    ['应纳税额', 'payableTax'],
    ['期末留抵', 'closingCredit'],
  ].map(([title, field]) => ({
    title,
    width: 130,
    align: 'right' as const,
    render: (_value: unknown, record: VatDeclarationHistoryItem) => (
      <span className="tabular-nums">
        {formatMoney(record[field as keyof VatDeclarationHistoryItem] as number)}
      </span>
    ),
  })),
  {
    title: '台账核对',
    dataIndex: 'reconciled',
    width: 110,
    filters: [
      { text: '一致', value: true },
      { text: '有差异', value: false },
    ],
    onFilter: (value, record) => record.reconciled === value,
    render: (value: boolean) =>
      value ? (
        <Badge variant="success">一致</Badge>
      ) : (
        <Badge variant="destructive">有差异</Badge>
      ),
  },
  {
    title: '差异说明',
    dataIndex: 'differenceReason',
    width: 260,
    // `ellipsis` 自带 tooltip：差异说明是财务复核时最需要读全的一段文本，
    // 原先的 `truncate` 会静默截断且无提示
    ellipsis: true,
    render: (value: string | null) => value ?? '-',
  },
  {
    title: '生成人 / 时间',
    width: 180,
    render: (_value, record) => (
      <span className="text-xs text-muted-foreground">
        {record.generatedBy ?? '-'}
        <br />
        {record.generatedAt
          ? new Date(record.generatedAt).toLocaleString('zh-CN')
          : '-'}
      </span>
    ),
  },
];
