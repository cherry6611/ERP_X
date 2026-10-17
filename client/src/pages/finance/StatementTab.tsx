import React, { useEffect, useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { TableColumnsType } from 'antd';
import { DataState } from '@client/src/components/DataState';
import PeriodSelect from '@client/src/components/erp/PeriodSelect';
import FilterBar from '@client/src/components/erp/FilterBar';
import {
  PrintButton,
  cellText,
  compactFields,
  metaField,
  type PrintPackSeed,
} from '@client/src/components/print';
import { Button } from '@client/src/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { financeApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { seriesColor } from '@client/src/theme/tokens';
import { currentPeriod } from '@client/src/utils/format';
import type {
  StatementCounterpartyOption,
  StatementDirection,
  StatementLineItem,
  StatementResult,
} from '@shared/api.interface';
import StatementReport from './components/StatementReport';

/*
 * 文案/样式表与 `money()` 都留在本文件做**唯一真源**：`DOC_TYPE_LABELS` 同时喂给
 * `columns`、打印包与结果区（经 `docTypeLabels` prop），`STATUS_LABELS` 喂给
 * `columns` 与打印包，`STATUS_CLASS` 只喂 `columns` —— 拆到结果区会变成第二份定义。
 */
/** 单据类型展示文案 */
const DOC_TYPE_LABELS: Record<StatementLineItem['docType'], string> = {
  ar: '应收单',
  ap: '应付单',
  receipt: '回款单',
  payment: '付款单',
  invoice: '发票',
  // 折让/退回冲减必须单独展示：否则对方会以为这笔钱还没付
  adjust: '收入折让',
};

/** 核对状态展示文案与颜色（备查行不参与余额，用中性色） */
const STATUS_LABELS: Record<StatementLineItem['status'], string> = {
  reconciled: '已核销',
  partial: '部分核销',
  open: '未核销',
  voided: '已作废',
  informational: '备查',
};

const STATUS_CLASS: Record<StatementLineItem['status'], string> = {
  reconciled: 'text-success',
  partial: 'text-warning',
  open: 'text-info',
  voided: 'text-destructive',
  informational: 'text-muted-foreground',
};

/** 备查行（发票）在借贷列上不留数字，避免看起来像又加了一笔 */
const money = (value: number, line: StatementLineItem): string =>
  line.affectsBalance ? cellText(value) : '';

/**
 * C-11 对账单 Tab。
 *
 * 与「勾稽中心」的区别：这里是**给对手方寄送/确认**的对账单，
 * 按期列示期初余额、本期逐笔发生与运行余额，末行给出可确认的期末余额。
 * 打印复用 C-06 打印框架（`PrintButton` + `print.css`），单据种类 `statement`。
 *
 * §5.9（F8）：文件原先 528 非空行，超出「组件 ≤ 500 行」的门槛。本轮把**结果区**
 * （原 374–548 行的 `{statement ? … : null}`，共 175 行）整体抽到
 * `./components/StatementReport`。选它的理由：这一块是**纯展示**（无 state、
 * 无副作用、无 handler），而本文件里占体量的正是它；抽走后主文件只剩
 * 「数据查询 + 筛选区 + 列定义/图表 memo + 打印包」这套编排。
 *
 * ⚠️ 刻意**没有**搬走的三样（搬了只会把依赖链拉长或多传一层 props）：
 *   · `columns` 与图表 `option` 的 `useMemo` —— 依赖 `STATUS_CLASS` / `chartData`
 *     等本文件的东西，且 memo 必须贴着自己的数据源；
 *   · `buildPack` 打印包 —— `PrintButton` 挂在下方 `FilterBar` 里，与结果区无关；
 *   · 文案/样式表与 `money()` —— `DOC_TYPE_LABELS` / `STATUS_LABELS` / `STATUS_CLASS`
 *     屏幕与打印件共用，留在这里做唯一真源，结果区只经 `docTypeLabels` prop 取用。
 *
 * 结果区里**没有**任何"打开即重置"的语义（原本也没有 `useState`），
 * `{statement ? … : null}` 的位置与判据未动。
 */
const StatementTab: React.FC = () => {
  const [direction, setDirection] = useState<StatementDirection>('customer');
  const [counterpartyId, setCounterpartyId] = useState<string>('');
  const [period, setPeriod] = useState<string>(currentPeriod());

  const {
    data: options,
    loading: optionsLoading,
    error: optionsError,
    reload: reloadOptions,
  } = useAsyncData<StatementCounterpartyOption[]>(
    () => financeApi.listStatementCounterparties(direction),
    [direction],
  );

  // 切换方向后重置对手方，并在下拉就绪时自动选中第一个，避免"空白页 + 必须手点"
  useEffect(() => {
    setCounterpartyId(options?.[0]?.id ?? '');
  }, [options]);

  const {
    data: statement,
    loading,
    error,
    reload,
  } = useAsyncData<StatementResult | null>(
    () =>
      counterpartyId
        ? direction === 'customer'
          ? financeApi.getCustomerStatement(counterpartyId, period)
          : financeApi.getSupplierStatement(counterpartyId, period)
        : Promise.resolve(null),
    [direction, counterpartyId, period],
  );

  /*
   * F2：`?? []` 每次渲染产生新数组 → 会让下游 memo（`columns` / ECharts `option`）
   * 全部失效。必须先 memo 数据源本身，下游的 memo 才有意义。
   */
  const lines: StatementLineItem[] = useMemo(
    () => statement?.lines ?? [],
    [statement],
  );
  const counterpartyList = useMemo(() => options ?? [], [options]);

  const columns: TableColumnsType<StatementLineItem> = useMemo(
    () => [
      {
        title: '日期',
        dataIndex: 'date',
        width: 110,
        fixed: 'left',
        render: (v: string) => v || '—',
      },
      {
        title: '单据类型',
        dataIndex: 'docType',
        width: 100,
        render: (v: StatementLineItem['docType']) => DOC_TYPE_LABELS[v] ?? v,
      },
      {
        title: '单据编号',
        dataIndex: 'docCode',
        width: 170,
        render: (v: string, row) => (
          <span className="font-mono text-xs">
            {v || '—'}
            {row.relatedDocCode ? (
              <span className="ml-1 text-muted-foreground">→ {row.relatedDocCode}</span>
            ) : null}
          </span>
        ),
      },
      {
        title: '增加（借方）',
        dataIndex: 'debit',
        width: 130,
        align: 'right',
        render: (v: number, row) => money(v, row),
      },
      {
        title: '减少（贷方）',
        dataIndex: 'credit',
        width: 130,
        align: 'right',
        render: (v: number, row) => money(v, row),
      },
      {
        title: '余额',
        dataIndex: 'runningBalance',
        width: 140,
        align: 'right',
        render: (v: number | null, row) =>
          v == null ? (
            <span className="text-muted-foreground">
              {row.affectsBalance ? '—' : '不计入余额'}
            </span>
          ) : (
            cellText(v)
          ),
      },
      {
        title: '核对状态',
        dataIndex: 'status',
        width: 100,
        render: (v: StatementLineItem['status']) => (
          <span className={STATUS_CLASS[v] ?? ''}>{STATUS_LABELS[v] ?? v}</span>
        ),
      },
      {
        title: '备注',
        dataIndex: 'remark',
        render: (v: string | null) => v || '—',
      },
    ],
    [],
  );

  // F2：`filter` 每次渲染产生新数组 → 会让 option 的 memo 失效，必须先 memo
  const chartData = useMemo(
    () => lines.filter((line) => line.runningBalance != null),
    [lines],
  );
  /*
   * F2（§5.3）：option 必须 memo —— 否则父组件任何 state 变化都会让它成为
   * 新对象引用，`echarts-for-react` 随即走 setOption 全量 diff 重绘。
   */
   const option: EChartsOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    grid: { left: '3%', right: '4%', bottom: '12%', containLabel: true },
    xAxis: {
      type: 'category',
      data: chartData.map((line) => line.date),
      boundaryGap: false,
    },
    yAxis: { type: 'value', name: '余额' },
    series: [
      {
        type: 'line',
        name: '运行余额',
        smooth: false,
        data: chartData.map((line) => line.runningBalance ?? 0),
        itemStyle: { color: seriesColor('revenue') },
        lineStyle: { color: seriesColor('revenue') },
        areaStyle: { opacity: 0.08 },
      },
    ],
  }), [chartData]);

  const summary = statement?.reconSummary;
  const excludedCount = statement?.excludedLines.length ?? 0;

  /** 打印包：对手方抬头 + 我方抬头 + 7 列明细 + 期初/本期/期末三段合计 */
  const buildPack = (): PrintPackSeed | null => {
    if (!statement) return null;
    return {
      kind: 'statement',
      code: `${statement.counterparty.code}-${statement.period}`,
      title: direction === 'customer' ? '客户对账单' : '供应商对账单',
      subtitle: `对账期间：${statement.period}（${statement.periodRange.start} 至 ${statement.periodRange.monthEnd}）`,
      meta: compactFields([
        metaField('单位名称', statement.org.companyName ?? ''),
        metaField('纳税人识别号', statement.org.uscc ?? ''),
        metaField('地址/电话', [statement.org.address, statement.org.phone].filter(Boolean).join(' ')),
        metaField('开户行及账号', [statement.org.bankName, statement.org.bankAccount].filter(Boolean).join(' ')),
      ]),
      tableTitle: direction === 'customer' ? '客户往来明细' : '供应商往来明细',
      columns: [
        { key: 'date', label: '日期', widthMm: 20, align: 'center' },
        { key: 'docType', label: '单据类型', widthMm: 18, align: 'center' },
        { key: 'docCode', label: '单据编号', widthMm: 34 },
        { key: 'debit', label: '增加（借方）', widthMm: 24, align: 'right' },
        { key: 'credit', label: '减少（贷方）', widthMm: 24, align: 'right' },
        { key: 'balance', label: '余额', widthMm: 26, align: 'right' },
        { key: 'status', label: '核对状态', widthMm: 18, align: 'center' },
      ],
      rows: lines.map((line) => ({
        cells: {
          date: line.date,
          docType: DOC_TYPE_LABELS[line.docType] ?? line.docType,
          docCode: line.relatedDocCode
            ? `${line.docCode} → ${line.relatedDocCode}`
            : line.docCode,
          debit: money(line.debit, line),
          credit: money(line.credit, line),
          balance: line.runningBalance == null ? '' : cellText(line.runningBalance),
          status: STATUS_LABELS[line.status] ?? line.status,
        },
      })),
      extraFields: compactFields([
        metaField('对方单位', `${statement.counterparty.name}（${statement.counterparty.code}）`),
        metaField('对方税号', statement.counterparty.uscc ?? ''),
        metaField('对方联系人', [statement.counterparty.contactName, statement.counterparty.contactPhone].filter(Boolean).join(' ')),
        metaField(
          '核对进度',
          `已核销 ${summary?.reconciled ?? 0} 张 / 部分核销 ${summary?.partial ?? 0} 张 / 未核销 ${summary?.open ?? 0} 张`,
        ),
        excludedCount > 0
          ? metaField('已剔除作废单据', `${excludedCount} 张（不参与余额）`)
          : null,
      ]),
      totals: [
        { label: '期初余额', amount: statement.openingBalance },
        { label: '本期增加合计', amount: statement.periodDebit },
        { label: '本期减少合计', amount: statement.periodCredit },
        {
          label: direction === 'customer' ? '期末应收余额' : '期末应付余额',
          amount: statement.closingBalance,
          inWords: true,
          emphasize: true,
        },
      ],
      clauses: [
        `本对账单依据我方系统台账生成：期初余额取 ${statement.periodRange.start} 之前的累计发生额净额；本期区间为 ${statement.periodRange.start} 至 ${statement.periodRange.monthEnd}（含首尾）。`,
        '发票行仅为备查，其金额已包含在对应的应收/应付单据中，不重复计入余额。',
        '已作废的收付款与发票单据已整单剔除，不参与余额计算。',
        '请核对无误后签章回传；如有差异请在回执中逐笔注明。',
      ],
      signatures: [
        { slot: 'prepared', label: '我方制单', signer: null },
        { slot: 'counterparty', label: '对方确认', signer: null },
        { slot: 'approved', label: '我方财务', signer: null },
      ],
      sourceNote: `生成时间：${new Date(statement.generatedAt).toLocaleString('zh-CN')}`,
    };
  };

  return (
    <div className="flex flex-col gap-4">
      <FilterBar title="对账单条件">
        <Select
          value={direction}
          onValueChange={(v: string) => setDirection(v as StatementDirection)}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="对账方向" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="customer">客户对账单</SelectItem>
            <SelectItem value="supplier">供应商对账单</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={counterpartyId}
          onValueChange={setCounterpartyId}
          disabled={counterpartyList.length === 0}
        >
          <SelectTrigger className="w-[260px]">
            <SelectValue
              placeholder={optionsLoading ? '加载对手方…' : '选择对手方'}
            />
          </SelectTrigger>
          <SelectContent>
            {counterpartyList.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}（{item.code}）
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <PeriodSelect value={period} onChange={setPeriod} />

        <Button variant="outline" size="sm" onClick={() => void reload()}>
          刷新
        </Button>
        <PrintButton build={buildPack} disabled={!statement} label="打印对账单" />
      </FilterBar>

      {optionsError ? (
        <DataState
          error={`对手方列表加载失败：${optionsError}`}
          onRetry={() => void reloadOptions()}
        />
      ) : null}

      {!optionsLoading && !optionsError && counterpartyList.length === 0 ? (
        <DataState
          empty
          emptyTitle="暂无对账数据"
          emptyText={
            direction === 'customer'
              ? '还没有发生过业务的客户。登记应收或回款后即可生成客户对账单。'
              : '还没有发生过业务的供应商。登记应付或付款后即可生成供应商对账单。'
          }
        />
      ) : null}

      {counterpartyList.length > 0 ? (
        <DataState
          loading={loading}
          error={error}
          empty={!loading && !error && !statement}
          emptyText="请选择对手方与对账期间"
          onRetry={() => void reload()}
          skeleton="table"
        >
          {statement ? (
            <StatementReport
              direction={direction}
              statement={statement}
              lines={lines}
              chartData={chartData}
              option={option}
              columns={columns}
              summary={summary}
              excludedCount={excludedCount}
              loading={loading}
              docTypeLabels={DOC_TYPE_LABELS}
            />
          ) : null}
        </DataState>
      ) : null}
    </div>
  );
};

export default StatementTab;
