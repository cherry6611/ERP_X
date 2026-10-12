import { logger } from '@client/src/platform/logger';
import { axiosForBackend } from '@client/src/platform/request';


export * as masterDataApi from './master-data';
export * as crmApi from './crm';
export * as contractsApi from './contracts';
export * as projectsApi from './projects';
export * as costsApi from './costs';
export * as revenuesApi from './revenues';
export * as financeApi from './finance';
export * as biApi from './bi';
export * as auditApi from './audit';
export * as hrApi from './hr';
export * as finBudgetApi from './fin-budget';
export * as finExpenseApi from './fin-expense';
export * as purApi from './pur';
export * as assetApi from './asset';
export * as voucherApi from './voucher';
export * as dataAssetApi from './data-asset';
export * as notificationsApi from './notifications';
export * as attachmentsApi from './attachments';
export * as feishuSyncApi from './feishu-sync';
export * as adminApi from './admin';
export * as semanticApi from './semantic';
export * as feishuDriveApi from './feishu-drive';

// Add more API functions here, use axios instance (`axiosForBackend`) to make requests.
// 
// 使用示例：
// export async function getUserData(userId: string) {
//   try {
//     const response = await axiosForBackend({
//       url: `/api/users/${userId}`,
//       method: 'GET'
//     });
//     return response.data;
//   } catch (error) {
//     logger.error('获取用户数据失败', error);
//     throw error;
//   }
// }
