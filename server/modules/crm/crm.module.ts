import { Module } from '@nestjs/common';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { QuotationController } from './quotation.controller';
import { QuotationService } from './quotation.service';
import { QuotationImportService } from './quotation-import.service';
import { NotificationsModule } from '@server/modules/notifications/notifications.module';
import { TaxModule } from '@server/modules/tax/tax.module';
import { FeishuDriveModule } from '@server/modules/feishu-drive/feishu-drive.module';

@Module({
  imports: [NotificationsModule, FeishuDriveModule, TaxModule],
  controllers: [CrmController, QuotationController],
  providers: [CrmService, QuotationService, QuotationImportService],
})
export class CrmModule {}
