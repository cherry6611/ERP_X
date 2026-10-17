/**
 * 合同「这次 PATCH 允许改哪些字段」的判定（合同更新路径的**唯一判据**）。
 *
 * ## 为什么独立成模块
 *
 * 合同编辑原先**没有前端入口**（`updateContract` 服务端已实现，全仓 0 处调用），
 * 本轮补上编辑弹窗后，它第一次成了真实可达的写路径。而服务端原有的两条守卫是
 * `updateContract` 函数体里的**内联 `if`**：
 *
 * ```
 * if (FROZEN_STATUSES.includes(status)) { …抛… }        // name/taxRate/owner/日期/备注 冻结
 * if (dto.amount !== undefined && status !== 'draft') {
 *   …抛…「合同已生效，金额变更须走合同变更流程」
 * }
 * ```
 *
 * 内联写法在"再加两个字段"时立刻出问题：判据散在 patch 构造之间，**顺序与覆盖面
 * 都无法在测试里钉住**，而模板里最容易被漏掉的恰恰是"某个字段该被拦但漏拦" ——
 * 它不会报错、不会告警，只会安静地写进库。抽成纯函数后，规格可以逐字段喂状态组合
 * （见 `contract-update-guard.spec.ts`），服务层只负责调用与抛错。
 *
 * 手法与 `server/modules/finance/void-guard.ts` 一致：**返回中文文案而不是抛异常**，
 * 使本模块保持零依赖（不 import Nest 的 `BadRequestException`），从而能被 jest 直接加载。
 *
 * ## 字段分三档（这是本模块存在的全部意义）
 *
 * | 档 | 字段 | 判据 | 为什么 |
 * |---|---|---|---|
 * | 普通 | `signDate` / `paymentTerms` / `taxEntityId` | 任何非冻结状态都可改 | 与合同主体事实无关的表头信息 |
 * | 冻结 | `name` / `billingModel` / `taxRate` / `owner` / `startDate` / `endDate` / `remark` | `closed` / `terminated` 不可改 | 合同已归档终结，这些字段是历史事实（且会参与报表与凭证追溯） |
 * | 限草稿 | `amount` / `customerId` | 非 `draft` 一律不可改 | 见下 |
 *
 * `amount` 限草稿是**原有设计**（金额变更须走合同变更流程，前端另有「合同变更」弹窗）；
 * 本模块只是把它从内联 `if` 挪进来，**文案与判据逐字未动**。
 *
 * ### `customerId` 为什么必须与 `amount` 同一判据（本轮新增）
 *
 * 客户不是"表头里的一个名字"，它是**下游单据的归属键**：
 *
 * · `erp_invoice.customer_id`（已开具的发票）与 `erp_ar.customer_id`（已登记的应收）
 *   在开票/登记那一刻就固定指向原客户，改合同客户**不会**连带改它们；
 * · `server/modules/finance/ar.service.ts` 的 `applyWriteoffInTx` 有守卫
 *   「回款客户与应收客户不一致，不可核销」—— 于是改客户之后，这批应收**永远无法核销**
 *   （收款挂在新客户上、应收挂在旧客户上，两边都不肯让）。
 *
 * 也就是说：非草稿合同改客户不会报任何错，只会让**已存在的应收变成死账**。
 * 这类"不报错但把账做死"的写入必须在入口拦死，而不是留给使用者发现。
 *
 * ### `billingModel` 为什么进冻结集合（本轮新增）
 *
 * 计费模式决定"金额怎么摊、怎么算可开票额"（`project`/`quantity`/`subscription`/`framework`
 * 对应 `getBillable` 的不同口径）。已关闭/已终止的合同其金额口径早已被发票、收入确认与
 * 报表引用，回头改计费模式 = **让历史报表的解释方式变了**，与"已关闭合同不能改名称/日期"
 * 是同一类风险。放在**非冻结状态**下仍可改是有意的：草稿、审批中、执行中改口径是正常业务
 * （例如框架合同转按量计费），本模块不做额外限制。
 *
 * ⚠️ `billingModel` **不参与税率解析** —— `TaxResolverService.resolve` 的入参只有
 * `explicit / upstream / customerId / supplierId / taxEntityId / side`（已核对其签名），
 * 故改计费模式不会引起税额重算，无需与税率块联动；`customerId` 会，见 `contracts.service.ts`
 * 的税额重算块（已改为按**新客户**解析）。
 *
 * ⚠️ 本文件**不写**完整的抛错语句形态（哪怕是注释里）——`scripts/audit-error-messages.mjs`
 * 用正则扫**未剥离注释的原文**，注释里出现该形态会被它当成真实抛错来审计。实测踩过一次
 * （见 `void-guard.ts` 文件头的同一句提醒）。
 */

/**
 * 合同可被 PATCH 的表头字段（本模块判据的**字段全集**）。
 *
 * `paymentTerms` / `taxEntityId` 属"普通"档（本模块从不拦），列进来是为了让
 * 规格能逐字段断言"哪些状态放行"，而不是靠调用方各自记忆字段清单。
 */
export type ContractUpdatableField =
  | 'name'
  | 'billingModel'
  | 'taxRate'
  | 'owner'
  | 'signDate'
  | 'startDate'
  | 'endDate'
  | 'remark'
  | 'paymentTerms'
  | 'taxEntityId'
  | 'amount'
  | 'customerId';

/**
 * 参与判定的请求体形状。
 *
 * 用 `Partial<Record<字段, unknown>>` 而不是 `Record<string, unknown>`：后者要求
 * 目标类型带**索引签名**，而 `UpdateContractDto` 是 `interface`（没有索引签名），
 * 传进来会直接编译不过。也不直接依赖 DTO class —— 纯函数不该认识 Nest/class-validator。
 */
export type ContractUpdateFields = Partial<
  Record<ContractUpdatableField, unknown>
>;

/** 冻结状态：已关闭 / 已终止（与 `STATUS_FLOW` 的终态一致） */
export const CONTRACT_FROZEN_STATUSES: ReadonlyArray<string> = [
  'closed',
  'terminated',
];

/**
 * 冻结状态下**不可修改**的字段（`closed` / `terminated`）。
 *
 * `billingModel` 于本轮加入：已关闭/已终止的合同不该再改计费模式（理由见文件头）。
 */
export const CONTRACT_FROZEN_FIELDS: ReadonlyArray<ContractUpdatableField> = [
  'name',
  'billingModel',
  'taxRate',
  'owner',
  'startDate',
  'endDate',
  'remark',
];

/**
 * 仅 `draft` 状态可修改的字段。
 *
 * `customerId` 于本轮加入：与 `amount` 同一判据（理由见文件头 —— 发票/应收挂在原客户上，
 * 改后既有应收无法核销）。
 */
export const CONTRACT_DRAFT_ONLY_FIELDS: ReadonlyArray<ContractUpdatableField> = [
  'amount',
  'customerId',
];

/** 冻结状态下的统一文案（字段清单变了必须同步，否则使用者按提示改别的字段仍会被拒） */
export const CONTRACT_FROZEN_MESSAGE =
  '已关闭或已终止的合同不能修改名称、计费模式、税率、负责人、日期和备注';

/** 金额变更的既有文案（**逐字保留**：前端与运维手册都按它检索） */
export const CONTRACT_AMOUNT_LOCKED_MESSAGE =
  '合同已生效，金额变更须走合同变更流程';

/** 客户变更的文案：必须说清"为什么不行"，而不是一句"当前状态不可操作" */
export const CONTRACT_CUSTOMER_LOCKED_MESSAGE =
  '合同已生效，客户不可变更（已开具的发票与已登记的应收挂在原客户上，变更后无法核销）';

/**
 * 该状态下这次 PATCH 是否被拒。
 *
 * @param status 库中该合同的**当前**状态（服务层已 `?? 'draft'` 兜底）
 * @param dto    请求体（`undefined` 的字段视为"本次不改"）
 * @returns 不允许时返回可直接抛出的**中文报错文案**；允许时返回 `null`
 */
export function contractUpdateBlockReason(
  status: string,
  dto: ContractUpdateFields
): string | null {
  if (CONTRACT_FROZEN_STATUSES.includes(status)) {
    if (CONTRACT_FROZEN_FIELDS.some((field) => dto[field] !== undefined)) {
      return CONTRACT_FROZEN_MESSAGE;
    }
  }
  if (status !== 'draft') {
    /*
     * 顺序有意如此：`amount` 在前。两者同时出现时先报金额 —— 它是合同变更流程的
     * 正式入口，比"客户不可改"更能指出下一步该做什么。
     * 判据是"字段出现即拒"（与既有 amount 守卫一致），**不是**"值变了才拒"：
     * 因此前端编辑弹窗只下发**改动过的**字段（见 `client/src/pages/contracts/contract-edit-model.ts`），
     * 否则"改个名称"也会连带把未改动的 customerId 发上来而被拒。
     */
    if (dto.amount !== undefined) return CONTRACT_AMOUNT_LOCKED_MESSAGE;
    if (dto.customerId !== undefined) return CONTRACT_CUSTOMER_LOCKED_MESSAGE;
  }
  return null;
}
