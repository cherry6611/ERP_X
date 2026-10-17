import { axiosForBackend } from '@client/src/platform/request';
import type {
  AlertsResult,
  BiAlertSubscriptionItem,
  BiMetric,
  BiMetricsResult,
  BiOverview,
  BiProjectCostBreakdownItem,
  CustomerContribution,
  MonthlyTrend,
  ProjectFinancialHealthSummary,
  ProjectMargin,
  TaxDistributionItem,
  UpsertBiAlertSubscriptionDto,
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

export async function getTaxDistribution(): Promise<TaxDistributionItem[]> {
  const resp = await axiosForBackend.get<TaxDistributionItem[]>(
    '/api/bi/tax-distribution'
  );
  return resp.data;
}

export async function getAlerts(): Promise<AlertsResult> {
  const resp = await axiosForBackend.get<AlertsResult>('/api/bi/alerts');
  return resp.data;
}

/* ========== D-12 指标中心与预警订阅 ========== */

export async function getMetrics(period?: string): Promise<BiMetricsResult> {
  const resp = await axiosForBackend.get<BiMetricsResult>('/api/bi/metrics', {
    params: period ? { period } : undefined,
  });
  return resp.data;
}

export async function getMetricDefinitions(): Promise<BiMetric[]> {
  const resp = await axiosForBackend.get<BiMetric[]>(
    '/api/bi/metric-definitions',
  );
  return resp.data;
}

export async function listAlertSubscriptions(): Promise<
  BiAlertSubscriptionItem[]
> {
  const resp = await axiosForBackend.get<BiAlertSubscriptionItem[]>(
    '/api/bi/alert-subscriptions',
  );
  return resp.data;
}

export async function upsertAlertSubscription(
  dto: UpsertBiAlertSubscriptionDto,
): Promise<BiAlertSubscriptionItem> {
  const resp = await axiosForBackend.post<BiAlertSubscriptionItem>(
    '/api/bi/alert-subscriptions',
    dto,
  );
  return resp.data;
}

export async function removeAlertSubscription(
  id: string,
): Promise<{ ok: true }> {
  const resp = await axiosForBackend.post<{ ok: true }>(
    `/api/bi/alert-subscriptions/${id}/delete`,
  );
  return resp.data;
}
