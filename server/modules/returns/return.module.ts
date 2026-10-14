import { Module } from '@nestjs/common';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { ReturnController } from './return.controller';
import { ReturnService } from './return.service';

/**
 * C-05：采购/销售退货闭环。
 *
 * 挂在 `api/returns` 下（采购与销售退货共用一套状态机与动作语义，
 * 分开成两个模块会导致状态机实现漂移）。
 * 会计口径在 `server/common/tax/return-rules.ts`（纯函数 + 单测）。
 */
@Module({
  imports: [VoucherModule],
  controllers: [ReturnController],
  providers: [ReturnService],
  exports: [ReturnService],
})
export class ReturnModule {}
