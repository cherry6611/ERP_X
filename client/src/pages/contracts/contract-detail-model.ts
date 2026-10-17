/**
 * 合同详情弹窗（`ContractDetailDialog.tsx`）的纯逻辑（§5.9 / F8 拆分）。
 *
 * ## 为什么从 `ContractDetailDialog.tsx` 里搬出来
 *
 * 与同批拆分（`finance/invoice-schemas.ts`、`voucher/components/voucher-form.ts`、
 * `hr/components/employee-import.ts`、`hr/components/attendance-panel-model.ts`）
 * 同一理由：下面几块全部**零 React 依赖**（不碰 hook / JSX / toast / API /
 * 组件状态），留在 912 行（审计口径：非空行）的组件文件里有两个具体代价：
 *   ① 打开组件文件先看到一百多行声明，看不到组件本身；
 *   ② **无法单测** —— 而它们恰恰是最该测的：
 *
 * · **三个表单 schema**（里程碑 / Call-off 下单 / 合同变更）是这三类单据的
 *   唯一入口闸门：金额门槛、必填文案改错一位就放进脏数据，或让合法单据提交
 *   不进来，而报错只在提交时以 toast 一闪而过。
 * · **状态机按钮表**（`STATUS_ACTIONS`）决定一份合同"能走到哪些下一步"。
 *   漏一个 action 不会有任何报错：按钮直接消失，用户点不了却不知道为什么；
 *   文案写错更严重 —— 「提交审批」若被写成「审批通过」，点下去就是越权流转。
 * · **Call-off 列定义**的错位在界面上**完全看不出来**：「金额」与「序号」两列
 *   互换后两列都还是**合理数字**（框架单里序号 7 与金额 ¥7.00 同时成立），
 *   只有逐列断言能拦住。
 * · **明细草稿的默认税率**是"弹窗一打开就处于非法状态"的重灾区，见下文修复说明。
 *
 * ## 这里**没有**搬走什么（有意保留在组件里）
 *
 * · `milestoneColumns` / `versionColumns` / 明细表的内联列定义：`render` 里是
 *   JSX（`<StatusBadge>` / `<Button>` / `<CanCapabilityWrite>` / `<span>`）并闭包了
 *   `reachMilestone` / `confirmDanger` / `load` —— 搬走会把 React 拉进本模块，
 *   按 §5.9 的判据不属于"零 React 依赖"，也无从单测。
 * · `load` / `doAction` / `reachMilestone` / 三个提交处理函数：体是 API 调用 +
 *   `toast` + 组件状态。只把其中**入参拼装**那一段（空串 → `undefined` 的归一化）
 *   抽成 `buildXxxPayload`，函数体逐字照搬。
 * · `pageTitle` 与六个 `<Dialog>` 的内容：JSX。
 *
 * ## 本轮修复的真实缺陷：`coerceTaxRate()` 的 `null` 被直接当成税率用了
 *
 * 组件里原先两处（打开「添加明细」弹窗时、保存成功后重置草稿时）都写：
 *
 * ```ts
 * taxRate: coerceTaxRate(Number(detail?.taxRate ?? 6), <按主体找出的 TaxEntity>)
 * ```
 *
 * 注释（P0-3）写明的目的是"按合同主体校正默认税率"，否则
 * 「小规模主体下 `<select value={6}>` 匹配不到选项 → 显示空白、提交 400」。
 * 而 `coerceTaxRate`（`@client/src/utils/tax-rate-options.ts`）的契约恰恰是
 * **取值越界时返回 `null`**，并且它的文档要求调用方拿到 `null` 后
 * **显式提示用户**重新选择 —— 这两处既没有提示，也没有兜底，
 * `null` 直接落进 `itemDraft.taxRate`：`<select value={null}>` 依旧**空白**，
 * 点「保存」时又原样进请求体：
 *
 * | 证据 | 位置 | 说明 |
 * |---|---|---|
 * | 请求体 `taxRate: number`（非空） | `client/src/api/contracts/index.ts:117` | 契约不允许 `null` |
 * | `@IsNumber({ maxDecimalPlaces: 2 }) @Min(0) taxRate!: number` | `server/modules/contracts/contracts.dto.ts:261-263` | `null` 过不了 class-validator → **400** |
 * | `if (!isVatRate(dto.taxRate)) throw new BadRequestException('税率必须是 0、1、3、6、9、13')` | `server/modules/contracts/contract-items.service.ts:224` | 即使绕过 DTO 也会被拦 |
 * | `ALLOWED_RATES.small = [0, 1, 3, 5]`（**不含 6**） | `shared/tax.ts:49-52` | "小规模主体 + 合同税率 6"正是 P0-3 注释点名的场景 |
 *
 * 结论：注释声称已修好的那个场景，恰恰是唯一会走到 `null` 的场景 ——
 * 原修复没有达成自己的目的（小规模主体下仍然"显示空白、提交 400"，
 * 只是把提交的 6 换成了必然 400 的 `null`）。
 *
 * **修法**：`coerceTaxRate(rate, entity) ?? defaultTaxRate(entity)`。
 * 兜底取该主体**合法档位**里的默认值（`utils/tax-rate-options.ts` 正是为
 * "新建"场景提供 `defaultTaxRate` 的），于是返回值必然是数字，且与
 * 同一个 `<select>` 的选项**同源**（都走 `resolveRateOptions(entity)`），
 * "空白 + 400"两个症状同时消失。税率**本已合法**的路径一个字节都没变：
 * `coerceTaxRate` 返回原值时 `??` 右侧不求值。
 *
 * ⚠️ 仍然存在、但**本次未改**的分歧（需要多一次请求才能对齐）：`pickTaxEntity`
 * 只按「显式 `taxEntityId` → 默认主体 → 第一个主体」找主体，而后端
 * `TaxResolverService.resolveEntity`（`server/modules/tax/tax-resolver.service.ts:101-149`）
 * 在两者之间还插了「客户/供应商绑定的主体」，且默认主体要求 `status = 'active'`。
 * `utils/tax-rate-options.ts` 的 `resolveTaxEntity` 就是为对齐这条链而存在的
 * （另外 4 个调用点都在用它），但它需要 `customerTaxEntityId`，而
 * `ContractDetail` 不返回客户的绑定主体 —— 对齐必须再发一次请求，属于另一个决定。
 * 本次只修「`null` 直接进请求体」这个**必然 400** 的后果，主体口径分歧
 * 登记在同目录 `contract-detail-model.spec.ts`（`pickTaxEntity` 一节）。
 *
 * ## 两处"看着该统一、其实不能统一"的门槛（spec 已用断言登记）
 *
 * 1. 下单金额客户端门槛是 **1**（`min(1)`），服务端 `CreateCalloffDto` 是
 *    `@Min(0.01)`（`server/modules/contracts/contracts.dto.ts:104-106`）——
 *    客户端更严，方向是安全的（不可能出现"前端放行、后端 400"），
 *    但 0.5 元的下单会被前端拦下、文案却是"必须大于 0"。
 * 2. 变更后金额 `min(0)` **接受 0**，而提交时 `newAmount || undefined` 会把 0
 *    丢掉（标签写的就是"不变可填 0"）；服务端 `dto.newAmount ?? oldAmount`
 *    收到 `undefined` 表示沿用原金额。所以 `0` 在这条链上表示"不变"，
 *    不表示"改成 0 元"。
 */
import { z } from 'zod';
import type { TableColumnsType } from 'antd';
import { formatMoney } from '@client/src/utils/format';
import {
  coerceTaxRate,
  defaultTaxRate,
  resolveRateOptions,
} from '@client/src/utils/tax-rate-options';
import type { VatRate } from '@shared/tax';
import type {
  Calloff,
  ContractStatusAction,
  CreateCalloffDto,
  CreateContractVersionDto,
  CreateMilestoneDto,
  TaxEntity,
} from '@shared/api.interface';

/* ── 里程碑状态文案 ──────────────────────────────────────────────────────── */

/**
 * 里程碑状态文案（`MilestoneStatus` 只有 `pending` / `reached` 两个成员）。
 *
 * 原先是 `milestoneColumns` 的「状态」列里**内联的字面量**，每次 render 重建；
 * 提出来后可以被"每个里程碑状态都有中文标签"这类断言钉住 —— 漏一个键不会报错，
 * 只会让表格里出现英文 `reached`（`StatusBadge` 的回退是"原样显示 key"）。
 */
export const MILESTONE_STATUS_LABELS: Record<string, string> = {
  pending: '未达成',
  reached: '已达成',
};

/* ── 合同状态 → 可用操作 ─────────────────────────────────────────────────── */

/**
 * 合同状态机在详情页暴露的按钮（**顺序即按钮顺序**）。
 *
 * `Partial<Record<...>>` 是刻意的：终态 `closed` / `terminated` 没有后续动作，
 * 查不到就是空数组（`statusActionsFor`），而不是"忘了配"。
 * 按钮的 `variant` 由组件按 `action === 'reject'` 决定（驳回是危险操作）。
 */
export const STATUS_ACTIONS: Partial<
  Record<string, { action: ContractStatusAction; label: string }[]>
> = {
  draft: [{ action: 'submit', label: '提交审批' }],
  approving: [
    { action: 'approve', label: '审批通过' },
    { action: 'reject', label: '驳回' },
  ],
  active: [
    { action: 'start', label: '开始履约' },
    { action: 'terminate', label: '终止合同' },
  ],
  performing: [
    { action: 'complete', label: '履约完成' },
    { action: 'terminate', label: '终止合同' },
  ],
  completed: [{ action: 'close', label: '关闭合同' }],
};

/**
 * 取某个状态下可用的动作；详情未加载（`undefined`）或终态返回 `[]`。
 *
 * 原写法是组件里的 `detail ? (STATUS_ACTIONS[detail.status] ?? []) : []`，
 * 抽成函数后"未加载"与"终态"这两条路径都能被断言覆盖。
 */
export function statusActionsFor(
  status: string | undefined,
): { action: ContractStatusAction; label: string }[] {
  return status ? STATUS_ACTIONS[status] ?? [] : [];
}

/* ── 表单 schema ─────────────────────────────────────────────────────────── */

export const milestoneSchema = z.object({
  name: z.string().min(1, '里程碑名称不能为空'),
  amount: z.coerce.number().min(0),
  dueCondition: z.string(),
  dueDate: z.string().optional(),
});

export type MilestoneFormData = z.output<typeof milestoneSchema>;
export type MilestoneFormInput = z.input<typeof milestoneSchema>;

/*
 * `min(1)` 而不是 `min(0.01)`：下单金额的门槛**有意**比里程碑/变更金额严一档
 * （`min(0)`），见文件头「两处看着该统一、其实不能统一的门槛」。
 */
export const calloffSchema = z.object({
  amount: z.coerce.number().min(1, '下单金额必须大于 0'),
  remark: z.string(),
});

export type CalloffFormData = z.output<typeof calloffSchema>;
export type CalloffFormInput = z.input<typeof calloffSchema>;

export const changeSchema = z.object({
  changeLog: z.string().min(1, '请填写变更说明'),
  newAmount: z.coerce.number().min(0),
});

export type ChangeFormData = z.output<typeof changeSchema>;
export type ChangeFormInput = z.input<typeof changeSchema>;

/* ── 表单默认值 ──────────────────────────────────────────────────────────── */

/*
 * 这三个字面量原先在组件里各写**两遍**（`useForm({ defaultValues })` 与提交成功后的
 * `reset(...)`）。两处会各自漂移：初始值与重置值不一致时，第二次打开弹窗的行为
 * 与第一次不同，而没人会注意到。提成常量后两处必然同源，spec 再把每个字段钉死。
 *
 * 与 `finance/invoice-schemas.ts` 的 `FORM_DEFAULTS`、`hr/components/employee-import.ts`
 * 的 `EMPTY_FORM`、`attendance-panel-model.ts` 的三个 `*_FORM_DEFAULTS` 同一手法 ——
 * 它们都已经是"同一个常量既做 `defaultValues` 又做 `reset(...)` 入参"。
 * 表单只**读**这三个常量：组件里没有 `setValue` / 就地赋值会写回它们。
 */

/** 里程碑弹窗默认值（`name` 必填 → 默认不可提交，靠 `FormMessage` 提示） */
export const MILESTONE_FORM_DEFAULTS: MilestoneFormInput = {
  name: '',
  amount: 0,
  dueCondition: '',
};

/** 框架下单弹窗默认值（`amount` 门槛是 1 → 默认值**故意**不可提交） */
export const CALLOFF_FORM_DEFAULTS: CalloffFormInput = {
  amount: 0,
  remark: '',
};

/** 登记变更弹窗默认值（`newAmount: 0` = "金额不变"，见 `buildChangePayload`） */
export const CHANGE_FORM_DEFAULTS: ChangeFormInput = {
  changeLog: '',
  newAmount: 0,
};

/* ── 提交入参（空串 → undefined） ────────────────────────────────────────── */

/**
 * 里程碑入参。
 *
 * `dueCondition` 空串转 `undefined`：服务端 `CreateMilestoneDto.dueCondition`
 * 是可选的，送空串等于把"没填"存成 `''`。`dueDate` 原样透传（弹窗里没有日期
 * 输入框，因此实际恒为 `undefined`，由其他入口/服务端填）。
 */
export function buildMilestonePayload(
  values: MilestoneFormData,
): CreateMilestoneDto {
  return {
    name: values.name,
    amount: values.amount,
    dueCondition: values.dueCondition || undefined,
    dueDate: values.dueDate,
  };
}

/** 下单入参：`remark` 空串转 `undefined`（同上） */
export function buildCalloffPayload(values: CalloffFormData): CreateCalloffDto {
  return {
    amount: values.amount,
    remark: values.remark || undefined,
  };
}

/**
 * 变更入参。
 *
 * ⚠️ `newAmount || undefined`：**0 表示"金额不变"**（弹窗标签即
 * "变更后金额（元，不变可填 0）"），服务端 `contracts.service.ts` 的
 * `const nextAmount = dto.newAmount ?? oldAmount` 收到 `undefined` 就沿用原金额。
 * 所以填 0 永远不会把合同金额改成 0 —— 这是**既定语义**，不是漏判。
 */
export function buildChangePayload(
  values: ChangeFormData,
): CreateContractVersionDto {
  return {
    changeLog: values.changeLog,
    newAmount: values.newAmount || undefined,
  };
}

/* ── Call-off 表格列 ─────────────────────────────────────────────────────── */

/**
 * 框架下单表列定义（**纯**：无 JSX、无闭包，故可搬出组件并逐列断言）。
 *
 * 列错位在这里尤其危险：「金额」列取到 `seq`、「下单日期」取到 `remark` 之类
 * 的串位不会报任何错，页面上也只是"数字看起来不太对"。
 * 同表的 `milestoneColumns` / `versionColumns` 因 `render` 里是 JSX 留在组件里。
 */
export const calloffColumns: TableColumnsType<Calloff> = [
  { title: '下单编号', dataIndex: 'code', width: 150 },
  { title: '序号', dataIndex: 'seq', width: 70 },
  { title: '关联项目', dataIndex: 'projectName', width: 160, render: (v) => v ?? '-' },
  {
    title: '金额',
    dataIndex: 'amount',
    width: 120,
    align: 'right',
    render: (v: number) => formatMoney(v),
  },
  { title: '下单日期', dataIndex: 'orderDate', width: 110, render: (v) => v ?? '-' },
  { title: '备注', dataIndex: 'remark', width: 160, render: (v) => v ?? '-' },
];

/* ── 明细草稿与默认税率（P0-3 + 本轮修复） ───────────────────────────────── */

/** 「添加明细」弹窗的本地草稿（服务端金额由 `quantity × unitPrice` 重算） */
export interface ContractItemDraft {
  itemName: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
}

/**
 * 明细草稿初值：默认税率 6%（一般纳税人的常见档位）。
 *
 * 打开弹窗时会按合同主体再校正一次（`resolveItemTaxRate`），因此这里的 6
 * 只是"还没有主体信息时"的起点。`useState` 直接持有本常量：组件里 5 处
 * `setItemDraft` 全部产生**新对象**（`{ ...prev, x }` / `createItemDraft(...)`），
 * 没有任何就地赋值，因此共享这个常量不会被改写。
 */
export const EMPTY_ITEM_DRAFT: ContractItemDraft = {
  itemName: '',
  quantity: 1,
  unitPrice: 0,
  taxRate: 6,
};

/**
 * 按「显式 `taxEntityId` → 默认主体 → 第一个主体」选出当前生效主体。
 *
 * 逐字照搬原先内联在 JSX 里的三连 `??`。⚠️ 这条链**比后端少一步、也少一个过滤**：
 * 后端还会看「客户/供应商绑定的主体」，且默认主体只取 `status = 'active'` 的。
 * 详见文件头「仍然存在、但本次未改的分歧」。
 */
export function pickTaxEntity(
  taxEntities: readonly TaxEntity[],
  taxEntityId: string | null | undefined,
): TaxEntity | undefined {
  return (
    taxEntities.find((e) => e.id === taxEntityId) ??
    taxEntities.find((e) => e.isDefault) ??
    taxEntities[0]
  );
}

/** 「添加明细」税率下拉的可选项（与 `resolveItemTaxRate` 的兜底**同源**） */
export function itemRateOptions(
  taxEntities: readonly TaxEntity[],
  taxEntityId: string | null | undefined,
): readonly VatRate[] {
  return resolveRateOptions(pickTaxEntity(taxEntities, taxEntityId));
}

/**
 * 把"想用的税率"校正成该主体下**一定合法**的税率。
 *
 * `coerceTaxRate` 越界时返回 `null`（它的契约如此，并要求调用方显式提示），
 * 而这里是**新建一条明细**：没有既有值要保护，取该主体的合法默认档位即可
 * —— 返回 `null` 只会让下拉空白、点保存变 400（完整证据见文件头表格）。
 * 税率合法的路径完全不变（`coerceTaxRate` 有返回值时 `??` 右侧不求值），
 * 包括 `0`（0% 免税/出口档位，两个主体类型都合法 → 返回 `0` 而不是兜底）。
 */
export function resolveItemTaxRate(
  rate: number,
  taxEntities: readonly TaxEntity[],
  taxEntityId: string | null | undefined,
): number {
  const entity = pickTaxEntity(taxEntities, taxEntityId);
  return coerceTaxRate(rate, entity) ?? defaultTaxRate(entity);
}

/**
 * 新建一条明细时的草稿（保存成功后重置用）。
 *
 * `Number(contractTaxRate ?? 6)`：用 `??` 而不是 `||`，因此合同税率是 **0**
 * 时不会被当成"没填"而退回 6%（0% 是合法档位）。
 * 校正逻辑与打开弹窗时共用 `resolveItemTaxRate`，两处不会再分叉。
 */
export function createItemDraft(
  contractTaxRate: number | null | undefined,
  taxEntities: readonly TaxEntity[],
  taxEntityId: string | null | undefined,
): ContractItemDraft {
  return {
    itemName: '',
    quantity: 1,
    unitPrice: 0,
    taxRate: resolveItemTaxRate(
      Number(contractTaxRate ?? 6),
      taxEntities,
      taxEntityId,
    ),
  };
}
