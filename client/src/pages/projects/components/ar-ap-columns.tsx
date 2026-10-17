/**
 * 「应收 / 应付」区块四张表的列定义（§5.9 / F8）。
 *
 * ## 从 `ArApSection.tsx` 搬出来的是什么
 *
 * 两段（合计约 70 行，原先都在 886 行的组件文件里）：
 *   ① `buildColumns` —— 把 JSX 渲染按 `kind` 挂到列结构上的小工具；
 *   ② 四张表的列定义 —— 应收 / 回款 / 应付 / 付款。
 *
 * 列的**结构**（表头 / 取数字段 / 列宽 / 对齐 / 固定列）与「列 → 值」仍在
 * `./ar-ap-model`（那份是零 React 依赖、可被 `ar-ap-model.spec.ts` 逐列断言的）；
 * 本模块只多负责一件事：**这一列渲染成什么组件**（`StatusBadge` / `UserDisplay`）。
 *
 * ## 为什么是 `.tsx` 而不是搬进 `ar-ap-model.ts`
 *
 * 四份列定义里各有一列 `render` 返回 JSX。搬进纯 `.ts` 模块会让该模块变成
 * "依赖 React 的模块"，`ar-ap-model.spec.ts` 的前提（零 React 依赖、jest 的
 * CJS 编译下能直接加载）随之失效 —— 而"能单测"正是那次拆分的主要收益。
 *
 * 历史上这里还叠了一条更硬的约束：`UserDisplay` → `business-ui/api/users/queries`
 * → `platform/services.ts` → `platform/env.ts` 的 `import.meta.env.MODE`，
 * 在 jest 的 CJS 编译下报 TS1343，于是"import 了 `UserDisplay` 的模块，
 * spec 一行都跑不起来"。**该根因已修**：`platform/services.ts` 改为从零依赖的
 * `platform/static-assets.ts` 再导出 `getAssetsUrl`，含 `UserDisplay` 的模块
 * 现已能在 jest 下加载。所以 JSX 可以离开主文件 —— 但仍**不能**进纯 `.ts`
 * 模型模块，那会把 React 拉进单测的纯逻辑层。
 *
 * ## 与迁移前的一致性
 *
 * `buildColumns` 与四份列定义是**逐字搬运**：只加了外层 `return` 与函数外壳
 * （`arApColumns()`），列头文案、列序、`width`、`align`、`fixed`、`dataIndex`、
 * `render` 全部未动。列定义本身不闭包组件状态（只读行数据与标签表），
 * 因此工厂函数**不需要入参**。
 */
import { TableColumnsType } from 'antd';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import {
  apTableMeta,
  AR_AP_COLUMN_VALUES,
  AR_AP_PAYMENT_STATUS_LABELS as PAYMENT_STATUS_LABELS,
  AR_STATUS_LABELS,
  AP_STATUS_LABELS,
  arTableMeta,
  paymentTableMeta,
  receiptTableMeta,
  RECEIPT_STATUS_LABELS_FALLBACK,
  type ColumnKind,
  type ColumnMeta,
} from './ar-ap-model';
import type {
  ChainApItem,
  ChainArItem,
  PaymentItem,
  ReceiptItem,
} from '@shared/api.interface';

/**
 * 按 `kind` 把 JSX 渲染挂到列结构上。
 *
 * 取值一律来自 `AR_AP_COLUMN_VALUES`（模块里那份，规格读的也是它）：
 * 这样"哪一列取哪个字段"只有一处定义，组件里不会再出现
 * `record.amount - record.settledAmount` 这类**无法单测**的裸减法。
 *
 * 列结构本身（`title`/`dataIndex`/`width`/`align`/`fixed`）来自
 * `arTableMeta` 等四份声明，**保持原实现的列头、列序与宽度不变**。
 */
function buildColumns<T>(
  meta: ReadonlyArray<ColumnMeta>,
  values: Record<string, (row: T) => string>,
  renders: Partial<Record<ColumnKind, (row: T) => React.ReactNode>>,
): TableColumnsType<T> {
  /*
   * 末尾的 `as unknown as …`：`kind` 是本模块给列起的内部标识（antd 不认这个键），
   * 而 `ColumnMeta` 的其余字段（title/dataIndex/key/width/align/fixed）本就直接
   * 来自原实现。多出的 `kind` 是个 antd 会忽略的自定义键，行为无差异；
   * 之所以不删，是因为它是"JSX 渲染挂到哪一列"的唯一连接点。
   */
  return meta.map((m) => {
    const value = values[m.kind];
    const render = renders[m.kind];
    return {
      ...m,
      render: render
        ? (_: unknown, row: T) => render(row)
        : (_: unknown, row: T) => value(row),
    } as unknown as TableColumnsType<T>[number];
  });
}

/**
 * 四张表的列定义，逐字取自原 `ArApSection` 组件体。
 *
 * 调用方（`ArApSection`）在渲染时调用一次并解构，与原先"每次渲染现算四个
 * 常量数组"的行为一致 —— 这里刻意**没有**加 `useMemo`：原实现没有，
 * 加了会改变引用稳定性（列引用变化会影响 antd 表格内部状态），
 * 属于本次拆分范围之外的行为改动。
 */
export function arApColumns(): {
  arColumns: TableColumnsType<ChainArItem>;
  receiptColumns: TableColumnsType<ReceiptItem>;
  apColumns: TableColumnsType<ChainApItem>;
  paymentColumns: TableColumnsType<PaymentItem>;
} {
  /*
   * 四张表的列：结构取自 `./ar-ap-model` 的 `*TableMeta`，取值取自
   * `AR_AP_COLUMN_VALUES`（规格读的是同一份），只有"这一列要渲染成什么组件"
   * 留在本模块 —— 表头、列序、列宽、对齐、固定列与原实现逐字一致。
   *
   * 状态列的 `render` 覆盖：块体文字（`已核销` / `已作废` …）来自模块里的标签表，
   * 这里只负责套上 `StatusBadge` 与语义色（`STATUS_VARIANTS`）。
   * 「责任人」列同理：有值时渲染 `UserDisplay`，空值仍是模块给的 `'-'`。
   */
  const arColumns: TableColumnsType<ChainArItem> = buildColumns<ChainArItem>(
    arTableMeta,
    AR_AP_COLUMN_VALUES.ar,
    {
      arStatus: (row) => (
        <StatusBadge status={row.status} labels={AR_STATUS_LABELS} />
      ),
      arOwner: (row) =>
        row.ownerUserId ? (
          <UserDisplay value={[row.ownerUserId]} size="small" />
        ) : (
          AR_AP_COLUMN_VALUES.ar.arOwner(row)
        ),
    },
  );

  const receiptColumns: TableColumnsType<ReceiptItem> = buildColumns<ReceiptItem>(
    receiptTableMeta,
    AR_AP_COLUMN_VALUES.receipt,
    {
      receiptStatus: (row) => (
        <StatusBadge status={row.status} labels={RECEIPT_STATUS_LABELS_FALLBACK} />
      ),
    },
  );

  const apColumns: TableColumnsType<ChainApItem> = buildColumns<ChainApItem>(
    apTableMeta,
    AR_AP_COLUMN_VALUES.ap,
    {
      apStatus: (row) => <StatusBadge status={row.status} labels={AP_STATUS_LABELS} />,
    },
  );

  const paymentColumns: TableColumnsType<PaymentItem> = buildColumns<PaymentItem>(
    paymentTableMeta,
    AR_AP_COLUMN_VALUES.payment,
    {
      paymentStatus: (row) => (
        <StatusBadge status={row.status} labels={PAYMENT_STATUS_LABELS} />
      ),
    },
  );

  return { arColumns, receiptColumns, apColumns, paymentColumns };
}
