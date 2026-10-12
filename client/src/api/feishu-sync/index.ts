import { axiosForBackend } from '@client/src/platform/request';
import type {
  FeishuSyncRecordItem,
  FeishuSyncResult,
  FetchSyncRecordsParams,
  PagedResult,
} from '@shared/api.interface';

/** 成本台账出向同步到飞书多维表格 */
export async function syncCostsToBase(): Promise<FeishuSyncResult> {
  const response = await axiosForBackend({
    url: '/api/feishu-sync/outbound/costs',
    method: 'POST',
  });
  return response.data as FeishuSyncResult;
}

/** 合同台账出向同步到飞书多维表格 */
export async function syncContractsToBase(): Promise<FeishuSyncResult> {
  const response = await axiosForBackend({
    url: '/api/feishu-sync/outbound/contracts',
    method: 'POST',
  });
  return response.data as FeishuSyncResult;
}

/** 从飞书多维表格导入灵活用工工时（生成草稿工时单） */
export async function syncTimesheetsFromBase(): Promise<FeishuSyncResult> {
  const response = await axiosForBackend({
    url: '/api/feishu-sync/inbound/timesheets',
    method: 'POST',
  });
  return response.data as FeishuSyncResult;
}

/** 分页查询同步记录 */
export async function fetchSyncRecords(
  params: FetchSyncRecordsParams
): Promise<PagedResult<FeishuSyncRecordItem>> {
  const response = await axiosForBackend({
    url: '/api/feishu-sync/records',
    method: 'GET',
    params: {
      direction: params.direction,
      bizType: params.bizType,
      page: params.page,
      pageSize: params.pageSize,
    },
  });
  return response.data as PagedResult<FeishuSyncRecordItem>;
}
