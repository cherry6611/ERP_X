import type {
  AmountInWords,
  BrandConfig,
  PrintColumn,
  PrintDocumentKind,
  PrintMetaField,
  PrintPack,
  PrintRowData,
  PrintSignatureSlot,
  PrintTotal,
} from '@shared/api.interface';
import { toRmbUpperSafe } from '@client/src/utils/rmb-upper';

import { buildPrintHeader } from './print-brand';

/**
 * C-06：前端组包的入参。
 *
 * 各单据详情页只提供业务字段，抬头/签章/页脚的默认值由 `buildPrintPack` 统一补齐，
 * 这样 10 个单据的出图风格天然一致。
 */
export interface PrintPackSeed {
  kind: PrintDocumentKind;
  code: string;
  /** 单据正文标题，如「销售合同」 */
  title: string;
  subtitle?: string | null;
  meta?: PrintMetaField[];
  tableTitle?: string | null;
  columns?: PrintColumn[];
  rows?: PrintRowData[];
  extraFields?: PrintMetaField[];
  totals?: PrintTotal[];
  clauses?: string[];
  signatures?: PrintSignatureSlot[];
  footerNote?: string;
  sourceNote?: string | null;
}

/** 通用签章栏（打印件基本要素：制单 / 审核 / 批准） */
export const DEFAULT_PRINT_SIGNATURES: PrintSignatureSlot[] = [
  { slot: 'prepared', label: '制单', signer: null },
  { slot: 'reviewed', label: '审核', signer: null },
  { slot: 'approved', label: '批准', signer: null },
];

export const DEFAULT_PRINT_FOOTER_NOTE = '本单据由晟笙 ERP 系统生成，打印后请核对并加盖公章。';

/**
 * 明细总计金额 → 人民币大写。
 * 无金额时不返回 `AmountInWords`（调用方跳过该行），而不是返回空文本。
 */
export function totalInWords(amount: number): AmountInWords | null {
  const text = toRmbUpperSafe(amount);
  if (!text) return null;
  return { amount, text };
}

/**
 * 组装打印包：抬头来自 settings 品牌配置，签章/页脚给默认值。
 * 业务字段缺失时给空数组，渲染层因此不需要判空分支。
 */
export function buildPrintPack(seed: PrintPackSeed, brand: BrandConfig | null): PrintPack {
  return {
    kind: seed.kind,
    code: seed.code,
    header: buildPrintHeader(brand, seed.title, seed.subtitle ?? null),
    meta: seed.meta ?? [],
    tableTitle: seed.tableTitle ?? null,
    columns: seed.columns ?? [],
    rows: seed.rows ?? [],
    extraFields: seed.extraFields ?? [],
    totals: seed.totals ?? [],
    clauses: seed.clauses ?? [],
    signatures:
      seed.signatures && seed.signatures.length > 0
        ? seed.signatures
        : DEFAULT_PRINT_SIGNATURES,
    footerNote: seed.footerNote ?? DEFAULT_PRINT_FOOTER_NOTE,
    sourceNote: seed.sourceNote ?? null,
  };
}

/** 把一行 `PrintRowData` 按列定义摊平成单元格文本，避免渲染层做缺失判断 */
export function rowCells(row: PrintRowData | null | undefined, columns: PrintColumn[]): string[] {
  return columns.map((column) => row?.cells?.[column.key] ?? '');
}

/** 明细表单元格文本（金额/数量统一右对齐前的通用格式化，避免各页各写一套） */
export function cellText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return value.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return value;
}

/** 元信息行通用构造（过滤掉空值，打印件上不出现「客户：-」这类噪声） */
export function metaField(label: string, value: string | number | null | undefined): PrintMetaField | null {
  const text = cellText(value);
  if (!text) return null;
  return { label, value: text };
}

/** 过滤 `metaField` 产生的 null 值 */
export function compactFields(
  fields: (PrintMetaField | null)[],
): PrintMetaField[] {
  return fields.filter((field): field is PrintMetaField => field !== null);
}
