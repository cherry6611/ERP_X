import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  CostAllocation,
  CostDimension,
  CostDimensionSummary,
  CostItem,
  CostTypeSummary,
  CreateAllocationDto,
  CreateCostDto,
  CreateLaborRateDto,
  CreateTimesheetDto,
  LaborRate,
  Timesheet,
  TimesheetAction,
} from '@shared/api.interface';

export async function listCosts(projectId?: string, costType?: string): Promise<CostItem[]> {
  const resp = await axiosForBackend.get<CostItem[]>('/api/costs', {
    params: { projectId, costType },
  });
  return resp.data;
}

export async function getCostSummary(projectId?: string): Promise<CostTypeSummary[]> {
  const resp = await axiosForBackend.get<CostTypeSummary[]>('/api/costs/summary', {
    params: projectId ? { projectId } : undefined,
  });
  return resp.data;
}

export const fetchCostDimensionSummary = async (
  dimension: CostDimension,
  projectId?: string,
): Promise<CostDimensionSummary[]> => {
  const resp = await axiosForBackend.get<CostDimensionSummary[]>(
    '/api/costs/dimension-summary',
    { params: { dimension, projectId } },
  );
  return resp.data;
};

export async function createCost(dto: CreateCostDto): Promise<CostItem> {
  const resp = await axiosForBackend.post<CostItem>('/api/costs', dto);
  return resp.data;
}

export async function listTimesheets(projectId?: string): Promise<Timesheet[]> {
  const resp = await axiosForBackend.get<Timesheet[]>('/api/costs/timesheets', {
    params: projectId ? { projectId } : undefined,
  });
  return resp.data;
}

export async function createTimesheet(dto: CreateTimesheetDto): Promise<Timesheet> {
  const resp = await axiosForBackend.post<Timesheet>('/api/costs/timesheets', dto);
  return resp.data;
}

export async function timesheetAction(id: string, action: TimesheetAction): Promise<Timesheet> {
  const resp = await axiosForBackend.post<Timesheet>(`/api/costs/timesheets/${id}/action`, {
    action,
  });
  return resp.data;
}

export async function listLaborRates(): Promise<LaborRate[]> {
  const resp = await axiosForBackend.get<LaborRate[]>('/api/costs/labor-rates');
  return resp.data;
}

export async function createLaborRate(dto: CreateLaborRateDto): Promise<LaborRate> {
  const resp = await axiosForBackend.post<LaborRate>('/api/costs/labor-rates', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function createAllocation(dto: CreateAllocationDto): Promise<CostAllocation> {
  const resp = await axiosForBackend.post<CostAllocation>('/api/costs/allocations', dto);
  return resp.data;
}
