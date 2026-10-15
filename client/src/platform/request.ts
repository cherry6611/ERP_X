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
    return Promise.reject(error);
  },
);
