import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
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
  ProjectChange,
  ProjectDetail,
  ProjectMilestone,
  ProjectMinutes,
  ProjectDriveSyncResult,
  ProjectDriveSyncStatus,
  ProjectListParams,
  ProjectRevenueItem,
  ProjectStatusAction,
  ProjectStatusCloseDto,
  ReturnDeliverableDto,
  UpdateDeliverableDto,
  UpdateProjectDto,
} from '@shared/api.interface';

export async function listProjects(params?: ProjectListParams): Promise<Project[]> {
  const resp = await axiosForBackend.get<Project[]>('/api/projects', { params });
  return resp.data;
}

export async function createProject(dto: CreateProjectDto): Promise<Project> {
  const resp = await axiosForBackend.post<Project>('/api/projects', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function getProjectAccounting(id: string): Promise<ProjectAccounting> {
  const resp = await axiosForBackend.get<ProjectAccounting>(`/api/projects/accounting/${id}`);
  return resp.data;
}

export async function getProject(id: string): Promise<ProjectDetail> {
  const resp = await axiosForBackend.get<ProjectDetail>(`/api/projects/${id}`);
  return resp.data;
}

export async function getProjectChain(id: string): Promise<ProjectChainOverview> {
  const resp = await axiosForBackend.get<ProjectChainOverview>(`/api/projects/chain/${id}`);
  return resp.data;
}

export async function updateProject(id: string, dto: UpdateProjectDto): Promise<Project> {
  const resp = await axiosForBackend.patch<Project>(`/api/projects/${id}`, dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function changeProjectStatus(
  id: string,
  action: ProjectStatusAction,
  closeDto?: ProjectStatusCloseDto,
): Promise<Project> {
  const resp = await axiosForBackend.post<Project>(`/api/projects/${id}/status`, {
    action,
    ...closeDto,
  });
  ensureNotForbidden(resp);
  return resp.data;
}

export async function addProjectMilestone(
  projectId: string,
  dto: CreateProjectMilestoneDto,
): Promise<ProjectMilestone> {
  const resp = await axiosForBackend.post<ProjectMilestone>(
    `/api/projects/${projectId}/milestones`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function updateProjectMilestone(
  milestoneId: string,
  dto: {
    status?: 'reached';
    actualDate?: string;
    forecastDate?: string;
    weightPct?: number;
    remark?: string;
  },
): Promise<ProjectMilestone> {
  const resp = await axiosForBackend.patch<ProjectMilestone>(
    `/api/projects/milestones/${milestoneId}`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function createProjectChange(
  projectId: string,
  dto: CreateProjectChangeDto,
): Promise<ProjectChange> {
  const resp = await axiosForBackend.post<ProjectChange>(`/api/projects/${projectId}/changes`, dto);
  return resp.data;
}

export async function approveProjectChange(
  changeId: string,
  action: 'approve' | 'reject',
): Promise<ProjectChange> {
  const resp = await axiosForBackend.post<ProjectChange>(`/api/projects/changes/${changeId}/approve`, {
    action,
  });
  ensureNotForbidden(resp);
  return resp.data;
}

export async function createDeliverable(
  projectId: string,
  dto: CreateDeliverableDto,
): Promise<DeliverableItem> {
  const resp = await axiosForBackend.post<DeliverableItem>(
    `/api/projects/${projectId}/deliverables`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function updateDeliverable(
  id: string,
  dto: UpdateDeliverableDto,
): Promise<DeliverableItem> {
  const resp = await axiosForBackend.patch<DeliverableItem>(
    `/api/projects/deliverables/${id}`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function submitDeliverable(id: string): Promise<DeliverableItem> {
  const resp = await axiosForBackend.post<DeliverableItem>(
    `/api/projects/deliverables/${id}/submit`,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function acceptDeliverable(
  id: string,
  dto: AcceptDeliverableDto,
): Promise<DeliverableItem> {
  const resp = await axiosForBackend.post<DeliverableItem>(
    `/api/projects/deliverables/${id}/accept`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function returnDeliverable(
  id: string,
  dto: ReturnDeliverableDto,
): Promise<DeliverableItem> {
  const resp = await axiosForBackend.post<DeliverableItem>(
    `/api/projects/deliverables/${id}/return`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function createProjectRevenue(
  projectId: string,
  dto: CreateProjectRevenueDto,
): Promise<ProjectRevenueItem> {
  const resp = await axiosForBackend.post<ProjectRevenueItem>(
    `/api/projects/${projectId}/revenues`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function listMinutes(projectId: string): Promise<ProjectMinutes[]> {
  const resp = await axiosForBackend.get<ProjectMinutes[]>(
    `/api/projects/${projectId}/minutes`,
  );
  return resp.data;
}

export async function createMinutes(
  projectId: string,
  dto: CreateProjectMinutesDto,
): Promise<ProjectMinutes> {
  const resp = await axiosForBackend.post<ProjectMinutes>(
    `/api/projects/${projectId}/minutes`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function deleteMinutes(id: string): Promise<void> {
  const resp = await axiosForBackend.delete(`/api/projects/minutes/${id}`);
  ensureNotForbidden(resp);
}

export async function syncProjectDrive(projectId: string): Promise<ProjectDriveSyncResult> {
  const resp = await axiosForBackend.post<ProjectDriveSyncResult>(
    `/api/projects/${projectId}/sync-drive`,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function getProjectDriveSyncStatus(
  projectId: string,
): Promise<ProjectDriveSyncStatus> {
  const resp = await axiosForBackend.get<ProjectDriveSyncStatus>(
    `/api/projects/${projectId}/sync-drive/status`,
  );
  return resp.data;
}
