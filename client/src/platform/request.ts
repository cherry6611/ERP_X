import axios from 'axios';

export const axiosForBackend = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '',
  withCredentials: true,
});

axiosForBackend.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    if (status === 401 && !window.location.pathname.startsWith('/login')) {
      window.location.assign('/login');
    }
    return Promise.reject(error);
  },
);
