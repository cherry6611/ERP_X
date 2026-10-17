import axios from 'axios';
import { clientBasePath, withBasePath } from '@client/src/utils/base-path';

export const axiosForBackend = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '',
  withCredentials: true,
});

axiosForBackend.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    // 透出后端中文错误原因（如凭证创建 400 的"非末级科目不可做账"），
    // 避免上层 toast 只显示 axios 默认的 "Request failed with status code 400"。
    const data = error?.response?.data;
    if (
      data &&
      typeof data === 'object' &&
      typeof (data as { message?: unknown }).message === 'string' &&
      (data as { message: string }).message
    ) {
      error.message = (data as { message: string }).message;
    }
    const loginPath = withBasePath('/login');
    const base = clientBasePath();
    const atLogin =
      window.location.pathname === loginPath ||
      window.location.pathname === `${loginPath}/` ||
      (base !== '/' && window.location.pathname === `${base}/login`);
    if (status === 401 && !atLogin) {
      window.location.assign(loginPath);
    }
    /*
     * P1-3：把后端的真实错误信息写回 error.message。
     *
     * 后端全局异常过滤器返回 { error: { code, message } }，但 axios 默认把
     * message 覆写成英文的 “Request failed with status code 400”，导致页面
     * 用 `err.message` 的 toast 只能显示英文，用户看不到后端的中文原因。
     * 在这里统一回填后，`getApiErrorMessage(err, ...)` 与历史遗留的
     * `err instanceof Error ? err.message : ...` 两种写法都能透出后端 message。
     */
    const backendMessage = error?.response?.data?.error?.message;
    if (
      error instanceof Error &&
      typeof backendMessage === 'string' &&
      backendMessage.length > 0
    ) {
      error.message = backendMessage;
    }

    /*
     * 403 的集中兜底。
     *
     * 原先这里之外还有一个 `ensureNotForbidden(response)`，在 141 个写接口里被调用，
     * 但它检查的是 axios **成功**响应（`response.status === 403` 永远为假 ——
     * 403 走的是本函数这个 reject 分支），因此 161 处调用全部是 no-op，
     * 「无操作权限，请联系管理员分配角色」这句提示从未出现过。
     * 现已删除该死代码，改为在本拦截器统一兜底：
     *   · 后端已有可读中文 message（例如数据权限的"没有查看该纳税主体的数据权限"）
     *     → 保留它，不覆盖（信息更具体）；
     *   · 后端 message 缺失或就是 axios 的英文默认串 → 换成可操作的中文提示。
     * 不在这里直接 toast，是为了避免与页面自身的错误处理重复弹出两个提示。
     */
    if (status === 403 && error instanceof Error) {
      const isDefaultEnglish = /^Request failed with status code \d+$/.test(
        error.message
      );
      if (isDefaultEnglish || !error.message) {
        error.message = '无操作权限，请联系管理员分配角色';
      }
    }
    return Promise.reject(error);
  },
);
