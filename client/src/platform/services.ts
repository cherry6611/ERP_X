export type AccountType = 'apaas' | 'lark';

export interface I18nText {
  zh_cn: string;
  en_us?: string;
  ja_jp?: string;
}

export type UserType = '_employee' | '_externalUser' | '_anonymousUser';

export interface UserInfo {
  userID: string;
  larkUserID?: string;
  name: I18nText;
  avatar?: string;
  userType?: UserType;
  email?: string;
  department?: DepartmentInfo;
  tenantName?: string;
}

export interface SearchAvatar {
  avatar?: { image?: { large?: string } };
}

export interface DepartmentInfo {
  departmentID: string;
  larkDepartmentID: string;
  name: I18nText;
}

export interface SearchUsersParams {
  query: string;
  pageSize?: number;
  searchExternalContact?: boolean;
}

export interface SearchUsersResponse {
  data?: { userList?: UserInfo[] };
}

export interface BatchGetUsersResponse {
  data?: { userInfoMap?: Record<string, UserInfo> };
}

export interface SearchDepartmentsParams {
  query: string;
  pageSize?: number;
}

export interface SearchDepartmentsResponse {
  data?: { departmentList?: DepartmentInfo[] };
}

export interface ChatInfo {
  chatID: string;
  name: I18nText;
  avatar: string;
  isExternal?: boolean;
}

export interface SearchChatsParams {
  query: string;
  pageSize?: number;
}

export interface SearchChatsResponse {
  data?: { result?: { chatResult?: { items?: ChatInfo[] } } };
}

export interface ConvertExternalContactResponse {
  data?: { userInfo?: { userID?: string } };
}

export interface BatchGetChatsResponse {
  data?: { chatInfoMap?: Record<string, ChatInfo> };
}

export interface UserProfileData {
  useLarkCard: false;
  userProfileInfo: {
    name?: string;
    avatar?: string;
    email?: string;
    userStatus: number;
    userType: '_employee' | '_externalUser';
  };
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, { credentials: 'include', ...init });
  if (!resp.ok) throw new Error(`请求失败 ${resp.status}`);
  return (await resp.json()) as T;
}

export class UserService {
  async searchUsers(params: SearchUsersParams): Promise<SearchUsersResponse> {
    const query = new URLSearchParams({
      query: params.query,
      pageSize: String(params.pageSize ?? 20),
    });
    return getJson(`/api/users/search?${query.toString()}`);
  }

  async listUsersByIds(userIds: string[]): Promise<BatchGetUsersResponse> {
    return getJson('/api/users/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: userIds }),
    });
  }

  async convertExternalContact(_larkUserID?: string): Promise<ConvertExternalContactResponse> {
    return { data: { userInfo: { userID: _larkUserID } } };
  }
}

export class DepartmentService {
  async searchDepartments(params: SearchDepartmentsParams): Promise<SearchDepartmentsResponse> {
    const query = new URLSearchParams({
      query: params.query,
      pageSize: String(params.pageSize ?? 20),
    });
    return getJson(`/api/departments/search?${query.toString()}`);
  }
}

export class UserProfileService {
  async getUserProfile(userId: string, _accountType?: string, _signal?: AbortSignal): Promise<UserProfileData> {
    return getJson(`/api/users/${encodeURIComponent(userId)}/profile`);
  }
}

export class ChatService {
  async searchChats(_params?: SearchChatsParams): Promise<SearchChatsResponse> {
    return { data: { result: { chatResult: { items: [] } } } };
  }

  async listChatsByIds(_ids?: string[]): Promise<BatchGetChatsResponse> {
    return { data: { chatInfoMap: {} } };
  }
}

/*
 * `getAssetsUrl` 从 `./static-assets` 再导出（**不是** `./env`）。
 *
 * 原先这里写的是 `export { getAssetsUrl } from './env'`，而 `env.ts` 里
 * `getEnv()` 用了 `import.meta.env.MODE` —— 这行再导出把 `import.meta`
 * 传染给了整条 barrel，使**任何间接 import `UserDisplay` 的纯逻辑模块
 * 都无法被 jest 加载**（`tsconfig.test.json` 是 CommonJS，`import.meta`
 * 只在 es2020+ 合法，报 TS1343）。§5.9 / F8 的拆分中这条链实际挡下过工作。
 *
 * ⚠️ 不要改回 `./env`。`env.ts` 里那个 `getEnv()` 全仓 0 调用方。
 */
export { getAssetsUrl } from './static-assets';
