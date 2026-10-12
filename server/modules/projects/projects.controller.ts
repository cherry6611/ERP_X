import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CanRole, NeedLogin } from '@server/platform';
import { ProjectWrite } from '@server/common/auth/read-roles';
import { actorFromRequest } from '@server/common/auth/actor';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ProjectsService } from './projects.service';
import { ProjectsStatusService } from './projects-status.service';
import { DeliverableService } from './deliverable.service';
import { MinutesService } from './minutes.service';
import { ProjectArchiveService } from './project-archive.service';
import { ProjectAclService } from './project-acl.service';
import type {
  AcceptDeliverableDto,
  CreateDeliverableDto,
  CreateProjectChangeDto,
  CreateProjectDto,
  CreateProjectMilestoneDto,
  CreateProjectMinutesDto,
  CreateProjectRevenueDto,
  DeliverableItem,
  Project,
  ProjectAccounting,
  ProjectChainOverview,
  ProjectDriveSyncResult,
  ProjectDriveSyncStatus,
  ProjectChange,
  ProjectDetail,
  ProjectMilestone,
  ProjectMinutes,
  ProjectRevenueItem,
  ProjectStatus,
  ProjectStatusAction,
  UpdateDeliverableDto,
  UpdateProjectDto,
} from '@shared/api.interface';

export class ProjectStatusActionDto {
  @IsString()
  @IsIn(['approve', 'deliver', 'accept', 'close'])
  action!: 'approve' | 'deliver' | 'accept' | 'close';

  @IsOptional()
  @IsString()
  closeSummary?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  satisfaction?: number;

  @IsOptional()
  @IsString()
  retrospective?: string;
}

export class ReturnDeliverableDto {
  @IsString()
  reason!: string;
}

export class ApproveChangeDto {
  @IsString()
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject';
}

export class CreateProjectRevenueBodyDto implements CreateProjectRevenueDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}$/u, { message: '期间格式须为 YYYY-MM' })
  period!: string;

  @IsNumber()
  @Min(0.01, { message: '确认金额必须大于 0' })
  amount!: number;

  @IsOptional()
  @IsString()
  note?: string;
}

@NeedLogin()
@Controller('api/projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly projectsStatusService: ProjectsStatusService,
    private readonly deliverableService: DeliverableService,
    private readonly minutesService: MinutesService,
    private readonly projectArchiveService: ProjectArchiveService,
    private readonly projectAcl: ProjectAclService
  ) {}

  @Get()
  async listProjects(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string
  ): Promise<Project[]> {
    return this.projectsService.listProjects(
      status,
      keyword,
      actorFromRequest(req)
    );
  }

  @CanRole(['admin'])
  @Post()
  async createProject(@Body() dto: CreateProjectDto): Promise<ProjectDetail> {
    return this.projectsService.createProject(dto);
  }

  @Get('accounting/:id')
  async getAccounting(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<ProjectAccounting> {
    await this.projectAcl.assertVisible(id, actorFromRequest(req));
    return this.projectsService.getAccounting(id);
  }

  @Get('chain/:id')
  async getChainOverview(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<ProjectChainOverview> {
    await this.projectAcl.assertVisible(id, actorFromRequest(req));
    return this.projectsService.getChainOverview(id);
  }

  @Get(':id')
  async getProject(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<ProjectDetail> {
    await this.projectAcl.assertVisible(id, actorFromRequest(req));
    return this.projectsService.getProject(id);
  }

  @CanRole(['admin'])
  @Patch(':id')
  async updateProject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto
  ): Promise<Project> {
    return this.projectsService.updateProject(id, dto);
  }

  @CanRole(['admin'])
  @Post(':id/status')
  async changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProjectStatusActionDto
  ): Promise<Project> {
    return this.projectsStatusService.changeStatus(id, dto.action, dto);
  }

  @CanRole(['admin'])
  @Post(':id/milestones')
  async addMilestone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProjectMilestoneDto
  ): Promise<ProjectMilestone> {
    return this.projectsService.addMilestone(id, dto);
  }

  @CanRole(['admin'])
  @Patch('milestones/:id')
  async updateMilestone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: {
      status?: 'reached';
      actualDate?: string;
      forecastDate?: string;
      weightPct?: number;
      remark?: string;
    }
  ): Promise<ProjectMilestone> {
    return this.projectsService.updateMilestone(id, dto);
  }

  @CanRole(['admin'])
  @Post(':id/revenues')
  async createProjectRevenue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProjectRevenueBodyDto
  ): Promise<ProjectRevenueItem> {
    return this.projectsService.createProjectRevenue(id, dto);
  }

  @ProjectWrite()
  @Post(':id/changes')
  async createChange(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProjectChangeDto
  ): Promise<ProjectChange> {
    await this.projectAcl.assertEditable(id, actorFromRequest(req));
    return this.projectsService.createChange(id, dto);
  }

  @CanRole(['admin'])
  @Post(':id/deliverables')
  async createDeliverable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDeliverableDto
  ): Promise<DeliverableItem> {
    return this.deliverableService.create(id, dto);
  }

  @CanRole(['admin'])
  @Patch('deliverables/:id')
  async updateDeliverable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeliverableDto
  ): Promise<DeliverableItem> {
    return this.deliverableService.update(id, dto);
  }

  @CanRole(['admin'])
  @Post('deliverables/:id/submit')
  async submitDeliverable(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<DeliverableItem> {
    return this.deliverableService.submit(id);
  }

  @CanRole(['admin'])
  @Post('deliverables/:id/accept')
  async acceptDeliverable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptDeliverableDto
  ): Promise<DeliverableItem> {
    return this.deliverableService.accept(id, dto);
  }

  @CanRole(['admin'])
  @Post('deliverables/:id/return')
  async returnDeliverable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnDeliverableDto
  ): Promise<DeliverableItem> {
    return this.deliverableService.returnDeliverable(id, dto);
  }

  @CanRole(['admin'])
  @Post('changes/:id/approve')
  async approveChange(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveChangeDto
  ): Promise<ProjectChange> {
    return this.projectsService.approveChange(id, dto.action);
  }

  @Get(':id/minutes')
  async listMinutes(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<ProjectMinutes[]> {
    await this.projectAcl.assertVisible(id, actorFromRequest(req));
    return this.minutesService.listByProject(id);
  }

  @CanRole(['admin'])
  @Post(':id/minutes')
  async createMinutes(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProjectMinutesDto
  ): Promise<ProjectMinutes> {
    return this.minutesService.create(id, dto);
  }

  @CanRole(['admin'])
  @Delete('minutes/:id')
  async deleteMinutes(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.minutesService.remove(id);
  }

  @CanRole(['admin'])
  @Post(':id/sync-drive')
  async syncProjectDrive(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<ProjectDriveSyncResult> {
    return this.projectArchiveService.syncProjectFiles(id);
  }

  @Get(':id/sync-drive/status')
  async getProjectDriveSyncStatus(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<ProjectDriveSyncStatus> {
    await this.projectAcl.assertVisible(id, actorFromRequest(req));
    return this.projectArchiveService.getSyncStatus(id);
  }
}
