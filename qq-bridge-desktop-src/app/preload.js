/**
 * preload.js —— 页面和主进程之间的桥
 * ============================================================================
 * 启动页和控制台共用同一套门面，只暴露必要的几个方法，页面本身拿不到 Node。
 *
 *   window.__qqDesktop.status()              总状态（DSH / 桥接 / SnowLuma）
 *   window.__qqDesktop.start()               一键启动（DSH → SnowLuma → 桥接）
 *   window.__qqDesktop.stopBridge()          只停桥接
 *   window.__qqDesktop.reloadConsole()       切到控制台
 *   window.__qqDesktop.snowluma.start()      启动 SnowLuma（接管黑窗输出）
 *   window.__qqDesktop.snowluma.stop()       停止 SnowLuma
 *   window.__qqDesktop.snowluma.takeover()   停掉外部进程，改由本程序托管
 *   window.__qqDesktop.snowluma.onLog(fn)    订阅 SnowLuma 输出
 *   window.__qqDesktop.onProgress(fn)        启动进度
 * ============================================================================
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('__qqDesktop', {
  status: () => ipcRenderer.invoke('qq:status'),
  start: (uin) => ipcRenderer.invoke('qq:start', uin),
  stopBridge: () => ipcRenderer.invoke('qq:stop'),
  reloadConsole: () => ipcRenderer.invoke('qq:reload'),
  settings: () => ipcRenderer.invoke('qq:settings'),
  saveUin: (uin) => ipcRenderer.invoke('qq:save-uin', uin),
  locateBridge: () => ipcRenderer.invoke('qq:locate-bridge'),
  bridgeLogs: () => ipcRenderer.invoke('bridge:logs'),
  clearBridgeLogs: () => ipcRenderer.invoke('bridge:clear'),
  onBridgeLog: subscribe('bridge:log'),
  saveDshToken: (raw) => ipcRenderer.invoke('dsh:save-token', raw),
  dshTokenStatus: () => ipcRenderer.invoke('dsh:token-status'),
  onProgress: subscribe('qq:progress'),
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    install: (repo) => ipcRenderer.invoke('plugins:install', repo),
    adopt: (name) => ipcRenderer.invoke('plugins:adopt', name),
    searchCatalog: (q) => ipcRenderer.invoke('plugins:catalog-search', q),
    installNpm: (name, version) => ipcRenderer.invoke('plugins:install-npm', name, version),
    getConfig: (name) => ipcRenderer.invoke('plugins:get-config', name),
    saveConfig: (name, config) => ipcRenderer.invoke('plugins:save-config', name, config),
    toggle: (name, enabled) => ipcRenderer.invoke('plugins:toggle', name, enabled),
    uninstall: (name) => ipcRenderer.invoke('plugins:uninstall', name),
    openSettings: (name) => ipcRenderer.invoke('plugins:open-settings', name),
    apply: () => ipcRenderer.invoke('plugins:apply'),
  },
  snowluma: {
    status: () => ipcRenderer.invoke('snowluma:status'),
    start: () => ipcRenderer.invoke('snowluma:start'),
    stop: () => ipcRenderer.invoke('snowluma:stop'),
    takeover: () => ipcRenderer.invoke('snowluma:takeover'),
    locate: () => ipcRenderer.invoke('snowluma:locate'),
    openDownload: () => ipcRenderer.invoke('snowluma:open-download'),
    onLog: subscribe('snowluma:log'),
  },
});
