import { Controller, Get, Post, Query } from '@nestjs/common';
import { CanCapability, NeedLogin } from '@server/platform';
import { FeishuSyncService } from './feishu-sync.service';
import type {
  FeishuSyncRecordItem,
  FeishuSyncResult,
  PagedResult,
} from '@shared/api.interface';

@NeedLogin()
@Controller('api/feishu-sync')
export class FeishuSyncController {
  constructor(private readonly feishuSyncService: FeishuSyncService) {}

  @CanCapability('drive_write')
  @Post('outbound/costs')
  async syncCostsToBase(): Promise<FeishuSyncResult> {
    return this.feishuSyncService.syncCostsToBase();
  }

  @CanCapability('drive_write')
  @Post('outbound/contracts')
  async syncContractsToBase(): Promise<FeishuSyncResult> {
    return this.feishuSyncService.syncContractsToBase();
  }

  @CanCapability('drive_write')
  @Post('inbound/timesheets')
  async syncTimesheetsFromBase(): Promise<FeishuSyncResult> {
    return this.feishuSyncService.syncTimesheetsFromBase();
  }

  @CanCapability('drive_write')
  @Post('retry')
  async retry(@Query('bizType') bizType?: string): Promise<{ reset: number }> {
    return this.feishuSyncService.resetFailed(bizType === 'contract' ? 'contract' : 'cost');
  }

  @Get('records')
  async listRecords(
    @Query('direction') direction?: string,
    @Query('bizType') bizType?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ): Promise<PagedResult<FeishuSyncRecordItem>> {
    const pageNumber: number = Math.max(1, parseInt(page ?? '1', 10) || 1);
    const size: number = Math.min(
      100,
      Math.max(1, parseInt(pageSize ?? '20', 10) || 20)
    );
    return this.feishuSyncService.listSyncRecords(
      direction,
      bizType,
      pageNumber,
      size
    );
  }
}
