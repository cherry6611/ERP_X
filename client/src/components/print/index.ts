/**
 * C-06 单据打印与套打框架（公共入口）。
 *
 * 用法（单据详情页）：
 * ```tsx
 * <PrintButton
 *   build={(brand) => data ? {
 *     kind: 'contract',
 *     code: data.code,
 *     title: '销售合同',
 *     meta: compactFields([metaField('客户', data.customerName)]),
 *     columns: [...],
 *     rows: items.map((item) => ({ cells: { name: item.itemName } })),
 *     totals: [{ label: '合计', amount: data.amount, inWords: true }],
 *   } : null}
 * />
 * ```
 *
 * 底层：`PrintDocumentHost` 用 portal 把打印件挂到 `<body>`，`print.css` 负责
 * A4 排版、隐藏应用外壳、表头跨页重复、行不跨页与套打偏移。
 */
export { default as PrintButton } from './PrintButton';
export { default as PrintDocument } from './PrintDocument';
export { default as PrintDocumentHost } from './PrintDocumentHost';
export { default as PrintSettingsDialog } from './PrintSettingsDialog';
export {
  buildPrintPack,
  cellText,
  compactFields,
  DEFAULT_PRINT_FOOTER_NOTE,
  DEFAULT_PRINT_SIGNATURES,
  metaField,
  rowCells,
  totalInWords,
} from './print-pack';
export type { PrintPackSeed } from './print-pack';
export {
  DEFAULT_PRINT_OFFSET,
  normalizePrintOffset,
  PRINT_OFFSET_LIMIT_MM,
  readPrintPreference,
  writePrintPreference,
} from './print-storage';
export { buildPrintHeader, PRINT_BRAND_FALLBACK } from './print-brand';
