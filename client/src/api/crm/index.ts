import { axiosForBackend } from '@client/src/platform/request';
import type {
  Contract,
  CreateLeadDto,
  CreateOpportunityDto,
  CreateQuotationDto,
  Lead,
  Opportunity,
  OpportunityDetail,
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
  return resp.data;
}

export async function updateLead(id: string, dto: UpdateLeadDto): Promise<Lead> {
  const resp = await axiosForBackend.patch<Lead>(`/api/crm/leads/${id}`, dto);
  return resp.data;
}

export async function convertLead(id: string): Promise<Opportunity> {
  const resp = await axiosForBackend.post<Opportunity>(`/api/crm/leads/${id}/convert`);
  return resp.data;
}

export async function listOpportunities(stage?: string): Promise<Opportunity[]> {
  const resp = await axiosForBackend.get<Opportunity[]>('/api/crm/opportunities', {
    params: stage ? { stage } : undefined,
  });
  return resp.data;
}

export async function getOpportunity(id: string): Promise<OpportunityDetail> {
  const resp = await axiosForBackend.get<OpportunityDetail>(
    `/api/crm/opportunities/${id}`,
  );
  return resp.data;
}

export async function createOpportunity(dto: CreateOpportunityDto): Promise<Opportunity> {
  const resp = await axiosForBackend.post<Opportunity>('/api/crm/opportunities', dto);
  return resp.data;
}

export async function updateOpportunity(id: string, dto: UpdateOpportunityDto): Promise<Opportunity> {
  const resp = await axiosForBackend.patch<Opportunity>(`/api/crm/opportunities/${id}`, dto);
  return resp.data;
}

export async function convertOpportunity(id: string): Promise<Contract> {
  const resp = await axiosForBackend.post<Contract>(`/api/crm/opportunities/${id}/convert`);
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
  return resp.data;
}

export async function parseQuotationFile(file: File): Promise<ParsedQuotationDraft> {
  const form = new FormData();
  form.append('file', file);
  const resp = await axiosForBackend.post<ParsedQuotationDraft>(
    '/api/crm/quotations/parse-file',
    form,
  );
  return resp.data;
}

export async function getFeishuBitableMeta(): Promise<{
  configured: boolean;
  appToken?: string;
  tableId?: string;
  fieldMap: Record<string, string>;
}> {
  const resp = await axiosForBackend.get('/api/crm/quotations/feishu-bitable/meta');
  return resp.data;
}

export async function listFeishuBitableRecords(): Promise<{
  records: Array<{ recordId: string; fields: Record<string, unknown> }>;
}> {
  const resp = await axiosForBackend.get('/api/crm/quotations/feishu-bitable/records');
  return resp.data;
}

export async function previewFeishuBitable(
  recordIds: string[],
): Promise<ParsedQuotationDraft> {
  const resp = await axiosForBackend.post<ParsedQuotationDraft>(
    '/api/crm/quotations/feishu-bitable/preview',
    { recordIds },
  );
  return resp.data;
}

export async function createQuotation(dto: CreateQuotationDto): Promise<Quotation> {
  const resp = await axiosForBackend.post<Quotation>('/api/crm/quotations', dto);
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
  return resp.data;
}

export async function submitQuotation(id: string): Promise<Quotation> {
  const resp = await axiosForBackend.post<Quotation>(`/api/crm/quotations/${id}/submit`);
  return resp.data;
}

export async function approveQuotation(id: string): Promise<Quotation> {
  const resp = await axiosForBackend.post<Quotation>(`/api/crm/quotations/${id}/approve`);
  return resp.data;
}

export async function rejectQuotation(id: string): Promise<Quotation> {
  const resp = await axiosForBackend.post<Quotation>(`/api/crm/quotations/${id}/reject`);
  return resp.data;
}

export async function voidQuotation(id: string): Promise<Quotation> {
  const resp = await axiosForBackend.post<Quotation>(`/api/crm/quotations/${id}/void`);
  return resp.data;
}

export async function convertQuotation(id: string): Promise<Contract> {
  const resp = await axiosForBackend.post<Contract>(`/api/crm/quotations/${id}/convert`);
  return resp.data;
}
