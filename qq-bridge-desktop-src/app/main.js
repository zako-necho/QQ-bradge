/**
 * QQ 桥接桌面版 —— Electron 主进程
 * ============================================================================
 * 启动页（launcher.html）
 *   ├─ 开始桥接：DSH（必要时拉起）→ SnowLuma（必要时拉起）→ 桥接 → 进控制台
 *   └─ 配置 SnowLuma：托管它的进程，把 stdout 转成界面里的日志（不再弹 cmd 黑窗）
 *
 * 控制台
 *   └─ 右下角注入「桥接开关」浮层
 * ============================================================================
 */

const { app, BrowserWindow, Menu, ipcMain, shell, dialog, Tray, nativeImage, clipboard } = require('electron');
const { execFile, spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pluginManager = require('./plugins');

const LOG = path.join(__dirname, 'desktop.log');
/** DSH 的启动输出落盘位置：token 就在 "dsh web: http://...?token=..." 那一行。 */
const DSH_STDOUT_LOG = path.join(__dirname, 'dsh-stdout.log');
/** 从启动输出里解析出来的 DSH 端点（带 token）。 */
const DSH_ENDPOINT_FILE = path.join(__dirname, 'dsh-endpoint.json');

/** 本程序自己的设置（目前只存「要监听哪个 QQ」），和原子程序放一起。 */
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function log(message) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

function writeSettings(next) {
  try {
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    log('写设置失败：' + error.message);
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ───────────────────────── 定位 qq-bridge ───────────────────────── */

function findBridgeRoot() {
  const home = os.homedir();

  // 用户在界面上选过的目录优先（换机器/装在别处时用）
  try {
    const saved = readSettings().bridgeRoot;
    if (saved && fs.existsSync(path.join(saved, 'src', 'bridge.js'))) return saved;
  } catch { /* 读不到就走候选 */ }

  const candidates = [
    process.env.QQ_BRIDGE_ROOT,
    path.join(home, 'Documents', 'deepseek-harness', 'qq-bridge'),
    path.join(home, 'deepseek-harness', 'qq-bridge'),
    'D:/DSH/qq-bridge',
    'C:/qq-bridge',
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'src', 'bridge.js'))) return dir;
    } catch {
      /* 换下一个 */
    }
  }
  return '';
}

const BRIDGE_ROOT = findBridgeRoot();
const CONFIG_FILE = BRIDGE_ROOT ? path.join(BRIDGE_ROOT, 'config.json') : '';

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

function bridgePort() {
  return Number(readConfig().consolePort || 3100);
}

/* ───────────────────────── 端口探测 ───────────────────────── */

function probePort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

async function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await sleep(500);
  }
  return false;
}

/* ───────────────────────── DSH ───────────────────────── */

function isDshRunning() {
  const script = "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*Harness*' } | Select-Object -First 1 -ExpandProperty Id";
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000 }, (error, stdout) => {
      if (error && !stdout) return resolve(false);
      resolve(String(stdout || '').trim().length > 0);
    });
  });
}

function findDshExe() {
  const candidates = [
    process.env.DSH_EXE,
    'D:/DeepSeek/Harness-0.2.1/DeepSeek Harness.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    'C:/Program Files/DeepSeek Harness/DeepSeek Harness.exe',
    'C:/Program Files (x86)/DeepSeek Harness/DeepSeek Harness.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 换下一个 */
    }
  }
  return '';
}

/**
 * 启动 DSH，并把它的 stdout/stderr 重定向到固定文件。
 * DSH 起来时 dsh web 会打印一行 "dsh web: http://127.0.0.1:xxxxx/?token=..."
 * —— token 就在那里，这是唯一可靠能拿到它的地方（外部拿不到进程内存）。
 */
function launchDsh() {
  const exe = findDshExe();
  if (!exe) {
    log('找不到 DSH 的 exe（可设环境变量 DSH_EXE）');
    return false;
  }
  try {
    const out = fs.openSync(DSH_STDOUT_LOG, 'w');
    try {
      log('启动 DSH（输出 -> dsh-stdout.log）：' + exe);
      spawn(exe, [], { detached: true, stdio: ['ignore', out, out] }).unref();
    } finally {
      // 子进程已经继承了这个句柄，父进程这边可以关掉
      try { fs.closeSync(out); } catch { /* ignore */ }
    }
    return true;
  } catch (error) {
    log('启动 DSH 失败：' + error.message);
    return false;
  }
}

/** 从 dsh-stdout.log 里抠出最新的带 token 的 URL。 */
function parseDshEndpointFromStdout() {
  try {
    const text = fs.readFileSync(DSH_STDOUT_LOG, 'utf8');
    const matches = [...text.matchAll(/dsh web:\s*(http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+))/g)];
    if (matches.length === 0) return null;
    const last = matches[matches.length - 1];
    const info = { url: last[1], port: Number(last[2]), token: last[3], at: Date.now() };
    fs.writeFileSync(DSH_ENDPOINT_FILE, JSON.stringify(info, null, 2), 'utf8');
    log('已从启动输出拿到 DSH token（端口 ' + info.port + '）');
    return info;
  } catch {
    return null;
  }
}

/** 等启动输出里出现 token（最多等 timeoutMs）。 */
async function waitForDshToken(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = parseDshEndpointFromStdout();
    if (info) return info;
    await sleep(1000);
  }
  return null;
}

/**
 * 用户手动贴进来的 token（或完整 URL）。
 * DSH 桌面版可以用 Ctrl+Shift+I 打开 DevTools，在 Console 里敲 location.href
 * 就能看到 http://127.0.0.1:xxxxx/?token=... ，整条粘进来就行。
 */
function saveManualDshToken(raw) {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, detail: '内容是空的' };

  let url = '';
  let port = 0;
  let token = '';
  const asUrl = input.match(/https?:\/\/127\.0\.0\.1:(\d+)\/?\?token=([\w-]+)/i)
    || input.match(/https?:\/\/([^/]+)\/?\?token=([\w-]+)/i);
  if (asUrl) {
    port = Number(asUrl[1]) || 0;
    token = asUrl[2];
    url = input.startsWith('http') ? input : 'http://127.0.0.1:' + port + '/?token=' + token;
    if (port === 0) {
      const m = url.match(/127\.0\.0\.1:(\d+)/);
      port = m ? Number(m[1]) : 0;
    }
  } else if (/^[\w-]{16,}$/.test(input)) {
    // 只给了 token：用 config 里的端口拼
    token = input;
    try {
      const cfg = readConfig();
      const base = (cfg.dsh && cfg.dsh.baseUrl) || '';
      const m = base.match(/127\.0\.0\.1:(\d+)/);
      port = m ? Number(m[1]) : 0;
    } catch { /* ignore */ }
    if (!port) return { ok: false, detail: '只给了 token，但不知道 DSH 端口；请粘贴完整地址' };
    url = 'http://127.0.0.1:' + port + '/?token=' + token;
  } else {
    return { ok: false, detail: '看不懂这个内容。请粘贴完整地址（http://127.0.0.1:端口/?token=...）' };
  }

  const info = { url, port, token, at: Date.now(), source: 'manual' };
  try {
    fs.writeFileSync(DSH_ENDPOINT_FILE, JSON.stringify(info, null, 2), 'utf8');
    log('已保存手动输入的 DSH token（端口 ' + port + '）');
    return { ok: true, detail: '已保存，端口 ' + port + '。点「设置」就能直接打开 DSH 了。', port };
  } catch (error) {
    return { ok: false, detail: '保存失败：' + error.message };
  }
}

/** 请求一个 URL 拿状态码（用来验 token 有没有过期）。 */
function httpGetStatus(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      });
      req.on('error', () => resolve(0));
      req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } resolve(0); });
    } catch {
      resolve(0);
    }
  });
}

/** 读之前存下来的端点（校验一下端口还活着）。 */
async function readStoredDshEndpoint() {
  try {
    const info = JSON.parse(fs.readFileSync(DSH_ENDPOINT_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (!info || !info.url) return null;
    if (info.port && !await probePort(info.port)) {
      log('存下来的 DSH 端点端口不在了（' + info.port + '），作废');
      return null;
    }

    // token 每次 DSH 启动都会换，所以不光要端口活着，还得真的能用
    if (info.token) {
      const status = await httpGetStatus(info.url);
      if (status === 401) {
        log('存下来的 DSH token 已过期（401），作废——DSH 重启后 token 会变');
        return null;
      }
    }
    return info;
  } catch {
    return null;
  }
}

/** 等 DSH 能服务：优先读它启动日志里的端口，读不到就退化成「进程在 + 等 20 秒」。 */
async function waitForDshReady(timeoutMs = 90000) {
  const logPath = path.join(process.env.APPDATA || '', 'dsh-desktop', 'logs', 'harness.log');
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let lastKnownPort = 0;

  while (Date.now() < deadline) {
    await sleep(1500);

    try {
      const stat = fs.statSync(logPath);
      if (stat.size > 0) {
        const readBytes = Math.min(64 * 1024, stat.size);
        const buffer = Buffer.alloc(readBytes);
        const fd = fs.openSync(logPath, 'r');
        fs.readSync(fd, buffer, 0, readBytes, stat.size - readBytes);
        fs.closeSync(fd);
        const matches = [...buffer.toString('utf8').matchAll(/dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)/g)];
        if (matches.length > 0) lastKnownPort = Number(matches[matches.length - 1][1]);
      }
    } catch {
      /* 日志不存在就靠进程判断 */
    }

    if (lastKnownPort && await probePort(lastKnownPort, 600)) {
      log('DSH 已就绪，端口 ' + lastKnownPort);
      return { ok: true, port: lastKnownPort };
    }

    if (!lastKnownPort && Date.now() - startedAt > 20000) {
      if (await isDshRunning()) {
        log('DSH 进程已起来（未读到端口），按可用处理');
        return { ok: true, port: 0 };
      }
    }
  }
  return { ok: false, port: lastKnownPort };
}

/* ───────────────────────── SnowLuma ───────────────────────── */

/** SnowLuma 的常见位置：环境变量 → 与本程序同一父目录 → 用户文档。 */
function snowLumaCandidates() {
  const home = os.homedir();
  return [
    process.env.SNOWLUMA_ROOT,
    path.join(home, 'Documents', 'deepseek-harness', 'SnowLuma'),
    path.join(home, 'deepseek-harness', 'SnowLuma'),
    path.join(home, 'SnowLuma'),
    'D:/DSH/SnowLuma',
    'C:/SnowLuma',
  ].filter(Boolean);
}

function looksLikeSnowLuma(dir) {
  try {
    return fs.existsSync(path.join(dir, 'index.mjs')) && fs.existsSync(path.join(dir, 'node.exe'));
  } catch {
    return false;
  }
}

let snowLumaRoot = '';    // 用户手动选过的目录优先
let snowLumaProcess = null;

function findSnowLuma() {
  if (snowLumaRoot && looksLikeSnowLuma(snowLumaRoot)) return snowLumaRoot;
  for (const dir of snowLumaCandidates()) {
    if (looksLikeSnowLuma(dir)) return dir;
  }
  return '';
}

async function snowLumaStatus() {
  const dir = findSnowLuma();
  const managed = Boolean(snowLumaProcess && snowLumaProcess.exitCode === null);
  // 外部启动的 SnowLuma 也要算「在运行」，不然面板会显示未运行、点启动还会撞端口
  const portUp = await probePort(3001);
  return {
    installed: Boolean(dir),
    root: dir,
    managed,
    running: managed || portUp,
    external: !managed && portUp,
    downloadUrl: 'https://github.com/SnowLuma/SnowLuma/releases',
    repoUrl: 'https://github.com/SnowLuma/SnowLuma',
  };
}

const snowLumaUins = new Set();   // SnowLuma 实际登录过的 UIN（可能不止一个）

function pushLog(win, chunk) {
  const text = chunk.toString('utf8');
  // 顺手从输出里抓当前登录的 UIN，用来和目标 QQ 号比对
  // 只认「登录/会话建立」这类行，避免把消息正文里的 UIN 也算进来
  for (const m of text.matchAll(/(?:login detected|session started)[^\n]*?UIN=(\d{5,12})/g)) {
    snowLumaUins.add(m[1]);
  }
  try {
    if (win && !win.isDestroyed()) win.webContents.send('snowluma:log', text);
  } catch {
    /* 窗口没了就算了 */
  }
}

/**
 * 确保 SnowLuma 里存在这个 QQ 的 OneBot 配置。
 *
 * SnowLuma 本身没有「启动时指定 UIN」的参数，但每个账号在
 * `config/onebot_<QQ>.json` 里有自己的网络配置（3000/3001）。
 * 所以这里做两件事：
 *   1. 没有这个文件就从已有的账号配置复制一份（桥接要的是 3000/3001）；
 *   2. 有的话，把 wsServers 里的 3001 补齐，别让桥接连不上。
 */
function ensureOnebotConfig(uin) {
  const dir = findSnowLuma();
  if (!dir) return { ok: false, detail: '没找到 SnowLuma 目录' };
  if (!/^\d{5,12}$/.test(String(uin || ''))) return { ok: false, detail: 'QQ 号格式不对' };

  const configDir = path.join(dir, 'config');
  const targetName = `onebot_${uin}.json`;
  const target = path.join(configDir, targetName);

  const normalize = (cfg) => {
    cfg.networks = cfg.networks || {};
    cfg.networks.httpServers = Array.isArray(cfg.networks.httpServers) ? cfg.networks.httpServers : [];
    cfg.networks.wsServers = Array.isArray(cfg.networks.wsServers) ? cfg.networks.wsServers : [];

    const http = cfg.networks.httpServers[0];
    if (!http) {
      cfg.networks.httpServers.push({
        name: 'http-default', accessToken: '', messageFormat: 'array', reportSelfMessage: false,
        host: '127.0.0.1', port: 3000, path: '/', enableWebSocket: true,
      });
    } else {
      http.port = Number(http.port) || 3000;
      http.host = http.host || '127.0.0.1';
    }

    const ws = cfg.networks.wsServers[0];
    if (!ws) {
      cfg.networks.wsServers.push({
        name: 'ws-default', accessToken: '', messageFormat: 'array', reportSelfMessage: false,
        host: '127.0.0.1', port: 3001, path: '/', role: 'Universal',
      });
    } else {
      ws.port = Number(ws.port) || 3001;
      ws.host = ws.host || '127.0.0.1';
    }
    return cfg;
  };

  const moved = [];
  try {
    // 目标账号：确保占住 3000/3001
    if (fs.existsSync(target)) {
      const cfg = normalize(JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')));
      fs.writeFileSync(target, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    } else {
      const templates = fs.readdirSync(configDir).filter((name) => /^onebot_\d+\.json$/.test(name));
      if (templates.length === 0) {
        return { ok: false, detail: '还没有任何账号的 OneBot 配置可以参考，先在 SnowLuma 里登录一次' };
      }
      const template = JSON.parse(
        fs.readFileSync(path.join(configDir, templates[0]), 'utf8').replace(/^\uFEFF/, ''),
      );
      fs.writeFileSync(target, `${JSON.stringify(normalize(template), null, 2)}\n`, 'utf8');
      log('已按模板生成 OneBot 配置：' + target);
    }

    // 其他账号：让出 3000/3001（SnowLuma 会把所有登录的号都加载起来，
    // 谁抢到端口不确定；让非目标号挪到 3010/3011，目标号才稳定占住桥接要的端口）
    for (const name of fs.readdirSync(configDir)) {
      if (!/^onebot_\d+\.json$/.test(name) || name === targetName) continue;
      const file = path.join(configDir, name);
      let cfg;
      try {
        cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      } catch {
        continue;
      }
      let changed = false;
      const http = cfg.networks && cfg.networks.httpServers && cfg.networks.httpServers[0];
      if (http && Number(http.port) === 3000) { http.port = 3010; changed = true; }
      const ws = cfg.networks && cfg.networks.wsServers && cfg.networks.wsServers[0];
      if (ws && Number(ws.port) === 3001) { ws.port = 3011; changed = true; }
      if (changed) {
        fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
        moved.push(name.replace(/^onebot_|\.json$/g, ''));
      }
    }
  } catch (error) {
    log('准备 OneBot 配置失败：' + error.message);
    return { ok: false, detail: '准备 OneBot 配置失败：' + error.message };
  }

  log('OneBot 配置就绪：目标 ' + uin + (moved.length ? '，让出端口的账号：' + moved.join(',') : ''));
  return {
    ok: true,
    detail: `已确认 ${uin} 用 3000/3001` + (moved.length ? `（${moved.join('、')} 挪到 3010/3011）` : ''),
    moved,
  };
}
/**
 * 起 SnowLuma。关键是 SNOWLUMA_HOOK_AUTOLOAD=1：
 * 它的 runtime.json 里 hookAutoLoad 默认是 false，不显式打开的话
 * 只会起个 WebUI，不会接管已登录的 QQ，3000/3001 就永远不监听。
 */
async function startSnowLuma() {
  const dir = findSnowLuma();
  if (!dir) return { ok: false, detail: '没找到 SnowLuma（可以在面板里选择目录，或者去 GitHub 下载）' };
  if (snowLumaProcess && snowLumaProcess.exitCode === null) {
    return { ok: true, detail: 'SnowLuma 已经在运行（由本程序托管）' };
  }
  if (await probePort(3001)) {
    return {
      ok: false,
      detail: '3001 上已经有一个 SnowLuma 在跑（外部启动的）。点「接管外部进程」才能看到它的输出。',
    };
  }

  const nodeExe = path.join(dir, 'node.exe');
  const entry = path.join(dir, 'index.mjs');
  try {
    log('启动 SnowLuma：' + dir);
    snowLumaProcess = spawn(nodeExe, [entry], {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', SNOWLUMA_HOOK_AUTOLOAD: '1' },
    });

    snowLumaProcess.stdout.on('data', (chunk) => pushLog(mainWindow, chunk));
    snowLumaProcess.stderr.on('data', (chunk) => pushLog(mainWindow, chunk));
    snowLumaProcess.on('exit', (code) => {
      log('SnowLuma 退出，code=' + code);
      pushLog(mainWindow, '\n[进程已退出，code=' + code + ']\n');
      snowLumaProcess = null;
    });
    snowLumaProcess.on('error', (error) => {
      log('SnowLuma 启动出错：' + error.message);
      pushLog(mainWindow, '[启动出错] ' + error.message + '\n');
      snowLumaProcess = null;
    });

    return { ok: true, detail: '已启动 SnowLuma，输出会显示在下面的日志里' };
  } catch (error) {
    log('启动 SnowLuma 异常：' + error.message);
    return { ok: false, detail: '启动失败：' + error.message };
  }
}

/** 结束所有 SnowLuma 进程（包括外部启动的、以及带 node.exe 的）。 */
function killSnowLumaAll() {
  const dir = findSnowLuma();
  const script = `
$targets = @()
$lines = netstat -ano | Select-String ':3001\\s+.*LISTENING'
foreach ($l in $lines) { if ($l.Line -match 'LISTENING\\s+(\\d+)$') { $targets += [int]$matches[1] } }
${dir ? `Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*index.mjs*' -and $_.ExecutablePath -like '*${dir.replace(/\\/g, '\\\\').replace(/'/g, "''")}*' } |
  ForEach-Object { $targets += $_.ProcessId }` : ''}
$targets = $targets | Sort-Object -Unique
foreach ($procId in $targets) { try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {} }
Write-Output ($targets -join ',')
`;
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000 }, (error, stdout) => {
      log('停止 SnowLuma：' + String(stdout || '').trim());
      resolve(String(stdout || '').trim());
    });
  });
}

async function stopSnowLuma() {
  if (snowLumaProcess) {
    try { snowLumaProcess.kill(); } catch { /* ignore */ }
    snowLumaProcess = null;
  }
  await killSnowLumaAll();
  await sleep(600);
  return { ok: true, detail: '已停止 SnowLuma' };
}

/* ───────────────────────── 桥接 ───────────────────────── */

/** 桥接进程输出缓冲（给控制台的「桥接日志」页用）。 */
let bridgeProcess = null;
const bridgeLogBuffer = [];
const BRIDGE_LOG_MAX = 3000;

function bridgeLogText() {
  return bridgeLogBuffer.join('\n');
}

function pushBridgeLog(text) {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+$/, '');
    if (!line) continue;
    bridgeLogBuffer.push('[' + stamp + '] ' + line);
    if (bridgeLogBuffer.length > BRIDGE_LOG_MAX) bridgeLogBuffer.shift();
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bridge:log', text);
  } catch {
    /* ignore */
  }
}

/** 跑一次 sync-dsh-endpoint（start.bat 里做的那一步），用 Electron 的 node 模式。 */
function runSyncEndpoint() {
  return new Promise((resolve) => {
    if (!BRIDGE_ROOT) return resolve();
    let output = '';
    try {
      const child = spawn(process.execPath, ['scripts/sync-dsh-endpoint.mjs'], {
        cwd: BRIDGE_ROOT,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (d) => { output += d.toString('utf8'); });
      child.stderr.on('data', (d) => { output += d.toString('utf8'); });
      child.on('exit', () => { log('sync-dsh-endpoint: ' + output.trim().slice(-200)); resolve(); });
      child.on('error', () => resolve());
      setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(); }, 20000);
    } catch {
      resolve();
    }
  });
}

/**
 * 启动桥接：直接用 Electron 的 node 模式跑 src/bridge.js，
 * 不再走 start.bat —— 这样没有黑窗，stdout 还能接进控制台。
 */
async function launchBridge() {
  if (!BRIDGE_ROOT) return false;
  try {
    await runSyncEndpoint();
    log('启动桥接进程（无窗口）：' + BRIDGE_ROOT);
    bridgeLogBuffer.length = 0;
    pushBridgeLog('正在启动桥接…');
    bridgeProcess = spawn(process.execPath, ['src/bridge.js'], {
      cwd: BRIDGE_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
      },
    });
    bridgeProcess.stdout.on('data', (chunk) => pushBridgeLog(chunk.toString('utf8')));
    bridgeProcess.stderr.on('data', (chunk) => pushBridgeLog(chunk.toString('utf8')));
    bridgeProcess.on('exit', (code) => {
      pushBridgeLog('\n[桥接进程已退出，code=' + code + ']\n');
      bridgeProcess = null;
    });
    bridgeProcess.on('error', (error) => {
      pushBridgeLog('[启动出错] ' + error.message);
      bridgeProcess = null;
    });
    return true;
  } catch (error) {
    log('拉起桥接失败：' + error.message);
    return false;
  }
}

function killBridge() {
  if (bridgeProcess) {
    try { bridgeProcess.kill(); } catch { /* ignore */ }
    bridgeProcess = null;
    pushBridgeLog('[已请求停止桥接进程]');
  }
  if (!BRIDGE_ROOT) return Promise.resolve(false);
  const lockFile = path.join(BRIDGE_ROOT, 'state', 'bridge.lock').replace(/\\/g, '\\\\');
  const script = `
$targets = @()
$lock = '${lockFile}'
if (Test-Path $lock) { $raw = (Get-Content $lock -Raw).Trim(); if ($raw -match '^\\d+$') { $targets += [int]$raw } }
$lines = netstat -ano | Select-String ':${bridgePort()}\\s+.*LISTENING'
foreach ($l in $lines) { if ($l.Line -match 'LISTENING\\s+(\\d+)$') { $targets += [int]$matches[1] } }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*bridge.js*' } | ForEach-Object { $targets += $_.ProcessId }
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*start.bat*' } | ForEach-Object { $targets += $_.ProcessId }
$targets = $targets | Sort-Object -Unique
foreach ($procId in $targets) { try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {} }
Remove-Item $lock -Force -ErrorAction SilentlyContinue
Write-Output ($targets -join ',')
`;
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20000 }, (error, stdout) => {
      log('停止桥接：' + String(stdout || '').trim());
      resolve(!error);
    });
  });
}

/* ───────────────────────── 状态与启动流程 ───────────────────────── */

async function collectStatus() {
  const dshRunning = await isDshRunning();
  const bridgeUp = await probePort(bridgePort());
  return {
    dshRunning,
    dshExe: findDshExe(),
    bridgeRunning: bridgeUp,
    bridgePort: bridgePort(),
    bridgeRoot: BRIDGE_ROOT,
    bridgeFound: Boolean(BRIDGE_ROOT),
    snowluma: await snowLumaStatus(),
  };
}

function sendProgress(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('qq:progress', payload);
  } catch {
    /* ignore */
  }
}

function consoleUrl() {
  const cfg = readConfig();
  const port = Number(cfg.consolePort || 3100);
  const token = String(cfg.consoleToken || '').trim();
  return token
    ? `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
    : `http://127.0.0.1:${port}/`;
}

/**
 * 一键启动：DSH → SnowLuma → 桥接 → 进控制台。
 * 每一步都先探测，已经在跑就跳过。
 */
async function startAll(uin) {
  const progress = (text) => sendProgress({ text, level: 'info' });

  /* 1. DSH —— 只检查，没运行就帮忙启动。不重启、不抓 token。
     （插件设置页已经由桥接自己的配置界面提供，不再依赖 DSH 的 token） */
  progress('检查 DSH…');
  if (!await isDshRunning()) {
    progress('DSH 没在运行，正在启动…');
    if (!launchDsh()) {
      return { ok: false, detail: '找不到 DSH 的 exe（可以设环境变量 DSH_EXE 指向它）' };
    }
    progress('等 DSH 就绪（可能要 20~60 秒）…');
    const ready = await waitForDshReady(90000);
    if (!ready.ok) {
      return { ok: false, detail: 'DSH 90 秒内没有就绪，看看它自己的窗口有没有报错' };
    }
  } else {
    progress('DSH 已在运行');
  }

  // 桌面版每次启动端口都变，同步一下桥接要连的地址
  await runSyncEndpoint();

  /* 2. SnowLuma */
  const targetUin = String(uin || readSettings().uin || '').trim();
  let warning = '';

  if (targetUin) {
    progress('准备 ' + targetUin + ' 的 OneBot 配置…');
    const prepared = ensureOnebotConfig(targetUin);
    if (!prepared.ok) return { ok: false, detail: prepared.detail };
  }

  const snow = await snowLumaStatus();
  if (!snow.installed) {
    return { ok: false, detail: '还没装 SnowLuma。点「配置 SnowLuma」去 GitHub 下载，解压后选一下目录。' };
  }
  if (!snow.running) {
    progress('启动 SnowLuma…');
    snowLumaUins.clear();
    const started = await startSnowLuma();
    if (!started.ok) return started;
    const up = await waitForPort(3001, 8000);
    if (!up) progress('SnowLuma 还没监听 3001，先继续（它可能需要扫码登录）');

    // 等 SnowLuma 把登录的号都报出来，再看目标号在不在里面
    for (let i = 0; i < 12 && snowLumaUins.size === 0; i += 1) await sleep(500);
    if (targetUin && snowLumaUins.size > 0) {
      if (snowLumaUins.has(targetUin)) {
        log('UIN 匹配：' + targetUin + '（同时在线的还有 ' + [...snowLumaUins].filter((u) => u !== targetUin).join(',') + '）');
      } else {
        warning = 'SnowLuma 接管的是 ' + [...snowLumaUins].join('、') + '，没有 ' + targetUin
          + '。可以先去 QQ 上登录 ' + targetUin + '，或在 SnowLuma 的 WebUI（127.0.0.1:5099）里切换。';
        log('UIN 不匹配：目标=' + targetUin + ' 实际=' + [...snowLumaUins].join(','));
      }
    }
  } else {
    progress('SnowLuma 已在运行' + (targetUin ? '（目标 ' + targetUin + '）' : ''));
  }

  /* 3. 桥接 */
  const port = bridgePort();
  if (await probePort(port)) {
    progress('桥接已经在运行');
  } else {
    progress('启动桥接…');
    if (!await launchBridge()) return { ok: false, detail: '没找到 qq-bridge 目录（可设环境变量 QQ_BRIDGE_ROOT）' };
    const up = await waitForPort(port, 45000);
    if (!up) return { ok: false, detail: '桥接 45 秒内没监听上，看看 qq-bridge/state/bridge.log' };
  }

  await sleep(600);
  showConsole();
  return { ok: true, detail: '已启动', warning };
}

/* ───────────────────────── 注入浮层 ───────────────────────── */

const PANEL_SCRIPT = String.raw`
(function () {
  if (window.__qbdInstalled) return 'exists';
  if (!window.__qqDesktop) return 'no-api';
  window.__qbdInstalled = true;

  var ACCENT = '#4d8df5', OK = '#3fb950', WARN = '#d29922', BAD = '#f85149', MUTED = '#9aa0a6';

  var root = document.createElement('div');
  root.id = '__qbd_panel';
  root.style.cssText = [
    'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
    'font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif',
    'color:#e6e8eb', 'background:rgba(28,31,38,.94)',
    'border:1px solid rgba(255,255,255,.12)', 'border-radius:12px',
    'box-shadow:0 12px 34px rgba(0,0,0,.4)', 'padding:12px 14px', 'width:250px',
    'backdrop-filter:blur(8px)'
  ].join(';');

  root.innerHTML = [
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">',
    '  <span id="__qbd_dot" style="width:8px;height:8px;border-radius:50%;background:' + WARN + '"></span>',
    '  <b style="font-size:13px">桥接开关</b>',
    '  <button id="__qbd_fold" style="margin-left:auto;background:transparent;border:none;color:#9aa0a6;cursor:pointer;font-size:14px;padding:0 2px">–</button>',
    '</div>',
    '<div id="__qbd_body">',
    '  <div style="display:flex;justify-content:space-between;color:' + MUTED + ';font-size:12px;margin-bottom:3px"><span>DSH</span><span id="__qbd_dsh">检测中…</span></div>',
    '  <div style="display:flex;justify-content:space-between;color:' + MUTED + ';font-size:12px;margin-bottom:3px"><span>SnowLuma</span><span id="__qbd_snow">检测中…</span></div>',
    '  <div style="display:flex;justify-content:space-between;color:' + MUTED + ';font-size:12px;margin-bottom:10px"><span>桥接</span><span id="__qbd_bridge">检测中…</span></div>',
    '  <div id="__qbd_msg" style="font-size:11.5px;color:' + MUTED + ';min-height:16px;margin-bottom:8px">点「启动」会依次确认 DSH、SnowLuma、桥接</div>',
    '  <div style="display:flex;gap:8px">',
    '    <button id="__qbd_start" style="flex:1;padding:7px 10px;border-radius:8px;border:1px solid ' + ACCENT + ';background:' + ACCENT + ';color:#fff;cursor:pointer;font:inherit">启动</button>',
    '    <button id="__qbd_stop" style="padding:7px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:transparent;color:#e6e8eb;cursor:pointer;font:inherit">停止</button>',
    '  </div>',
    '</div>'
  ].join('');

  document.body.appendChild(root);

  function q(id) { return root.querySelector('#__qbd_' + id); }
  var busy = false;

  function setDot(color) { q('dot').style.background = color; }
  function setMsg(text, color) { q('msg').textContent = text; q('msg').style.color = color || MUTED; }
  function setBusy(next) {
    busy = next;
    q('start').disabled = next;
    q('stop').disabled = next;
    q('start').style.opacity = next ? '.55' : '1';
    q('start').style.cursor = next ? 'default' : 'pointer';
  }

  async function refresh() {
    try {
      var s = await window.__qqDesktop.status();
      q('dsh').textContent = s.dshRunning ? '运行中' : '未运行';
      q('dsh').style.color = s.dshRunning ? OK : MUTED;
      q('snow').textContent = s.snowluma && s.snowluma.running ? '运行中' : '未运行';
      q('snow').style.color = s.snowluma && s.snowluma.running ? OK : MUTED;
      q('bridge').textContent = s.bridgeRunning ? ('运行中 :' + s.bridgePort) : '已停止';
      q('bridge').style.color = s.bridgeRunning ? OK : BAD;
      setDot(s.bridgeRunning ? OK : (s.dshRunning ? WARN : '#6b7280'));
      return s;
    } catch (error) {
      setMsg('读状态失败：' + error.message, BAD);
      return null;
    }
  }

  window.__qqDesktop.onProgress(function (p) {
    if (p && p.text) setMsg(p.text, WARN);
  });

  q('start').onclick = async function () {
    if (busy) return;
    setBusy(true);
    setMsg('正在启动…', WARN);
    try {
      var result = await window.__qqDesktop.start();
      if (result.ok) {
        setMsg('已启动，正在刷新…', OK);
        setTimeout(function () { window.__qqDesktop.reloadConsole(); }, 600);
      } else {
        setMsg(result.detail || '启动失败', BAD);
        setBusy(false);
        refresh();
      }
    } catch (error) {
      setMsg('启动失败：' + error.message, BAD);
      setBusy(false);
    }
  };

  q('stop').onclick = async function () {
    if (busy) return;
    if (!confirm('停止桥接？QQ 机器人会离线，DSH 和 SnowLuma 不受影响。')) return;
    setBusy(true);
    setMsg('正在停止…', WARN);
    try {
      await window.__qqDesktop.stopBridge();
      setMsg('已停止', MUTED);
      await refresh();
    } catch (error) {
      setMsg('停止失败：' + error.message, BAD);
    } finally {
      setBusy(false);
    }
  };

  q('fold').onclick = function () {
    var body = q('body');
    var hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    q('fold').textContent = hidden ? '–' : '+';
  };

  refresh();
  setInterval(function () { if (!busy) refresh(); }, 5000);
  return 'installed';
})();
`;

/* ───────────────────────── 窗口 ───────────────────────── */

let mainWindow = null;
let tray = null;
let quitting = false;

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    log('窗口不在了，重新创建');
    createWindow();
    const up = probePort(bridgePort());
    up.then((ok) => (ok ? showConsole() : showLauncher()));
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.setAlwaysOnTop(false);
}

/** 托盘：关窗口只是收起来，真正退出走这里。 */
function createTray() {
  try {
    // 和 exe 用同一张图：改图标时两个一起换，视觉才一致
    let image = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
    if (image.isEmpty()) {
      log('icon.ico 读不出来，换成 icon.png');
      image = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    }
    if (image.isEmpty()) throw new Error('icon.ico 和 icon.png 都读不出来');
    const small = image.resize({ width: 16, height: 16 });
    log('托盘图片已加载 size=' + JSON.stringify(small.getSize()) + ' empty=' + small.isEmpty());
    tray = new Tray(small);
    tray.setToolTip('QQ 桥接桌面版（双击打开，右键菜单退出）');

    const menu = Menu.buildFromTemplate([
      { label: '打开窗口', click: showWindow },
      {
        label: '启动桥接',
        click: () => {
          startAll(readSettings().uin).then((r) => log('托盘启动桥接：' + JSON.stringify(r)));
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          log('托盘：用户选择退出');
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', showWindow);
    tray.on('click', showWindow);
    log('托盘图标已创建 bounds=' + JSON.stringify(tray.getBounds()) + ' destroyed=' + tray.isDestroyed());
  } catch (error) {
    log('托盘创建失败：' + error.message);
    tray = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    title: 'QQ Bridge · DeepSeek Harness',
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  const inject = () => {
    if (mainWindow.webContents.getURL().startsWith('file:')) return; // 启动页不注入浮层
    mainWindow.webContents.executeJavaScript(PANEL_SCRIPT, true)
      .then((result) => log('浮层注入：' + result))
      .catch((error) => log('浮层注入失败：' + error.message));
  };
  mainWindow.webContents.on('did-finish-load', inject);

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(target)) return { action: 'allow' };
    shell.openExternal(target).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      mainWindow.hide();
      log('窗口已收进托盘（要退出请右键托盘图标）');
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showLauncher() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitle('QQ 桥接桌面版 · 启动');
  mainWindow.loadFile(path.join(__dirname, 'launcher.html')).catch((error) => log('加载启动页失败：' + error.message));

  // 自检：页面结构 + 状态是否渲染出来（日志里能直接看到）
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.executeJavaScript(
      "(function(){"
      + "var g=function(id){var e=document.getElementById(id);return e?e.textContent:'(缺失)'};"
      + "return JSON.stringify({title:document.title,"
      + "startBtn:!!document.getElementById('btn-start'),"
      + "snowBtn:!!document.getElementById('btn-snow'),"
      + "snowPanel:!!document.getElementById('snow-panel'),"
      + "uinInput:!!document.getElementById('uin'),uinValue:(document.getElementById('uin')||{}).value||'',"
      + "tokenInput:!!document.getElementById('dshToken'),"
      + "dsh:g('s-dsh'),snow:g('s-snow'),bridge:g('s-bridge')});})()",
      true,
    ).then((text) => log('启动页自检：' + text)).catch((error) => log('自检失败：' + error.message));
  }, 2500);

}

function showConsole() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitle('QQ Bridge · DeepSeek Harness 控制台');
  mainWindow.loadURL(consoleUrl()).catch((error) => log('加载控制台失败：' + error.message));

  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.executeJavaScript(
      "(function(){var n=document.querySelector('[data-view=\"bridge-logs\"]');"
      + "var p=document.querySelector('[data-view=\"plugins\"]');"
      + "var ps=document.getElementById('section-plugins');"
      + "var pg=document.getElementById('pluginGrid');"
      + "return JSON.stringify({nav:!!n,pluginsNav:!!p,pluginsSection:!!ps,"
      + "pluginGrid:!!pg,pluginCards:pg?pg.querySelectorAll('.plugin-card').length:-1,"
      + "applyBtn:!!document.getElementById('pluginApply'),"
      + "applyApi:!!(window.__qqDesktop&&window.__qqDesktop.plugins&&window.__qqDesktop.plugins.apply),"
      + "pluginApi:!!(window.__qqDesktop&&window.__qqDesktop.plugins)});})()",
      true,
    ).then((r) => log('控制台自检：' + r)).catch((e) => log('控制台自检失败：' + e.message));
  }, 3500);
}

/**
 * 「设置」按钮：插件自带的设置界面长在 DSH 的 设置 → 插件 里，
 * 所以这里把 DSH 窗口叫到前台，用户能直接点过去（DSH 里已登录，不需要 token）。
 */
/**
 * 重启 DSH：桌面版把重启权交给了外壳（dshmarket 的 capabilities 里
 * restart.supported 就是 false），所以只能由我们杀掉进程再拉起来。
 * 效果等同手动重启，只是省得用户去任务管理器里找。
 */
function killDshProcesses() {
  return new Promise((resolve) => {
    execFile('taskkill', ['/F', '/T', '/IM', 'DeepSeek Harness.exe'], { timeout: 20000, windowsHide: true }, () => resolve());
  });
}

/**
 * DSH 每次启动端口都会变，而桥接只在启动时读一次 config。
 * 这里做「端点自检」：发现配置里的 DSH 连不上了就重新 sync，
 * 并且告诉调用方「地址变了没有」——变了才值得重启桥接。
 * 返回 true 表示 baseUrl 变了。
 */
async function ensureDshEndpoint() {
  if (!BRIDGE_ROOT) return false;
  const before = (readConfig().dsh && readConfig().dsh.baseUrl) || '';
  if (!before) return false;

  let port = 0;
  try { port = Number(new URL(before).port || 0); } catch { port = 0; }
  if (port && await probePort(port)) return false;   // 还活着，什么都不做

  log('DSH 端点连不上（' + before + '），重新同步');
  await runSyncEndpoint();
  const after = (readConfig().dsh && readConfig().dsh.baseUrl) || '';
  return Boolean(after) && after !== before;
}

async function restartDsh() {
  const exe = findDshExe();
  if (!exe) return { ok: false, detail: '找不到 DSH 的 exe（可以设环境变量 DSH_EXE）' };

  log('重启 DSH：' + exe);
  await killDshProcesses();
  await sleep(2500);

  if (!launchDsh()) {
    return { ok: false, detail: '拉不起来，看看 DSH 的 exe 路径' };
  }

  // 桌面版每次启动端口都变，等进程起来后把桥接的端点同步过去
  let alive = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    if (await isDshRunning()) { alive = true; break; }
  }
  if (!alive) return { ok: false, detail: 'DSH 没能启动，去它原本的窗口看看有没有报错' };

  await sleep(2000);
  await runSyncEndpoint();

  log('DSH 已重启');

  // DSH 换了端口之后，桥接进程里的 baseUrl 是旧的，事件流会连不上。
  // 所以这里顺手把桥接也重启一次，用户不用再手动点右下角的开关。
  let bridgeNote = '';
  try {
    const hadBridge = await probePort(bridgePort());
    if (hadBridge) {
      log('重启桥接以连上新的 DSH');
      await killBridge();
      await sleep(1500);
    }
    if (await launchBridge()) {
      const up = await waitForPort(bridgePort(), 45000);
      bridgeNote = up ? '，桥接也已重启并连上' : '，但桥接 45 秒内没监听上（看「桥接日志」页）';
    } else {
      bridgeNote = '，桥接没能重启（可点下方「开始桥接」）';
    }
  } catch (error) {
    log('重启桥接失败：' + error.message);
    bridgeNote = '，桥接重启失败：' + error.message;
  }

  return {
    ok: true,
    detail: 'DSH 已重启，插件已生效' + bridgeNote + '。',
  };
}

/* 问 DSH 里的 dsh-gui-endpoint 插件要一份带 token 的 GUI 地址 */
function httpGetJson(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

async function fetchDshGuiUrl() {
  const cfg = readConfig();
  const base = (cfg.dsh && cfg.dsh.baseUrl) || '';
  if (!base) return '';
  const info = await httpGetJson(base.replace(/\/+$/, '') + '/dsh-gui/url');
  if (!info || !info.ok || !info.url) {
    if (info && info.reason) log('端点插件不可用：' + info.reason);
    return '';
  }
  return info.url;
}

/**
 * 在 DSH 页面里自动导航到某个插件的设置页。
 *
 * DSH 的设置是一个弹窗（不是路由页面），所以只能靠 DOM：
 *   1. 先试把 hash 改成 #/settings（有的版本认这个）；
 *   2. 找不到就按文本找「设置」入口点开；
 *   3. 再按插件注册的 label（比如「刷B站」）点左侧那一项。
 * 找不到就放弃——至少窗口是打开且已登录的，用户自己点两下也行。
 */
function buildDshSettingsScript(label) {
  // 只用两招：把 hash 设成 #/settings 进设置面板，然后按插件注册的 label
  // 点左侧那一项。不再去猜"设置"按钮——上次会点到别的插件的独立弹窗。
  return '(function(){' +
    'var label=' + JSON.stringify(label || '') + ';' +
    'var tries=0;' +
    'function clickLabel(){' +
    ' if(!label)return false;' +
    ' var els=[].slice.call(document.querySelectorAll("button,a,div,span,li,[role=button]"));' +
    ' var hit=els.filter(function(el){' +
    '  return el.offsetParent&&(el.textContent||"").trim()===label;' +
    ' })[0];' +
    ' if(hit){hit.click();return true;}' +
    ' return false;' +
    '}' +
    'try{if(location.hash.indexOf("settings")<0)location.hash="#/settings";}catch(e){}' +
    'var timer=setInterval(function(){' +
    ' tries++;' +
    ' if(tries>40){clearInterval(timer);return;}' +
    ' if(clickLabel()){clearInterval(timer);}' +
    '},400);' +
  '})();';
}

function openDshWindow(url, title, settingsLabel) {
  try {
    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      title,
      autoHideMenuBar: true,
      backgroundColor: '#f6f7f9',
      webPreferences: {
        // 这个 preload 只在我们的窗口里跑，用来跳过 DSH 的启动动画。
        // DSH 自己的窗口不经过这里，动画照旧。
        preload: path.join(__dirname, 'dsh-window-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // 直接带上设置页的 hash，省得进来还要自己点
    const target = url.indexOf('#') >= 0 ? url : url + '#/settings';
    win.loadURL(target).catch((error) => log('DSH 窗口加载失败：' + error.message));

    if (settingsLabel) {
      win.webContents.on('did-finish-load', () => {
        win.webContents.executeJavaScript(buildDshSettingsScript(settingsLabel), true)
          .then((r) => log('设置页导航脚本已注入（label=' + settingsLabel + '）'))
          .catch((error) => log('设置页导航失败：' + error.message));
      });
    }
    return true;
  } catch (error) {
    log('打开 DSH 窗口失败：' + error.message);
    return false;
  }
}

async function focusDshSettings(pluginName) {
  if (pluginName) {
    try { clipboard.writeText(pluginName); } catch { /* ignore */ }
  }

  // 直接唤起用户**已经开着的**那个 DSH，不再另开窗口。
  // DSH 的窗口跑在我们进程之外 —— 读不到它的 DOM、也点不了它的按钮，
  // 所以只能做到：叫到前台 + 把插件名放剪贴板，方便在设置里搜。
  const script = `
$p = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -like '*DeepSeek*Harness*' -and $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1
if (-not $p) { Write-Output 'no-window'; exit 0 }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
[DshWin]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[DshWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Write-Output 'ok'
`;

  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000 }, (error, stdout) => {
      const ok = String(stdout || '').includes('ok');
      log('唤起 DSH 窗口：' + (ok ? '成功' : '失败') + (pluginName ? '（插件：' + pluginName + '）' : ''));
      resolve({
        ok,
        detail: ok
          ? (pluginName
            ? '已切到 DSH。插件名「' + pluginName + '」已复制，在「设置 → 插件」里搜一下就能到它的设置页。'
            : '已切到 DSH 窗口。')
          : '没找到 DSH 的窗口，它可能没在运行。',
      });
    });
  });
}

/* ───────────────────────── IPC ───────────────────────── */

ipcMain.handle('qq:status', () => collectStatus());
ipcMain.handle('qq:locate-bridge', async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: '选择 qq-bridge 目录（里面有 src\\bridge.js）',
    properties: ['openDirectory'],
  });
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, detail: '已取消' };
  const dir = picked.filePaths[0];
  if (!fs.existsSync(path.join(dir, 'src', 'bridge.js'))) {
    return { ok: false, detail: '这个目录里没有 src\\bridge.js，不像是 qq-bridge' };
  }
  writeSettings({ ...readSettings(), bridgeRoot: dir });
  log('qq-bridge 目录设为：' + dir);
  return { ok: true, detail: '已设为 ' + dir + '，重启本程序后生效', path: dir };
});
ipcMain.handle('bridge:logs', () => bridgeLogText());
ipcMain.handle('bridge:clear', () => { bridgeLogBuffer.length = 0; return true; });
/* ── 插件管理 ── */
ipcMain.handle('plugins:list', () => pluginManager.pluginSummary());
ipcMain.handle('plugins:install', (_event, repo) => pluginManager.installPlugin(repo));
ipcMain.handle('plugins:catalog-search', (_event, q) => pluginManager.searchCatalog(q));
ipcMain.handle('plugins:install-npm', (_event, name, version) => pluginManager.installFromNpm(name, version));
ipcMain.handle('plugins:adopt', (_event, name) => pluginManager.adoptPlugin(name));
ipcMain.handle('plugins:get-config', (_event, name) => pluginManager.getPluginConfig(name));
ipcMain.handle('plugins:save-config', (_event, name, config) => pluginManager.savePluginConfig(name, config));
ipcMain.handle('dsh:save-token', (_event, raw) => saveManualDshToken(raw));
ipcMain.handle('dsh:token-status', async () => {
  const info = await readStoredDshEndpoint();
  return info ? { ok: true, port: info.port, source: info.source || 'auto' } : { ok: false };
});
ipcMain.handle('plugins:toggle', (_event, name, enabled) => pluginManager.setPluginEnabled(name, enabled));
ipcMain.handle('plugins:uninstall', (_event, name) => pluginManager.uninstallPlugin(name));
ipcMain.handle('plugins:open-settings', (_event, name) => focusDshSettings(name));
ipcMain.handle('plugins:apply', () => restartDsh());
ipcMain.handle('qq:settings', () => ({ uin: String(readSettings().uin || '') }));
ipcMain.handle('qq:save-uin', (_event, uin) => {
  const clean = String(uin || '').trim();
  if (clean && !/^\d{5,12}$/.test(clean)) return { ok: false, detail: 'QQ 号应该是 5~12 位数字' };
  const next = { ...readSettings(), uin: clean };
  writeSettings(next);
  log('已保存监听 QQ：' + (clean || '(清空)'));
  return { ok: true, uin: clean };
});
ipcMain.handle('qq:start', (_event, uin) => startAll(uin));
ipcMain.handle('qq:stop', async () => {
  await killBridge();
  await sleep(800);
  return { ok: true, detail: '桥接已停止' };
});
ipcMain.handle('qq:reload', () => { showConsole(); return true; });

ipcMain.handle('snowluma:status', () => snowLumaStatus());
ipcMain.handle('snowluma:start', () => startSnowLuma());
ipcMain.handle('snowluma:stop', () => stopSnowLuma());
ipcMain.handle('snowluma:takeover', async () => {
  await stopSnowLuma();
  await sleep(800);
  const result = await startSnowLuma();
  if (result.ok) await sleep(1200);
  return result;
});
ipcMain.handle('snowluma:locate', async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: '选择 SnowLuma 目录（里面有 index.mjs 和 node.exe）',
    properties: ['openDirectory'],
  });
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, detail: '已取消' };
  const dir = picked.filePaths[0];
  if (!looksLikeSnowLuma(dir)) {
    return { ok: false, detail: '这个目录里没有 index.mjs / node.exe，不像是 SnowLuma' };
  }
  snowLumaRoot = dir;
  log('SnowLuma 目录设为：' + dir);
  return { ok: true, detail: '已设置为：' + dir };
});
ipcMain.handle('snowluma:open-download', () => {
  shell.openExternal('https://github.com/SnowLuma/SnowLuma/releases').catch(() => {});
  return true;
});

/* ───────────────────────── 生命周期 ───────────────────────── */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log('已有实例在跑，退出本次启动');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('检测到第二次启动，把窗口叫回来');
    showWindow();
  });

  app.whenReady().then(async () => {
    log('=== 启动 ===');
    Menu.setApplicationMenu(null);
    createTray();
    createWindow();

    const up = await probePort(bridgePort());
    if (up) {
      log('桥接已在运行，直接进控制台');
      showConsole();
    } else {
      log('桥接没在跑，显示启动页');
      showLauncher();
    }
  });

  if (process.env.QQ_AUTO_BRIDGE === '1') {
    setTimeout(() => {
      log('QQ_AUTO_BRIDGE=1，自动开始桥接');
      startAll(readSettings().uin)
        .then((r) => log('自动桥接结果：' + JSON.stringify(r)))
        .catch((e) => log('自动桥接异常：' + (e && e.stack ? e.stack : e)));
    }, 1500);
  }

  // 每 45 秒看一眼 DSH 端点：用户手动重启 DSH 之后，桥接能自己跟上
  const endpointWatch = setInterval(async () => {
    try {
      const changed = await ensureDshEndpoint();
      if (!changed) return;
      if (!await probePort(bridgePort())) return;   // 桥接没在跑就别管
      log('DSH 端点变了，自动重启桥接');
      await killBridge();
      await sleep(1500);
      await launchBridge();
      await waitForPort(bridgePort(), 45000);
      log('桥接已随新端点重启完成');
    } catch (error) {
      log('端点自检出错：' + error.message);
    }
  }, 45000);
  if (endpointWatch.unref) endpointWatch.unref();

  app.on('window-all-closed', () => {
    if (tray) {
      log('窗口全关但托盘还在，继续后台运行');
      return;
    }
    log('窗口全关且没有托盘，退出');
    app.quit();
  });

  // 真正退出前清掉托盘图标，别在任务栏留个幽灵
  app.on('before-quit', () => {
    quitting = true;
    if (tray) {
      try { tray.destroy(); } catch { /* ignore */ }
      tray = null;
    }
  });
}
