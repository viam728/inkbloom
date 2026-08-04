import axios from 'axios';

const apiClient = axios.create({
  baseURL: '/api/v1',
  headers: {
    Authorization: 'Bearer inkbloom-dev-token',
    'Content-Type': 'application/json',
  },
});

// 响应拦截器：提取 data 字段
apiClient.interceptors.response.use(
  (response) => response.data.data,
  (error) => {
    const msg = error.response?.data?.message || error.message;
    console.error('[API Error]', msg);
    return Promise.reject(error);
  }
);

export default apiClient;
