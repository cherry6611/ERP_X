import { axiosForBackend } from '@client/src/platform/request';
import type {
  CreateRevenueAdjustDto,
  CreateRevenueDto,
  RevenueAdjust,
  RevenueItem,
  UnbilledItem,
} from '@shared/api.interface';

export async function listRevenues(projectId?: string, period?: string): Promise<RevenueItem[]> {
  const resp = await axiosForBackend.get<RevenueItem[]>('/api/revenues', {
    params: { projectId, period },
  });
  return resp.data;
}

export async function createRevenue(dto: CreateRevenueDto): Promise<RevenueItem> {
  const resp = await axiosForBackend.post<RevenueItem>('/api/revenues', dto);
  return resp.data;
}

export async function listUnbilled(): Promise<UnbilledItem[]> {
  const resp = await axiosForBackend.get<UnbilledItem[]>('/api/revenues/unbilled');
  return resp.data;
}

export async function listAdjusts(revenueId?: string): Promise<RevenueAdjust[]> {
  const resp = await axiosForBackend.get<RevenueAdjust[]>('/api/revenues/adjusts', {
    params: revenueId ? { revenueId } : undefined,
  });
  return resp.data;
}

export async function createAdjust(dto: CreateRevenueAdjustDto): Promise<RevenueAdjust> {
  const resp = await axiosForBackend.post<RevenueAdjust>('/api/revenues/adjusts', dto);
  return resp.data;
}
