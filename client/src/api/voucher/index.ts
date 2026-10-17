import { axiosForBackend } from '@client/src/platform/request';
import type {
  AccountItem,
  CreateAccountDto,
  SetAccountStatusDto,
  CreateVoucherDto,
  ListAccountParams,
  ListVoucherParams,
  PagedResult,
  PeriodStatus,
  UnassignedEntityCheckResult,
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
  return resp.data;
}

export async function voucherAction(
  id: string,
  action: VoucherAction,
): Promise<VoucherItem> {
  const resp = await axiosForBackend.post<VoucherItem>(
    `/api/voucher/vouchers/${id}/actions/${action}`,
  );
  return resp.data;
}

/* ========== 期间 ========== */

export async function listPeriods(): Promise<PeriodStatus[]> {
  const resp = await axiosForBackend.get<PeriodStatus[]>('/api/voucher/periods');
  return resp.data;
}

/**
 * B-1 / REQ-BE-01：凭证主体归属自检。
 *
 * 未归属纳税主体的凭证**不会出现在任何主体的报表里**，必须由界面显式提示。
 * 不传 `period` 时返回全量缺口（跨期间）。
 */
export async function checkUnassignedEntity(params: {
  period?: string;
  sourceType?: string;
} = {}): Promise<UnassignedEntityCheckResult> {
  const resp = await axiosForBackend.get<UnassignedEntityCheckResult>(
    '/api/voucher/unassigned-entity',
    {
      params: {
        ...(params.period ? { period: params.period } : {}),
        ...(params.sourceType ? { sourceType: params.sourceType } : {}),
      },
    },
  );
  return resp.data;
}

export async function closePeriod(period: string): Promise<PeriodStatus> {
  const resp = await axiosForBackend.post<PeriodStatus>(
    `/api/voucher/periods/${period}/close`,
  );
  return resp.data;
}

export async function unclosePeriod(
  period: string,
  remark?: string,
): Promise<PeriodStatus> {
  const resp = await axiosForBackend.post<PeriodStatus>(
    `/api/voucher/periods/${period}/unclose`,
    { remark },
  );
  return resp.data;
}

/**
 * A-09：科目启用/停用。
 *
 * `inactive` 的科目不接受新凭证；其历史余额仍会出现在报表中。
 * 后端会拒绝停用「有下级科目」或「已有凭证发生额」的科目。
 */
export async function setAccountStatus(
  code: string,
  dto: SetAccountStatusDto,
): Promise<AccountItem> {
  const resp = await axiosForBackend.post<AccountItem>(
    `/api/voucher/accounts/${encodeURIComponent(code)}/status`,
    dto,
  );
  return resp.data;
}