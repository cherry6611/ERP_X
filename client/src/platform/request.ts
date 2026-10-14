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
    return Promise.reject(error);
  },
);
