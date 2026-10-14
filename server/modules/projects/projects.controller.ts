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
import { CanCapability, NeedLogin } from '@server/platform';
import { ProjectWrite } from '@server/common/auth/read-roles';
import { actorFromRequest } from '@server/common/auth/actor';
import { ProjectsService } from './projects.service';
import { ProjectsStatusService } from './projects-status.service';
import { DeliverableService } from './deliverable.service';
import { MinutesService } from './minutes.service';
import { ProjectArchiveService } from './project-archive.service';
import { ProjectAclService } from './project-acl.service';
import {
  AcceptDeliverableDto,
  ApproveChangeDto,
  CreateDeliverableDto,
  CreateProjectChangeDto,
  CreateProjectDto,
  CreateProjectMilestoneDto,
  CreateProjectMinutesDto,
  CreateProjectRevenueDto,
  ProjectMilestoneCloseDto,
  ProjectStatusActionDto,
  ReturnDeliverableDto,
  UpdateDeliverableDto,
  UpdateProjectDto,
} from './projects.dto';
import type {
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
} from '@shared/api.interface';

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

  @CanCapability('projects_write')
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

  @CanCapability('projects_write')
  @Patch(':id')
  async updateProject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto
  ): Promise<Project> {
    return this.projectsService.updateProject(id, dto);
  }

  @CanCapability('projects_write')
  @Post(':id/status')
  async changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProjectStatusActionDto
  ): Promise<Project> {
    return this.projectsStatusService.changeStatus(id, dto.action, dto);
  }

  @CanCapability('projects_write')
  @Post(':id/milestones')
  async addMilestone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProjectMilestoneDto
  ): Promise<ProjectMilestone> {
    return this.projectsService.addMilestone(id, dto);
  }

  @CanCapability('projects_write')
  @Patch('milestones/:id')
  async updateMilestone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProjectMilestoneCloseDto
  ): Promise<ProjectMilestone> {
    return this.projectsService.updateMilestone(id, dto);
  }

  @CanCapability('projects_write')
  @Post(':id/revenues')
  async createProjectRevenue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProjectRevenueDto
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

  @CanCapability('projects_write')
  @Post(':id/deliverables')
  async createDeliverable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDeliverableDto
  ): Promise<DeliverableItem> {
    return this.deliverableService.create(id, dto);
  }

  @CanCapability('projects_write')
  @Patch('deliverables/:id')
  async updateDeliverable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeliverableDto
  ): Promise<DeliverableItem> {
    return this.deliverableService.update(id, dto);
  }

  @CanCapability('projects_write')
  @Post('deliverables/:id/submit')
  async submitDeliverable(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<DeliverableItem> {
    return this.deliverableService.submit(id);
  }

  @CanCapability('projects_write')
  @Post('deliverables/:id/accept')
  async acceptDeliverable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptDeliverableDto
  ): Promise<DeliverableItem> {
    return this.deliverableService.accept(id, dto);
  }

  @CanCapability('projects_write')
  @Post('deliverables/:id/return')
  async returnDeliverable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnDeliverableDto
  ): Promise<DeliverableItem> {
    return this.deliverableService.returnDeliverable(id, dto);
  }

  @CanCapability('projects_write')
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

  @CanCapability('projects_write')
  @Post(':id/minutes')
  async createMinutes(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProjectMinutesDto
  ): Promise<ProjectMinutes> {
    return this.minutesService.create(id, dto);
  }

  @CanCapability('projects_write')
  @Delete('minutes/:id')
  async deleteMinutes(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.minutesService.remove(id);
  }

  @CanCapability('projects_write')
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
