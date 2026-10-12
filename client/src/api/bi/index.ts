import { axiosForBackend } from '@client/src/platform/request';
import type {
  AlertsResult,
  BiOverview,
  BiProjectCostBreakdownItem,
  CustomerContribution,
  MonthlyTrend,
  ProjectFinancialHealthSummary,
  ProjectMargin,
} from '@shared/api.interface';

export async function getBiOverview(): Promise<BiOverview> {
  const resp = await axiosForBackend.get<BiOverview>('/api/bi/overview');
  return resp.data;
}

export async function getProjectMargins(): Promise<ProjectMargin[]> {
  const resp = await axiosForBackend.get<ProjectMargin[]>('/api/bi/project-margins');
  return resp.data;
}

export async function getProjectCostBreakdown(
  projectId: string
): Promise<BiProjectCostBreakdownItem[]> {
  const resp = await axiosForBackend.get<BiProjectCostBreakdownItem[]>(
    `/api/bi/projects/${projectId}/cost-breakdown`
  );
  return resp.data;
}

export async function getProjectFinancialHealth(): Promise<ProjectFinancialHealthSummary> {
  const resp = await axiosForBackend.get<ProjectFinancialHealthSummary>(
    '/api/bi/project-financial-health',
  );
  return resp.data;
}

export async function getCustomerContributions(): Promise<CustomerContribution[]> {
  const resp = await axiosForBackend.get<CustomerContribution[]>('/api/bi/customer-contributions');
  return resp.data;
}

export async function getMonthlyTrends(): Promise<MonthlyTrend[]> {
  const resp = await axiosForBackend.get<MonthlyTrend[]>('/api/bi/monthly-trends');
  return resp.data;
}

export async function getAlerts(): Promise<AlertsResult> {
  const resp = await axiosForBackend.get<AlertsResult>('/api/bi/alerts');
  return resp.data;
}
