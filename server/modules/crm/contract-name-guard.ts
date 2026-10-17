import { ConflictException } from '@nestjs/common';

/**
 * 「同名合同」拒绝（**报价转合同 / 商机转合同共用**）。
 *
 * ## 为什么要有这个函数
 *
 * 两条路径都会把 CRM 单据变成一个**同名**的 `erp_contract`：
 *   · `QuotationService.convert` —— 合同名取报价单标题；
 *   · `CrmService.convertToContract` —— 合同名取商机名称。
 *
 * 同名合同不是"重复一点点"，而是**同一笔生意在账上变成两笔**：
 * 两份合同都能各自立项、各自确认收入、各自开票，收入与应收直接翻倍。
 * 因此两边都必须拦，且必须是**同一句话**——否则使用者按 A 页面的提示去改，
 * 到 B 页面又对不上。
 *
 * 本轮走查实测的缺口：报价侧一直有查重（409），**商机侧从来没有**，
 * 于是"两个同标题商机 → 两份同名合同"可以静默发生。
 * 把判定与文案收在一处后，两边不会再分叉。
 *
 * ## 为什么返回异常而不是抛出
 *
 * 纯函数：只负责"造出一个 ConflictException"，不在内部读库、不写日志
 * —— 这样它的文案与判据可以被 spec 逐条断言，调用点仍决定**何时**抛。
 */
export function duplicateContractConflict(params: {
  /** 冲突的合同名（= 报价单标题 / 商机名称） */
  name: string;
  /** 已存在的合同编号，用于让人一眼定位到是哪一份 */
  existingCode: string;
  /** 来源单据的中文名，用于"请先修改 X 以区分"这句指引 */
  sourceLabel: string;
}): ConflictException {
  const { name, existingCode, sourceLabel } = params;
  return new ConflictException(
    `已存在同名合同「${name}」（${existingCode}），请确认后再转换；` +
      `如确需重复，请先修改${sourceLabel}以区分`
  );
}
