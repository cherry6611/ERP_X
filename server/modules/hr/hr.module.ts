import { Module } from '@nestjs/common';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
// B-02：数据级权限（行级可见范围）—— 员工档案与考勤按部门隔离
import { DataScopeService } from '@server/common/auth/data-scope.service';
import { HrCoreController } from './hr-core.controller';
import { HrPayController } from './hr-pay.controller';
import { HrSelfServiceController } from './hr-self-service.controller';
import { HrCoreService } from './hr-core.service';
import { HrPayService } from './hr-pay.service';
import { HrSelfServiceService } from './hr-self-service.service';
import { PayrollTaxService } from './payroll-tax.service';

@Module({
  imports: [VoucherModule],
  controllers: [HrCoreController, HrPayController, HrSelfServiceController],
  providers: [
    HrCoreService,
    HrPayService,
    HrSelfServiceService,
    PayrollTaxService,
    DataScopeService,
  ],
  /** F4X-13：飞书审批回调需复用工资/请假审批用例 */
  exports: [HrCoreService, HrPayService, PayrollTaxService],
})
export class HrModule {}
