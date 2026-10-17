/**
 * §5.9 拆分：「增值税底稿核心指标」卡片组从 `TaxDeclarationPage` 抽出。
 *
 * 抽出的收益：六张卡各自带一条**口径提示**（hint），这些提示是本页最容易被改错的部分：
 *   · 留抵来源必须可见（`confirmed_declaration` 权威 vs 总账推算**估数**）；
 *   · 应纳税额的可抵扣进项已按**勾选认证**过滤，未认证部分要单列；
 *   · 未开票收入是"已确认收入未开票"，税额需人工确认（不是系统算错了）。
 *
 * 把这些提示与对应数字放在同一个组件里，改数字口径时不至于漏改提示。
 */
import { FileText, Receipt, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import StatCard from '@client/src/components/erp/StatCard';
import type { VatDeclarationResult } from '@shared/api.interface';
import { formatMoney } from '@client/src/utils/format';

interface Props {
  data: VatDeclarationResult;
}

const VatSummaryCards: React.FC<Props> = ({ data }) => (
  <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
    <StatCard
      label="销项税额（发票台账口径）"
      value={formatMoney(data.outputTaxFromInvoices)}
      icon={TrendingUp}
      tone="primary"
      hint={`总账口径 ${formatMoney(data.outputTaxFromLedger)}`}
    />
    <StatCard
      label="进项税额"
      value={formatMoney(data.inputTaxFromInvoices)}
      icon={TrendingDown}
      tone="info"
      hint={`总账口径 ${formatMoney(data.inputTaxFromLedger)}`}
    />
    <StatCard
      label="上一期间未抵扣完的进项"
      value={formatMoney(data.previousCredit)}
      icon={Wallet}
      tone="neutral"
      hint={
        /* P0-B：留抵来源必须可见 —— 总账推算是**估数**，与已确认底稿权威性不同 */
        data.previousCreditSource === 'confirmed_declaration'
          ? '取自上一期间已确认底稿（权威）'
          : '上期底稿未确认，按总账推算（估数）'
      }
    />
    <StatCard
      label="本期应纳税额"
      value={formatMoney(data.payableTax)}
      icon={Receipt}
      tone={data.payableTax > 0 ? 'warning' : 'success'}
      hint={
        /* P0-A：可抵扣进项已按勾选认证过滤，未认证部分单列 */
        data.uncertifiedInputTax > 0
          ? `销项 − 已认证进项 − 留抵；另有 ${formatMoney(data.uncertifiedInputTax)} 待认证`
          : '销项 − 已认证进项 − 上期留抵'
      }
    />
    <StatCard
      label="期末留抵"
      value={formatMoney(data.closingCredit)}
      icon={Wallet}
      tone={data.closingCredit > 0 ? 'info' : 'neutral'}
      hint="结转下期继续抵扣"
    />
    <StatCard
      label="未开票收入（不含税）"
      value={formatMoney(data.unbilledRevenueNet)}
      icon={FileText}
      tone={data.unbilledRevenueNet > 0 ? 'warning' : 'neutral'}
      hint={
        data.unbilledRevenueNet > 0
          ? '已确认收入未开票，税额需人工确认'
          : '已确认收入与开票口径一致'
      }
    />
  </div>
);

export default VatSummaryCards;
