/**
 * 附加税费「六税两费减半」适用性判定（供增值税申报底稿接线 `computeVatSurcharge` 用）。
 *
 * ## 政策依据
 *
 * 财政部 税务总局公告 2023 年第 12 号（执行期 2023-01-01 至 2027-12-31）：
 * 对**增值税小规模纳税人 / 小型微利企业 / 个体工商户**减半征收
 * 城建税、教育费附加、地方教育附加。三类身份**任居其一**即适用。
 *
 * ## 为什么拆成独立纯函数
 *
 * 这条判定处在「政策口径 → 真金白银」的接缝上，必须能被单测直接覆盖，
 * 而不是埋在 service 里靠 DB 集成测试间接验证（本项目不猜测、不拍脑袋，
 * 判定逻辑就要能用断言钉死）。放在这里也便于指标数据源补齐后单点扩展。
 *
 * ## 边界（重要，不得自行扩大）
 *
 * 1. **小规模纳税人**：只看 `md_tax_entity.taxpayer_type`（增值税纳税人资格），
 *    CHECK 约束取值 `'general' | 'small'`（schema.ts:2625）。不需要任何小微指标
 *    → 数据齐备，直接判定，安全。
 * 2. **一般纳税人 + 小型微利企业**：同样适用减半，但须按「应纳税所得额 / 从业人数 /
 *    资产总额」三项指标判定。当前主体资料没有这些数据 → 本函数**返回 false**
 *    （不减半）。这是有意的**偏严（多计提）**方向：多提不会漏缴，少提才是事故。
 *    待指标数据源补齐后再接线，**不得在此猜测**。
 * 3. `taxpayer_type`（增值税资格）与企业所得税「小型微利企业」是两套标准，
 *    不得互相代理 —— 这也是本函数只按第 1 条判定的原因。
 * 4. 未指定主体 / 取到未知值 → 返回 false（不减半），不猜。
 */

/**
 * 由主体的增值税纳税人资格推导 `computeVatSurcharge` 的 `sixTaxTwoFeeHalved`。
 *
 * @param taxpayerType `md_tax_entity.taxpayer_type`；null / undefined 表示未指定主体。
 * @returns true = 适用六税两费减半；false = 不适用（或无法判定，按偏严处理）。
 */
export function resolveSixTaxTwoFeeHalved(
  taxpayerType?: string | null
): boolean {
  return taxpayerType === 'small';
}
