import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  Contract,
  CreateLeadDto,
  CreateOpportunityDto,
  CreateQuotationDto,
  Lead,
  Opportunity,
  ParsedQuotationDraft,
  Quotation,
  QuotationListParams,
  QuotationStatus,
  UpdateLeadDto,
  UpdateOpportunityDto,
} from '@shared/api.interface';

export async function listLeads(status?: string): Promise<Lead[]> {
  const resp = await axiosForBackend.get<Lead[]>('/api/crm/leads', {
    params: status ? { status } : undefined,
  });
  return resp.data;
}

export async function createLead(dto: CreateLeadDto): Promise<Lead> {
  const resp = await axiosForBackend.post<Lead>('/api/crm/leads', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function updateLead(id: string, dto: UpdateLeadDto): Promise<Lead> {
  const resp = await axiosForBackend.patch<Lead>(`/api/crm/leads/${id}`, dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function listOpportunities(stage?: string): Promise<Opportunity[]> {
  const resp = await axiosForBackend.get<Opportunity[]>('/api/crm/opportunities', {
    params: stage ? { stage } : undefined,
  });
  return resp.data;
}

export async function createOpportunity(dto: CreateOpportunityDto): Promise<Opportunity> {
  const resp = await axiosForBackend.post<Opportunity>('/api/crm/opportunities', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function updateOpportunity(id: string, dto: UpdateOpportunityDto): Promise<Opportunity> {
  const resp = await axiosForBackend.patch<Opportunity>(`/api/crm/opportunities/${id}`, dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function convertOpportunity(id: string): Promise<Contract> {
  const resp = await axiosForBackend.post<Contract>(`/api/crm/opportunities/${id}/convert`);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function listQuotations(
  params?: QuotationListParams,
): Promise<Quotation[]> {
  const resp = await axiosForBackend.get<Quotation[]>('/api/crm/quotations', {
    params,
  });
  return resp.data;
}

export async function parseQuotationDoc(docUrl: string): Promise<ParsedQuotationDraft> {
  const resp = await axiosForBackend.post<ParsedQuotationDraft>(
    '/api/crm/quotations/parse-doc',
    { docUrl },
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function createQuotation(dto: CreateQuotationDto): Promise<Quotation> {
  const resp = await axiosForBackend.post<Quotation>('/api/crm/quotations', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function getQuotation(id: string): Promise<Quotation> {
  const resp = await axiosForBackend.get<Quotation>(`/api/crm/quotations/${id}`);
  return resp.data;
}

export async function updateQuotation(
  id: string,
  dto: CreateQuotationDto,
): Promise<Quotation> {
  const resp = await axiosForBackend.patch<Quotation>(`/api/crm/quotations/${id}`, dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function submitQuotation(id: string): Promise<Quotation> {
  const resp = await axiosForBackend.post<Quotation>(`/api/crm/quotations/${id}/submit`);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function approveQuotation(id: string): Promise<Quotation> {
  const resp = await axiosForBackend.post<Quotation>(`/api/crm/quotations/${id}/approve`);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function rejectQuotation(id: string): Promise<Quotation> {
  const resp = await axiosForBackend.post<Quotation>(`/api/crm/quotations/${id}/reject`);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function voidQuotation(id: string): Promise<Quotation> {
  const resp = await axiosForBackend.post<Quotation>(`/api/crm/quotations/${id}/void`);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function convertQuotation(id: string): Promise<Contract> {
  const resp = await axiosForBackend.post<Contract>(`/api/crm/quotations/${id}/convert`);
  ensureNotForbidden(resp);
  return resp.data;
}
