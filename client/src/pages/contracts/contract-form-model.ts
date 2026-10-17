/**
 * §5.9 拆分：合同表单的**模型**从 `ContractFormDialog` 抽出。
 *
 * ## 这个模块封装的是一条容易搞错的业务规则
 *
 * **新建与编辑的金额下限不同**：
 *
 * | 路径 | schema | 下限 | 为什么 |
 * |---|---|---|---|
 * | 新建 | `contractSchema` | ≥ 1 | 新建一份 0 元合同没有业务含义 |
 * | 编辑 | `editContractSchema` | ≥ 0 | 库里存在 0 元合同（报价单转合同、接口直建），沿用新建 schema 会让这类合同**一打开就有红字挡住提交**，连改个名称都做不到 |
 *
 * `erp_contract.amount` 的库默认值是 0、`CreateContractDto` 的 `@Min(0)` 也允许 0 ——
 * 所以"0 元合同"是**合法的存量数据**，不是脏数据。
 *
 * 这条规则写在组件里时无法被断言：要验证"编辑 0 元合同能保存"，得先造一份 0 元合同、
 * 打开弹窗、提交一次。现在可以逐条断言。
 *
 * 另外 `editFormDefaults` 里的 `?? ''` 与 `?? undefined` 是**刻意区分**的：
 *   · 文本类控件用 `''`（受控值不能是 `undefined`，否则 React 警告受控↔非受控切换）；
 *   · 日期类用 `undefined`（`DateField` 用 `undefined` 表示"未选"；传 `''` 会被当成
 *     一个空日期字符串去解析）。
 */

import { z } from 'zod';
import { VAT_RATES } from '@shared/tax';
import type { Contract } from '@shared/api.interface';

/** 新建合同表单校验（金额 ≥ 1） */
export const contractSchema = z.object({
  name: z.string().min(1, '合同名称不能为空'),
  customerId: z.string().min(1, '请选择客户'),
  billingModel: z.string().min(1, '请选择计费模式'),
  amount: z.coerce.number().min(1, '合同金额必须大于 0'),
  taxRate: z.coerce
    .number()
    .refine((value) => (VAT_RATES as readonly number[]).includes(value), '请选择合法税率'),
  taxEntityId: z.string().optional(),
  signDate: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  owner: z.string(),
  paymentTerms: z.string(),
  remark: z.string(),
});

/**
 * 编辑模式的 schema：**仅**放宽金额下限，其余字段与 `contractSchema` 逐字相同。
 * 见文件头关于"0 元合同是合法存量数据"的说明。
 */
export const editContractSchema = contractSchema.extend({
  amount: z.coerce.number().min(0, '合同金额不能为负数'),
});

export type ContractFormData = z.output<typeof contractSchema>;
export type ContractFormInput = z.input<typeof contractSchema>;

/** 新建模式的初值 */
export const CREATE_FORM_DEFAULTS = {
  name: '',
  customerId: '',
  billingModel: 'project',
  amount: 0,
  taxRate: 6,
  taxEntityId: '',
  owner: '',
  paymentTerms: '',
  remark: '',
};

/** 编辑模式的初值：取该行现值（`null` → 空串/`undefined`，与表单控件语义对齐） */
export function editFormDefaults(target: Contract): ContractFormInput {
  return {
    name: target.name,
    customerId: target.customerId,
    billingModel: target.billingModel,
    amount: target.amount,
    taxRate: target.taxRate,
    taxEntityId: target.taxEntityId ?? '',
    signDate: target.signDate ?? undefined,
    startDate: target.startDate ?? undefined,
    endDate: target.endDate ?? undefined,
    owner: target.owner ?? '',
    paymentTerms: target.paymentTerms ?? '',
    remark: target.remark ?? '',
  };
}

/**
 * 合同表单弹窗的对外契约。
 *
 * 与表单模型放在一起（而不是留在组件文件里）：它是**调用方与组件之间的接口**，
 * 调用方要按它传参。接口与模型同处一个模块时，改接口的人自然会看到模型约束。
 */
export interface ContractFormDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * 新建成功回调（把新合同 id 交给调用方）。
   *
   * 编辑模式不需要它（成功回调是 `onUpdated`），故为可选；`ContractCreatePage`
   * 作为唯一的新建调用方仍然传入，运行时行为不变。
   */
  onCreated?: (id: string) => void;
  /** 编辑成功回调（仅在 `editTarget` 非空时触发） */
  onUpdated?: (contract: Contract) => void;
  asPage?: boolean;
  onCancel?: () => void;
  /** 编辑目标：非空即进入编辑模式（见组件文件头「编辑模式怎么进来的」） */
  editTarget?: Contract | null;
}
