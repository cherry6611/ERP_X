/**
 * 数据集表单的**纯逻辑**：schema + 表单值 ↔ DTO 的映射。
 *
 * ## 为什么要从 `DatasetPanel.tsx` 里搬出来
 *
 * 这个模块守的是一类**在界面上完全看不出来**的缺陷：更新分支里
 * `values.x || undefined` 会把**空串折成"缺键"**，JSON 序列化后键直接消失，
 * 服务端判为"未提供"，于是使用者把字段删空并保存、界面提示"数据集已更新"，
 * 而旧值仍在库里（清空被静默丢弃）。
 *
 * 这类缺陷没有任何类型错误、没有运行时异常、UI 上也看不出异常 —— 唯一的
 * 防线就是**能对映射函数逐字段断言**。搬成不依赖 React/DOM 的纯模块后，
 * `dataset-form.spec.ts` 可以直接穷举三态，而不需要渲染组件。
 *
 * ## `contractId` 的三态口径（与契约 `UpdateDatasetDto` 逐字对应）
 *
 * | 表单值 | 发出的 JSON | 服务端行为 |
 * |---|---|---|
 * | 某个合同 id | `{ contractId: "<uuid>" }` | 校验合同存在后写入 |
 * | `''`（选「不关联」） | `{ contractId: null }` | 清除关联 |
 * | 该键不存在 | （本表单恒发该键） | 不动 |
 *
 * ⚠️ **必须发 `null` 而不是 `undefined`**：`undefined` 在 `JSON.stringify` 时
 * 整个键被丢掉，服务端收到的是"未提供"→ 清除操作静默失效。这与
 * `source` / `remark` 用空串表达清空是**同一个道理的不同表达**：
 * 那两个字段在库里是 `text`（空串合法），而 `contractId` 是外键
 * （空串会违外键约束，只能用 NULL 表达"无关联"）。
 */
import { z } from 'zod';
import type {
  CreateDatasetDto,
  DatasetItem,
  UpdateDatasetDto,
} from '@shared/api.interface';

export const datasetSchema = z.object({
  name: z.string().min(1, '请填写数据集名称'),
  source: z.string(),
  maskLevel: z.string(),
  contractId: z.string(),
  remark: z.string(),
});

export type DatasetFormData = z.output<typeof datasetSchema>;
export type DatasetFormInput = z.input<typeof datasetSchema>;

export const EMPTY_DATASET_FORM: DatasetFormData = {
  name: '',
  source: '',
  maskLevel: 'L1',
  contractId: '',
  remark: '',
};

/** 列表项 → 表单值（编辑弹窗打开时用；`null` 一律归一成空串） */
export function toDatasetFormValues(item: DatasetItem): DatasetFormData {
  return {
    name: item.name,
    source: item.source ?? '',
    maskLevel: item.maskLevel,
    contractId: item.contractId ?? '',
    remark: item.remark ?? '',
  };
}

/**
 * 表单值 → 新建 DTO。
 *
 * 新建**没有"清除"语义**（本来就没有旧值），所以空串折成 `undefined` 是对的 ——
 * 不传即不关联。⚠️ 但这个写法**不能**照抄到更新分支，见 `toUpdateDatasetDto`。
 */
export function toCreateDatasetDto(values: DatasetFormData): CreateDatasetDto {
  return {
    name: values.name,
    source: values.source || undefined,
    maskLevel: values.maskLevel || undefined,
    contractId: values.contractId || undefined,
    remark: values.remark || undefined,
  };
}

/**
 * 表单值 → 更新 DTO（PATCH 三态）。
 *
 * `source` / `remark` **原样发出（含空串）**：服务端判据是
 * `!== undefined`，空串是合法值（语义即清空），折成 `undefined` 会让清空失效。
 *
 * `contractId` 则必须在空串时发出**显式 `null`** —— 它是外键，
 * 服务端用 `null` 表达"解除关联"；发 `undefined` 等于"不动"。
 */
export function toUpdateDatasetDto(values: DatasetFormData): UpdateDatasetDto {
  return {
    name: values.name,
    source: values.source,
    maskLevel: values.maskLevel,
    contractId: values.contractId === '' ? null : values.contractId,
    remark: values.remark,
  };
}
