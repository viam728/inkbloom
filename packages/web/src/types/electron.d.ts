interface ElectronAPI {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  selectDirectory: () => Promise<string | null>;
  getServiceStatus: () => Promise<{ go: boolean; python: boolean }>;
  restartService: (name: string) => Promise<void>;
  getConfig: () => Promise<Record<string, any>>;
  setConfig: (key: string, value: string) => Promise<void>;
  getVersion: () => Promise<string>;
  getPlatform: () => string;
  /** 菜单事件（v2 §7.2）：主进程「数据与云同步」菜单 → 打开数据弹窗 */
  onMenuOpenDataModal?: (callback: () => void) => () => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}
