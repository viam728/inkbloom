import { useEffect } from 'react';
import AppLayout from '@/components/layout/AppLayout';
import TaskStatusBar from '@/components/aigc/TaskStatusBar';
import { ToastProvider } from '@/components/common/Toast';
import { wsClient } from '@/services/ws-client';
// Ensure WebSocket event handlers are registered
import '@/stores/aigc-store';

const WS_URL = `ws://${window.location.hostname}:8080/ws?token=inkbloom-dev-token`;

function App() {
  useEffect(() => {
    wsClient.connect(WS_URL);
    return () => wsClient.disconnect();
  }, []);

  return (
    <ToastProvider>
      <div className="flex flex-col h-screen">
        <AppLayout />
        <TaskStatusBar />
      </div>
    </ToastProvider>
  );
}

export default App;
