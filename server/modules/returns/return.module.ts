import { Module } from '@nestjs/common';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
// P0-D：销售退货需同步登记红字发票，否则增值税底稿销项不冲减（多缴 + 账表永久差异）
import { FinanceModule } from '@server/modules/finance/finance.module';
import { ReturnController } from './return.controller';
import { ReturnService } from './return.service';

/**
 * C-05：采购/销售退货闭环。
 *
 * 挂在 `api/returns` 下（采购与销售退货共用一套状态机与动作语义，
 * 分开成两个模块会导致状态机实现漂移）。
 * 会计口径在 `server/common/tax/return-rules.ts`（纯函数 + 单测）。
 *
 * 依赖 `FinanceModule` 只为拿 `InvoiceService.createRedLetterInvoice`：
 * 退货的**账务侧**已由 `VoucherHookService` 处理（红字凭证），
 * **票务侧**（增值税申报口径）必须同时冲减，否则底稿每月必报 `output_mismatch`，
 * 且申报口径不冲减会直接导致**多缴增值税**。
 */
@Module({
  imports: [VoucherModule, FinanceModule],
  controllers: [ReturnController],
  providers: [ReturnService],
  exports: [ReturnService],
})
export class ReturnModule {}
