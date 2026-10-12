import { toast } from 'sonner';

const FORBIDDEN_MESSAGE = '无操作权限，请联系管理员分配角色';

interface ResponseWithStatus {
  status: number;
}

/**
 * 检查后端写接口响应是否为 403（无角色权限）。
 * 403 是正常 HTTP 响应、不会进 axios catch，需在 then 链路中显式检查。
 * 命中时 toast 提示并抛错，阻断后续成功逻辑（如 toast.success / reload）。
 */
export function ensureNotForbidden(response: ResponseWithStatus): void {
  if (response.status === 403) {
    toast.error(FORBIDDEN_MESSAGE);
    throw new Error(FORBIDDEN_MESSAGE);
  }
}
