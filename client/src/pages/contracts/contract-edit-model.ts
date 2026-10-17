/**
 * 合同**编辑**模式的提交模型（纯逻辑，不依赖 React/DOM，故可直接单测）。
 *
 * ## 为什么"编辑"不能复用新建那份 DTO 构造
 *
 * 新建是把一份完整表单**插**进去，编辑是对既有行做 **PATCH**。两者在服务端的判据不同：
 *
 * · `amount` 与 `customerId` 是「**字段出现即拒**」的守卫
 *   （`server/modules/contracts/contract-update-guard.ts`：非 `draft` 出现即 400，
 *   而不是"值变了才拒"）；
 * · 若编辑时把整份表单原样发上去，**只改一个合同名称**也会连带带上未改动的
 *   `customerId`/`amount` → 已生效的合同每次保存都被 400 拦住，
 *   而使用者看到的是一句"客户不可变更"，完全对不上他刚做的操作。
 *
 * 所以本模块的唯一职责是：**把表单值与库中现值逐字段比对，只下发真正改动过的字段**。
 * 这样"改名称"就只发 `{name}`，不触碰任何受限字段。
 *
 * ## 逐字段规则（每条都有对应用例）
 *
 * | 字段 | 何时下发 | 清空语义 |
 * |---|---|---|
 * | `name`/`owner`/`paymentTerms`/`remark` | 文本与现值不同 | 空串下发 `''`（服务端按空串落库） |
 * | `customerId`/`billingModel`/`amount`/`taxRate` | 与现值不同 | ——（表单里都是必填） |
 * | `signDate`/`startDate`/`endDate` | 与现值不同 | **下发 `null`**（`UpdateContractDto` 三个日期字段是 `string \| null`） |
 * | `taxEntityId` | 有值且与现值不同 | ⚠️ 清空（回"系统默认"）**不下发** —— 见下 |
 *
 * ⚠️ **已知限制（诚实标注）**：`taxEntityId` 的 DTO 是 `@IsUUID()`，空串会被 400 拒；
 * "改回系统默认"在本模块里等价于"不改"，需在客户/默认主体上调整。新建路径的
 * `taxEntityId || undefined` 也是同一行为，故两侧一致（不是本轮引入的偏差）。
 *
 * ⚠️ **本模块不下发 `milestones`**：里程碑走独立的登记/达成接口，理由见
 * `shared/api.interface.ts` 的 `UpdateContractDto` 注释。
 */
import type {
  Contract,
  CreateContractDto,
  UpdateContractDto,
} from '@shared/api.interface';

/**
 * 编辑表单的值（与 `ContractFormDialog` 的 zod 输出结构一致）。
 *
 * 刻意**不**从弹窗文件 import 类型：那样纯逻辑模块会反向依赖一个 React 组件，
 * 单测就得把 Dialog/Radix 一起加载进来（本仓 `contract-detail-model.ts` 同理）。
 */
export interface ContractFormValues {
  name: string;
  customerId: string;
  billingModel: string;
  amount: number;
  taxRate: number;
  taxEntityId?: string;
  signDate?: string;
  startDate?: string;
  endDate?: string;
  owner: string;
  paymentTerms: string;
  remark: string;
}

/** 文本字段：空值与 `null` 视为同一状态，其余按字面比对 */
function textChanged(next: string, prev: string | null | undefined): boolean {
  return next !== (prev ?? '');
}

/** 日期字段：`undefined`/空串与 `null` 视为同一状态；由有值变空 → 下发 `null` 清空 */
function datePatchValue(
  next: string | undefined,
  prev: string | null | undefined,
): string | null | undefined {
  const normalized = next && next.length > 0 ? next : null;
  if (normalized === (prev ?? null)) return undefined; // 未改动
  return normalized;
}

/**
 * 表单值 + 库中现值 → 只含改动字段的 `UpdateContractDto`。
 *
 * 返回空对象表示**没有任何改动**（调用方据此不发请求，见 `submitContractEdit`）。
 */
export function buildContractUpdateDto(
  values: ContractFormValues,
  target: Contract,
): UpdateContractDto {
  const dto: UpdateContractDto = {};

  if (textChanged(values.name, target.name)) dto.name = values.name;
  if (values.customerId !== target.customerId) dto.customerId = values.customerId;
  if (values.billingModel !== target.billingModel) {
    dto.billingModel = values.billingModel as UpdateContractDto['billingModel'];
  }
  if (values.amount !== target.amount) dto.amount = values.amount;
  if (values.taxRate !== target.taxRate) dto.taxRate = values.taxRate;

  const entity = values.taxEntityId ? values.taxEntityId : undefined;
  if (entity !== undefined && entity !== (target.taxEntityId ?? undefined)) {
    dto.taxEntityId = entity;
  }

  const signDate = datePatchValue(values.signDate, target.signDate);
  if (signDate !== undefined) dto.signDate = signDate;
  const startDate = datePatchValue(values.startDate, target.startDate);
  if (startDate !== undefined) dto.startDate = startDate;
  const endDate = datePatchValue(values.endDate, target.endDate);
  if (endDate !== undefined) dto.endDate = endDate;

  if (textChanged(values.owner, target.owner)) dto.owner = values.owner;
  if (textChanged(values.paymentTerms, target.paymentTerms)) {
    dto.paymentTerms = values.paymentTerms;
  }
  if (textChanged(values.remark, target.remark)) dto.remark = values.remark;

  return dto;
}

/**
 * 编辑提交所需的接口面。
 *
 * ⚠️ 刻意把 `createContract` 也声明进来：编辑提交**绝不能**走新建
 * （那会凭空多出一张合同），而这个错误在类型上是"合法"的 —— 两个函数都返回 `Contract`。
 * 声明成同一接口后，规格可以用 spy 直接钉住"只调了 updateContract"，
 * 而不是靠人去读 JSX。
 */
export interface ContractWriteApi {
  createContract(dto: CreateContractDto): Promise<Contract>;
  updateContract(id: string, dto: UpdateContractDto): Promise<Contract>;
}

export type ContractEditSubmitResult =
  /** 表单没有任何改动：**不发请求**（避免无意义的 PATCH 去动 `updatedAt` / 触发税额重算） */
  | { status: 'unchanged'; contract: Contract; dto: UpdateContractDto }
  | { status: 'updated'; contract: Contract; dto: UpdateContractDto };

/**
 * 编辑提交：比对 → 无改动则直接返回 → 否则 `PATCH /api/contracts/:id`。
 *
 * 只接受 `Contract`（编辑目标必存在），因此类型上就不可能调用 `createContract`。
 */
export async function submitContractEdit(
  api: ContractWriteApi,
  target: Contract,
  values: ContractFormValues,
): Promise<ContractEditSubmitResult> {
  const dto = buildContractUpdateDto(values, target);
  if (Object.keys(dto).length === 0) {
    return { status: 'unchanged', contract: target, dto };
  }
  const contract = await api.updateContract(target.id, dto);
  return { status: 'updated', contract, dto };
}
