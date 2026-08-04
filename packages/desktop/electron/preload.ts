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
});
