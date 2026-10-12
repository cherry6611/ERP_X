import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  AccountItem,
  CreateAccountDto,
  CreateVoucherDto,
  ListAccountParams,
  ListVoucherParams,
  PagedResult,
  PeriodStatus,
  VoucherAction,
  VoucherItem,
} from '@shared/api.interface';

/* ========== 科目表 ========== */

export async function listAccounts(
  params: ListAccountParams,
): Promise<PagedResult<AccountItem>> {
  const resp = await axiosForBackend.get<PagedResult<AccountItem>>(
    '/api/voucher/accounts',
    {
      params: {
        page: params.page,
        pageSize: params.pageSize,
        ...(params.keyword ? { keyword: params.keyword } : {}),
      },
    },
  );
  return resp.data;
}

export async function createAccount(dto: CreateAccountDto): Promise<AccountItem> {
  const resp = await axiosForBackend.post<AccountItem>('/api/voucher/accounts', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

/* ========== 凭证 ========== */

export async function listVouchers(
  params: ListVoucherParams,
): Promise<PagedResult<VoucherItem>> {
  const resp = await axiosForBackend.get<PagedResult<VoucherItem>>(
    '/api/voucher/vouchers',
    {
      params: {
        page: params.page,
        pageSize: params.pageSize,
        ...(params.status ? { status: params.status } : {}),
        ...(params.period ? { period: params.period } : {}),
        ...(params.sourceType ? { sourceType: params.sourceType } : {}),
      },
    },
  );
  return resp.data;
}

export async function createVoucher(dto: CreateVoucherDto): Promise<VoucherItem> {
  const resp = await axiosForBackend.post<VoucherItem>('/api/voucher/vouchers', dto);
  ensureNotForbidden(resp);
  return resp.data;
}

export async function voucherAction(
  id: string,
  action: VoucherAction,
): Promise<VoucherItem> {
  const resp = await axiosForBackend.post<VoucherItem>(
    `/api/voucher/vouchers/${id}/actions/${action}`,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

/* ========== 期间 ========== */

export async function listPeriods(): Promise<PeriodStatus[]> {
  const resp = await axiosForBackend.get<PeriodStatus[]>('/api/voucher/periods');
  return resp.data;
}

export async function closePeriod(period: string): Promise<PeriodStatus> {
  const resp = await axiosForBackend.post<PeriodStatus>(
    `/api/voucher/periods/${period}/close`,
  );
  ensureNotForbidden(resp);
  return resp.data;
}
