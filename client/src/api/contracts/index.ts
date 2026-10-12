import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  BillableSummary,
  Calloff,
  Contract,
  ContractDetail,
  ContractListParams,
  ContractMilestone,
  ContractStatusAction,
  ContractVersion,
  CreateCalloffDto,
  CreateContractDto,
  CreateMilestoneDto,
  PagedResult,
  UpdateContractDto,
} from '@shared/api.interface';

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
  ensureNotForbidden(resp);
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
  ensureNotForbidden(resp);
  return resp.data;
}

export async function changeContractStatus(
  id: string,
  action: ContractStatusAction,
): Promise<Contract> {
  const resp = await axiosForBackend.post<Contract>(`/api/contracts/${id}/status`, { action });
  ensureNotForbidden(resp);
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
  ensureNotForbidden(resp);
  return resp.data;
}

export async function updateMilestone(
  milestoneId: string,
  dto: { status?: 'reached'; actualDate?: string; name?: string; amount?: number },
): Promise<ContractMilestone> {
  const resp = await axiosForBackend.patch<ContractMilestone>(
    `/api/contracts/milestones/${milestoneId}`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function createVersion(
  contractId: string,
  dto: { changeLog: string; newAmount?: number },
): Promise<ContractVersion> {
  const resp = await axiosForBackend.post<ContractVersion>(
    `/api/contracts/${contractId}/changes`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function createCalloff(contractId: string, dto: CreateCalloffDto): Promise<Calloff> {
  const resp = await axiosForBackend.post<Calloff>(`/api/contracts/${contractId}/calloffs`, dto);
  ensureNotForbidden(resp);
  return resp.data;
}
