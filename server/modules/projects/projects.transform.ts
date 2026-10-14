import type {
  Project,
  ProjectStatus,
  ProjectStatusAction,
} from '@shared/api.interface';

export interface ProjectRowLike {
  id: string;
  code: string;
  name: string;
  contractId: string | null;
  wonQuotationId?: string | null;
  pm: string | null;
  pmUserId?: string | null;
  deptName: string | null;
  budget: string | null;
  estimatedTotalCost: string;
  startDate: string | null;
  endDate: string | null;
  progress: number | null;
  status: string | null;
  remark: string | null;
  closeSummary: string | null;
  satisfaction: number | null;
  retrospective: string | null;
  closedAt: string | null;
  createdAt: Date;
}

export interface ProjectQuoteExtra {
  wonQuotationCode?: string | null;
  wonQuotationTitle?: string | null;
  wonQuotationAmount?: number | null;
  opportunityId?: string | null;
  opportunityTitle?: string | null;
}

export function toProject(
  row: ProjectRowLike,
  contractName: string,
  extra: ProjectQuoteExtra = {},
): Project {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    contractId: row.contractId ?? '',
    contractName,
    wonQuotationId: row.wonQuotationId ?? null,
    wonQuotationCode: extra.wonQuotationCode ?? null,
    wonQuotationTitle: extra.wonQuotationTitle ?? null,
    wonQuotationAmount: extra.wonQuotationAmount ?? null,
    opportunityId: extra.opportunityId ?? null,
    opportunityTitle: extra.opportunityTitle ?? null,
    pm: row.pm,
    pmUserId: row.pmUserId ?? null,
    deptName: row.deptName,
    budget: Number(row.budget ?? 0),
    estimatedTotalCost: Number(row.estimatedTotalCost ?? 0),
    startDate: row.startDate,
    endDate: row.endDate,
    progress: row.progress ?? 0,
    status: (row.status ?? 'initiating') as ProjectStatus,
    remark: row.remark,
    closeSummary: row.closeSummary,
    satisfaction: row.satisfaction,
    retrospective: row.retrospective,
    closedAt: row.closedAt,
    createdAt: row.createdAt.toISOString(),
  };
}

export const PROJECT_STATUS_FLOW: Record<
  ProjectStatusAction,
  { from: ProjectStatus[]; to: ProjectStatus }
> = {
  approve: { from: ['initiating'], to: 'executing' },
  deliver: { from: ['executing'], to: 'delivering' },
  accept: { from: ['delivering'], to: 'accepting' },
  close: { from: ['accepting'], to: 'closed' },
};
