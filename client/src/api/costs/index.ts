import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  CostAllocation,
  CostDimension,
  CostDimensionSummary,
  CostItem,
  CostTypeSummary,
  CostAllocationBatchResult,
  CreateAllocationDto,
  CreateCostAllocationBatchDto,
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

export async function redFlushCost(id: string): Promise<CostItem> {
  const resp = await axiosForBackend.post<CostItem>(`/api/costs/${id}/red-flush`);
  ensureNotForbidden(resp);
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

/**
 * D-07：一笔公共成本按**权重**分摊到多个项目（一个请求生成 N 条分摊记录）。
 *
 * 金额由服务端用最大余数法计算，保证 `Σ amount === 请求的 amount`（到分）——
 * 前端**不要**自己算每项金额再逐笔提交：手工分摊的合计极易差 1 分，
 * 而分摊合计与被分摊总额不等会让凭证不平。
 */
export async function createAllocationBatch(
  dto: CreateCostAllocationBatchDto,
): Promise<CostAllocationBatchResult> {
  const resp = await axiosForBackend.post<CostAllocationBatchResult>(
    '/api/costs/allocations/batch',
    dto,
  );
  return resp.data;
}