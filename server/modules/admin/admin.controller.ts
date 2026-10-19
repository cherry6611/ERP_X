import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { CanCapability, NeedLogin } from '@server/platform';
import { AdminRead } from '@server/common/auth/read-roles';
import { IsBoolean } from 'class-validator';
import type { Request } from 'express';
import type {
  AdminAffairItem,
  AdminAssetItem,
  AdminBillItem,
  AdminBillStats,
  AdminRentContractAction,
  AdminRentContractItem,
  AdminRentContractStats,
  AutomationConfigItem,
  PagedResult,
  VoucherJobQueueSummary,
} from '@shared/api.interface';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { AutomationConfigService } from './automation-config.service';
import { AdminService } from './admin.service';
import {
  AdminBillActionDto,
  CreateAdminAffairDto,
  CreateAdminAssetDto,
  CreateAdminBillDto,
  CreateAdminRentContractDto,
  UpdateAdminAffairDto,
  UpdateAdminAssetDto,
  UpdateAdminBillDto,
  UpdateAdminRentContractDto,
} from './dto';

class UpdateAutomationConfigBody {
  @IsBoolean()
  enabled!: boolean;
}

@NeedLogin()
@Controller('api/admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly automationConfigService: AutomationConfigService,
    private readonly voucherHook: VoucherHookService,
  ) {}

  /* ========== 自动化任务开关 ========== */

  @Get('automation-config')
  async listAutomationConfig(): Promise<AutomationConfigItem[]> {
    return this.automationConfigService.listAll();
  }

  @Get('voucher-jobs')
  async voucherJobQueue(): Promise<VoucherJobQueueSummary> {
    return this.voucherHook.summarizeQueue();
  }

  @CanCapability('admin_ops')
  @Put('automation-config/:taskKey')
  async updateAutomationConfig(
    @Param('taskKey') taskKey: string,
    @Body() dto: UpdateAutomationConfigBody,
    @Req() req: Request
  ): Promise<AutomationConfigItem> {
    return this.automationConfigService.setEnabled(
      taskKey,
      dto.enabled,
      req.userContext?.userId ?? ''
    );
  }

  /* ========== 租房合同 ========== */

  @AdminRead()
  @Get('rent-contracts/stats')
  async getRentContractStats(): Promise<AdminRentContractStats> {
    return this.adminService.getRentContractStats();
  }

  @AdminRead()
  @Get('rent-contracts')
  async listRentContracts(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string
  ): Promise<PagedResult<AdminRentContractItem>> {
    return this.adminService.listRentContracts(
      page ? Math.max(1, parseInt(page, 10) || 1) : 1,
      pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20)) : 20,
      status || undefined
    );
  }

  @CanCapability('admin_ops')
  @Post('rent-contracts')
  async createRentContract(
    @Body() dto: CreateAdminRentContractDto
  ): Promise<AdminRentContractItem> {
    return this.adminService.createRentContract(dto);
  }

  @CanCapability('admin_ops')
  @Patch('rent-contracts/:id')
  async updateRentContract(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminRentContractDto
  ): Promise<AdminRentContractItem> {
    return this.adminService.updateRentContract(id, dto);
  }

  @CanCapability('admin_ops')
  @Post('rent-contracts/:id/actions/:action')
  async rentContractAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: AdminRentContractAction
  ): Promise<AdminRentContractItem> {
    return this.adminService.rentContractAction(id, action);
  }

  /* ========== 行政缴费 ========== */

  @AdminRead()
  @Get('bills/stats')
  async getBillStats(): Promise<AdminBillStats> {
    return this.adminService.getBillStats();
  }

  @AdminRead()
  @Get('bills')
  async listBills(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('billType') billType?: string,
    @Query('period') period?: string,
    @Query('status') status?: string
  ): Promise<PagedResult<AdminBillItem>> {
    return this.adminService.listBills(
      page ? Math.max(1, parseInt(page, 10) || 1) : 1,
      pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20)) : 20,
      billType || undefined,
      period || undefined,
      status || undefined
    );
  }

  @CanCapability('admin_ops')
  @Post('bills')
  async createBill(
    @Body() dto: CreateAdminBillDto
  ): Promise<AdminBillItem> {
    return this.adminService.createBill(dto);
  }

  @CanCapability('admin_ops')
  @Patch('bills/:id')
  async updateBill(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminBillDto
  ): Promise<AdminBillItem> {
    return this.adminService.updateBill(id, dto);
  }

  @CanCapability('admin_ops')
  @Post('bills/:id/actions/submit')
  async submitBill(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<AdminBillItem> {
    return this.adminService.billAction(id, 'submit', {});
  }

  @CanCapability('admin_ops')
  @Post('bills/:id/actions/approve')
  async approveBill(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<AdminBillItem> {
    return this.adminService.billAction(id, 'approve', {});
  }

  @CanCapability('admin_ops')
  @Post('bills/:id/actions/reject')
  async rejectBill(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminBillActionDto
  ): Promise<AdminBillItem> {
    return this.adminService.billAction(id, 'reject', dto);
  }

  @CanCapability('admin_ops')
  @Post('bills/:id/actions/pay')
  async payBill(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminBillActionDto
  ): Promise<AdminBillItem> {
    return this.adminService.billAction(id, 'pay', dto);
  }

  /* ========== 行政资产 ========== */

  @AdminRead()
  @Get('assets')
  async listAssets(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('category') category?: string,
    @Query('status') status?: string
  ): Promise<PagedResult<AdminAssetItem>> {
    return this.adminService.listAssets(
      page ? Math.max(1, parseInt(page, 10) || 1) : 1,
      pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20)) : 20,
      category || undefined,
      status || undefined
    );
  }

  @CanCapability('admin_ops')
  @Post('assets')
  async createAsset(
    @Body() dto: CreateAdminAssetDto
  ): Promise<AdminAssetItem> {
    return this.adminService.createAsset(dto);
  }

  @CanCapability('admin_ops')
  @Patch('assets/:id')
  async updateAsset(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminAssetDto
  ): Promise<AdminAssetItem> {
    return this.adminService.updateAsset(id, dto);
  }

  @CanCapability('admin_ops')
  @Delete('assets/:id')
  async deleteAsset(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<void> {
    return this.adminService.deleteAsset(id);
  }

  /* ========== 车辆/差旅事务 ========== */

  @AdminRead()
  @Get('affairs')
  async listAffairs(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('affairType') affairType?: string,
    @Query('status') status?: string
  ): Promise<PagedResult<AdminAffairItem>> {
    return this.adminService.listAffairs(
      page ? Math.max(1, parseInt(page, 10) || 1) : 1,
      pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20)) : 20,
      affairType || undefined,
      status || undefined
    );
  }

  @CanCapability('admin_ops')
  @Post('affairs')
  async createAffair(
    @Body() dto: CreateAdminAffairDto
  ): Promise<AdminAffairItem> {
    return this.adminService.createAffair(dto);
  }

  @CanCapability('admin_ops')
  @Patch('affairs/:id')
  async updateAffair(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminAffairDto
  ): Promise<AdminAffairItem> {
    return this.adminService.updateAffair(id, dto);
  }

  @CanCapability('admin_ops')
  @Post('affairs/:id/actions/settle')
  async settleAffair(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<AdminAffairItem> {
    return this.adminService.affairAction(id, 'settle');
  }

  @CanCapability('admin_ops')
  @Delete('affairs/:id')
  async deleteAffair(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<void> {
    return this.adminService.deleteAffair(id);
  }
}
