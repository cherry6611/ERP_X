import { axiosForBackend } from '@client/src/platform/request';
import type {
  BillableSummary,
  Calloff,
  Contract,
  ContractDetail,
  ContractItem,
  ContractListParams,
  ContractMilestone,
  ContractStatusAction,
  ContractVersion,
  CreateCalloffDto,
  CreateContractDto,
  CreateContractVersionDto,
  CreateMilestoneDto,
  PagedResult,
  UpdateContractDto,
  UpdateMilestoneDto,
} from '@shared/api.interface';

export type { ContractItem };

export async function listContracts(params?: ContractListParams): Promise<Contract[]> {
  const resp = await axiosForBackend.get<PagedResult<Contract>>('/api/contracts', {
    params: { page: 1, pageSize: 500, ...params },
  });
  return resp.data.items;
}

export async function listContractsPaged(
  page: number,
  pageSize: number,
  params?: ContractListParams,
): Promise<PagedResult<Contract>> {
  const resp = await axiosForBackend.get<PagedResult<Contract>>('/api/contracts', {
    params: { page, pageSize, ...params },
  });
  return resp.data;
}

export async function createContract(dto: CreateContractDto): Promise<Contract> {
  const resp = await axiosForBackend.post<Contract>('/api/contracts', dto);
  return resp.data;
}

export async function getContract(id: string): Promise<ContractDetail> {
  const resp = await axiosForBackend.get<ContractDetail>(`/api/contracts/${id}`);
  return resp.data;
}

export async function getBillable(id: string): Promise<BillableSummary> {
  const resp = await axiosForBackend.get<BillableSummary>(`/api/contracts/billable/${id}`);
  return resp.data;
}

export async function updateContract(id: string, dto: UpdateContractDto): Promise<Contract> {
  const resp = await axiosForBackend.patch<Contract>(`/api/contracts/${id}`, dto);
  return resp.data;
}

export async function changeContractStatus(
  id: string,
  action: ContractStatusAction,
): Promise<Contract> {
  const resp = await axiosForBackend.post<Contract>(`/api/contracts/${id}/status`, { action });
  return resp.data;
}

export async function addMilestone(
  contractId: string,
  dto: CreateMilestoneDto,
): Promise<ContractMilestone> {
  const resp = await axiosForBackend.post<ContractMilestone>(
    `/api/contracts/${contractId}/milestones`,
    dto,
  );
  return resp.data;
}

export async function updateMilestone(
  milestoneId: string,
  dto: UpdateMilestoneDto,
): Promise<ContractMilestone> {
  const resp = await axiosForBackend.patch<ContractMilestone>(
    `/api/contracts/milestones/${milestoneId}`,
    dto,
  );
  return resp.data;
}

export async function createVersion(
  contractId: string,
  dto: CreateContractVersionDto,
): Promise<ContractVersion> {
  const resp = await axiosForBackend.post<ContractVersion>(
    `/api/contracts/${contractId}/changes`,
    dto,
  );
  return resp.data;
}

export async function listContractItems(contractId: string): Promise<ContractItem[]> {
  const resp = await axiosForBackend.get<ContractItem[]>(
    `/api/contracts/${contractId}/items`
  );
  return resp.data;
}

export async function createContractItem(
  contractId: string,
  dto: {
    itemName: string;
    unit?: string;
    quantity: number;
    unitPrice: number;
    discountPct?: number;
    taxRate: number;
    estUnitCost?: number;
  }
): Promise<ContractItem> {
  const resp = await axiosForBackend.post<ContractItem>(
    `/api/contracts/${contractId}/items`,
    dto
  );
  return resp.data;
}

export async function deleteContractItem(
  contractId: string,
  itemId: string
): Promise<void> {
  await axiosForBackend.post(`/api/contracts/${contractId}/items/${itemId}/delete`);
}

export async function importQuotationItems(
  contractId: string,
  quotationId: string
): Promise<ContractItem[]> {
  const resp = await axiosForBackend.post<ContractItem[]>(
    `/api/contracts/${contractId}/items/import-quotation`,
    { quotationId }
  );
  return resp.data;
}

export async function createCalloff(contractId: string, dto: CreateCalloffDto): Promise<Calloff> {
  const resp = await axiosForBackend.post<Calloff>(`/api/contracts/${contractId}/calloffs`, dto);
  return resp.data;
}
