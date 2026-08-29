import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { installAnalyticsFlushHooks } from '@/services/analytics';

// 埋点兜底刷新（业务方案 v3 A40）：页面离开/隐藏时冲掉未上报队列
installAnalyticsFlushHooks();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
