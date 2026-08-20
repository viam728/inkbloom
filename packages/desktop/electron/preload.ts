import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // 文件操作
  readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
  writeFile: (filePath: string, data: string) => ipcRenderer.invoke('file:write', filePath, data),
  selectDirectory: () => ipcRenderer.invoke('file:select-dir'),

  // 进程管理
  getServiceStatus: () => ipcRenderer.invoke('process:status'),
  restartService: (name: string) => ipcRenderer.invoke('process:restart', name),

  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (key: string, value: string) => ipcRenderer.invoke('config:set', key, value),

  // 应用
  getVersion: () => ipcRenderer.invoke('app:version'),
  getPlatform: () => process.platform,

  // 菜单事件（v2 §7.2）：主进程菜单 → 渲染进程弹窗
  onMenuOpenDataModal: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:open-data-modal', listener);
    return () => ipcRenderer.removeListener('menu:open-data-modal', listener);
  },
});
