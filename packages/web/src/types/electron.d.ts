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
}

interface Window {
  electronAPI?: ElectronAPI;
}
