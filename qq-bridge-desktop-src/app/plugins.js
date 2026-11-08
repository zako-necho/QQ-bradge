/**
 * plugins.js —— 插件管理
 * ============================================================================
 * 插件装在**软件自己的目录**下（<软件根>/plugins/<名字>），不碰 DSH 的目录。
 *
 * 让 DSH 认到它的办法：
 *   ~/.dsh/profiles/<profile>/package.json
 *     ├─ dependencies["<name>"] = "link:<软件根>/plugins/<name>"
 *     └─ dsh.profile.bundles 里加/删 <name>
 * 这就是 DSH 官方「本地路径插件」的登记方式；link: 表示符号链接，不会复制。
 *
 * 改动 profile 前都会备份，JSON 解析失败不动手。
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const http = require('http');

const APP_DIR = __dirname;                    // resources/app
const ROOT = path.join(APP_DIR, '..', '..');  // 软件根目录
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const STATE_FILE = path.join(PLUGINS_DIR, 'plugins.json');

function log(message) {
  try {
    fs.appendFileSync(path.join(APP_DIR, 'desktop.log'), `${new Date().toISOString()} [plugins] ${message}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

/* ───────────────────────── 基础读写 ───────────────────────── */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 找当前在用的 DSH profile（优先 desktop，否则取第一个带 dsh.profile 的）。 */
function profileDir() {
  const base = path.join(dshHome(), 'profiles');
  const preferred = path.join(base, 'desktop');
  if (fs.existsSync(path.join(preferred, 'package.json'))) return preferred;
  try {
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name);
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    }
  } catch {
    /* ignore */
  }
  return '';
}

function profilePackage() {
  const dir = profileDir();
  if (!dir) return { dir: '', file: '', json: null };
  const file = path.join(dir, 'package.json');
  return { dir, file, json: readJson(file, null) };
}

/** 改 profile 前先备份，然后写入。 */
function saveProfile(file, json) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(file, `${file}.bak-plugins-${stamp}`);
  } catch {
    /* 备份失败也继续 */
  }
  writeJson(file, json);
}

function ensureDirs() {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
}

function stateOf() {
  return readJson(STATE_FILE, {});
}

function saveState(state) {
  ensureDirs();
  writeJson(STATE_FILE, state);
}

/* ───────────────────────── 插件市场（dsh-plugin-catalog） ───────────────────────── */

/**
 * DSH 插件市场的数据源是 npm 包 dsh-plugin-catalog：
 * 一个 4MB 的 index.json，里面 4800+ 个插件，每条带 npm 包名 / 双语描述 / 类别 / 版本。
 * 下载一次缓存到本地，24 小时内复用。
 */
const CATALOG_CACHE = path.join(PLUGINS_DIR, '.catalog.json');
const CATALOG_META = path.join(PLUGINS_DIR, '.catalog-meta.json');
const CATALOG_REGISTRY = 'https://registry.npmmirror.com';
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

function catalogFresh() {
  try {
    const meta = JSON.parse(fs.readFileSync(CATALOG_META, 'utf8'));
    return Date.now() - Number(meta.at || 0) < CATALOG_TTL_MS && fs.existsSync(CATALOG_CACHE);
  } catch {
    return false;
  }
}

/** 下载并解压 catalog，返回条目数组。 */
async function fetchCatalog() {
  ensureDirs();
  const work = path.join(PLUGINS_DIR, '.catalog-tmp');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  // 1) 查最新版本（/latest 只返回一个小 JSON）
  const meta = await curlJson(CATALOG_REGISTRY + '/dsh-plugin-catalog/latest', 20000);
  const version = meta && meta.version;
  if (!version) throw new Error('查不到 dsh-plugin-catalog 的最新版本');

  // 2) 下 tarball
  const tgz = path.join(work, 'catalog.tgz');
  const url = CATALOG_REGISTRY + '/dsh-plugin-catalog/-/dsh-plugin-catalog-' + version + '.tgz';
  const child = await new Promise((resolve) => {
    execFile('curl.exe', ['-L', '--fail', '--silent', '--show-error', '-o', tgz, url], {
      timeout: 180000, windowsHide: true,
    }, (error) => resolve(!error));
  });
  if (!child || !fs.existsSync(tgz)) throw new Error('catalog 下载失败');

  // 3) 解压出 index.json
  await new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', tgz, '-C', work], { timeout: 120000, windowsHide: true }, (error) => {
      if (error) reject(new Error('解压失败'));
      else resolve();
    });
  });

  const indexFile = path.join(work, 'package', 'index.json');
  if (!fs.existsSync(indexFile)) throw new Error('catalog 里没有 index.json');

  const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const plugins = Array.isArray(data.plugins) ? data.plugins : [];
  if (plugins.length === 0) throw new Error('catalog 是空的');

  fs.writeFileSync(CATALOG_CACHE, JSON.stringify(plugins), 'utf8');
  fs.writeFileSync(CATALOG_META, JSON.stringify({ at: Date.now(), version, count: plugins.length }), 'utf8');
  fs.rmSync(work, { recursive: true, force: true });
  log('插件目录已更新：' + version + '，' + plugins.length + ' 条');
  return plugins;
}

async function loadCatalog() {
  if (!catalogFresh()) {
    try {
      return await fetchCatalog();
    } catch (error) {
      log('刷新插件目录失败：' + error.message);
      try { return JSON.parse(fs.readFileSync(CATALOG_CACHE, 'utf8')); } catch { return []; }
    }
  }
  try {
    return JSON.parse(fs.readFileSync(CATALOG_CACHE, 'utf8'));
  } catch {
    return [];
  }
}

/** 按关键词搜目录（name / title / 中英描述），最多返回 30 条。 */
async function searchCatalog(query) {
  const q = String(query || '').trim().toLowerCase();
  const all = await loadCatalog();
  if (all.length === 0) return { ok: false, detail: '插件目录还没准备好（首次需要联网下载，约 4MB）', items: [] };

  const matched = all.filter((p) => {
    if (!q) return true;
    const name = String(p.name || '').toLowerCase();
    const title = String(p.title || '').toLowerCase();
    const desc = p.description || {};
    const zh = String(desc.zh || '').toLowerCase();
    const en = String(desc.en || '').toLowerCase();
    return name.indexOf(q) >= 0 || title.indexOf(q) >= 0 || zh.indexOf(q) >= 0 || en.indexOf(q) >= 0;
  });

  return {
    ok: true,
    total: matched.length,
    items: matched.slice(0, 30).map((p) => {
      const desc = p.description || {};
      const versions = Array.isArray(p.versions) ? p.versions : [];
      const latest = versions.length ? versions[versions.length - 1].version : '';
      return {
        name: p.name || '',
        title: p.title || p.name || '',
        description: desc.zh || desc.en || '',
        category: (p.metadata && p.metadata.category) || '',
        version: latest,
        homepage: p.homepage || '',
        repo: (p.repository && p.repository.url) || '',
      };
    }),
  };
}

/** 从 npm 装一个包（市场里搜到的都是 npm 包）。 */
async function installFromNpm(packageName, version) {
  ensureDirs();
  const name = String(packageName || '').trim();
  if (!name) return { ok: false, detail: '包名是空的' };

  const work = path.join(PLUGINS_DIR, '.npm-tmp-' + Date.now());
  fs.mkdirSync(work, { recursive: true });

  try {
    // 1) 查版本
    let target = version;
    if (!target) {
      const meta = await curlJson(CATALOG_REGISTRY + '/' + name.replace('/', '%2F') + '/latest', 20000);
      target = meta && meta.version;
    }
    if (!target) throw new Error('查不到版本');

    // 2) 下 tarball
    const shortName = name.split('/').pop();
    const tgz = path.join(work, 'pkg.tgz');
    const url = CATALOG_REGISTRY + '/' + name + '/-/' + shortName + '-' + target + '.tgz';
    const okDl = await new Promise((resolve) => {
      execFile('curl.exe', ['-L', '--fail', '--silent', '--show-error', '-o', tgz, url], {
        timeout: 180000, windowsHide: true,
      }, (error) => resolve(!error));
    });
    if (!okDl || !fs.existsSync(tgz)) throw new Error('下载失败：' + url);

    // 3) 解压
    await new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', tgz, '-C', work], { timeout: 120000, windowsHide: true }, (error) => {
        if (error) reject(new Error('解压失败'));
        else resolve();
      });
    });

    const sourceDir = path.join(work, 'package');
    if (!fs.existsSync(sourceDir)) throw new Error('压缩包里没有 package 目录');

    const pkg = readJson(path.join(sourceDir, 'package.json'), null);
    if (!pkg) throw new Error('包里没有 package.json');
    if (!pkg.dsh || !pkg.dsh.bundle) throw new Error('这不是 DSH 插件（缺 dsh.bundle）');

    // 4) 落到 plugins/
    const safeName = String(pkg.name || name).replace(/^@/, '').replace(/[/\\]/g, '__');
    const targetDir = path.join(PLUGINS_DIR, safeName);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(sourceDir, targetDir);
    fs.rmSync(work, { recursive: true, force: true });

    // 5) 登记
    const linked = linkIntoVendor(pkg.name, targetDir);
    const registered = linked.ok ? registerInProfile(pkg.name, linked.linkPath, true) : { ok: false, detail: linked.detail };

    const state = stateOf();
    state[safeName] = {
      name: pkg.name,
      repo: (pkg.repository && (pkg.repository.url || pkg.repository)) || '',
      version: pkg.version || target,
      installedAt: new Date().toISOString(),
      source: 'npm',
    };
    saveState(state);

    const allow = registerToolsInAllowlist(targetDir);
    log('从市场安装：' + pkg.name + ' v' + (pkg.version || target));
    return {
      ok: true,
      detail: (registered.ok
        ? '已安装 ' + pkg.name + ' v' + (pkg.version || target) + '，重启 DSH 后生效'
        : '已安装 ' + pkg.name + '，但没能写进 DSH 配置：' + registered.detail)
        + (allow.added && allow.added.length ? '；已放行 ' + allow.added.length + ' 个工具' : ''),
      name: pkg.name,
      needRestart: true,
    };
  } catch (error) {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, detail: '安装失败：' + error.message };
  }
}

/* ───────────────────────── 安装 ───────────────────────── */

/** 从各种 GitHub 写法里取出 owner/repo。 */
function parseRepo(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\.git$/, '').replace(/\/+$/, '');
  const match = cleaned.match(/github\.com[/:]([^/]+)\/([^/?#]+)/i)
    || cleaned.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/** curl 下载（git 走不通的网络里，curl 通常可以）。返回 HTTP 状态码。 */
function curlDownload(url, outFile) {
  return new Promise((resolve) => {
    execFile('curl.exe', ['-L', '-s', '-o', outFile, '-w', '%{http_code}', '--max-time', '120', url], {
      timeout: 130000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout) => {
      if (error && !stdout) return resolve('000');
      resolve(String(stdout || '').trim());
    });
  });
}

function untar(zipFile, outDir) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xf', zipFile, '-C', outDir], { timeout: 120000, windowsHide: true }, (error, _out, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(0, 300)));
      else resolve();
    });
  });
}

/**
 * 拉一个 GitHub 仓库到本地目录。
 * 优先用 git；这个网络里 git 常常连不上，就退回 curl 下 zip。
 * 返回解压出来的仓库根目录。
 */
async function fetchRepo(owner, repo, workDir) {
  const errors = [];

  // 方案 A：curl 下 zip（先 main 再 master）
  for (const branch of ['main', 'master']) {
    const url = 'https://codeload.github.com/' + owner + '/' + repo + '/zip/refs/heads/' + branch;
    const zip = path.join(workDir, 'source-' + branch + '.zip');
    const code = await curlDownload(url, zip);
    if (code !== '200') {
      errors.push(branch + ': HTTP ' + code);
      try { fs.rmSync(zip, { force: true }); } catch { /* ignore */ }
      continue;
    }
    try {
      await untar(zip, workDir);
    } catch (error) {
      errors.push(branch + ': 解压失败 ' + error.message);
      continue;
    }
    const dirs = fs.readdirSync(workDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    if (dirs.length >= 1) {
      // zip 里通常只有一层 <repo>-<branch>
      const root = dirs.find((d) => d.name.startsWith(repo)) || dirs[0];
      return path.join(workDir, root.name);
    }
    errors.push(branch + ': 解压后没有目录');
  }

  // 方案 B：git
  const gitTarget = path.join(workDir, 'git-clone');
  try {
    await new Promise((resolve, reject) => {
      execFile('git', ['clone', '--depth', '1', '--quiet',
        'https://github.com/' + owner + '/' + repo + '.git', gitTarget], {
        timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      }, (error, _stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim().slice(0, 200)));
        else resolve();
      });
    });
    return gitTarget;
  } catch (error) {
    errors.push('git: ' + error.message);
  }

  throw new Error(errors.join('；').slice(0, 300));
}

/**
 * 在 ~/.dsh/plugin-vendor/<name> 建一个 junction 指向软件目录里的插件。
 *
 * 为什么不直接把 profile 的依赖写成 link:<软件目录>：
 * DSH 的模块解析是按 vendor 布局来的，路径换了之后插件里的
 * import 可能解析不到，表现就是插件加载了但 UI 出不来。
 * junction 让 DSH 依旧看到「原生位置」，而文件实际留在我们自己的目录。
 */
function linkIntoVendor(name, targetDir) {
  const vendorDir = path.join(dshHome(), 'plugin-vendor');
  fs.mkdirSync(vendorDir, { recursive: true });

  // 处理 scope：@scope/pkg → plugin-vendor/@scope/pkg
  const parts = String(name).split('/');
  const parentDir = parts.length > 1 ? path.join(vendorDir, parts[0]) : vendorDir;
  fs.mkdirSync(parentDir, { recursive: true });
  const linkPath = path.join(parentDir, parts[parts.length - 1]);

  if (fs.existsSync(linkPath) || isLink(linkPath)) {
    const stat = safeLstat(linkPath);
    if (stat && stat.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    } else {
      // 真实目录：可能是用户原来装的同名插件，别动它
      return { ok: false, detail: 'plugin-vendor 里已经有一个同名插件（不是本程序建的），先卸载或改名再装' };
    }
  }

  fs.symlinkSync(targetDir, linkPath, 'junction');
  return { ok: true, linkPath };
}

function safeLstat(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

function isLink(p) {
  return Boolean(safeLstat(p) && safeLstat(p).isSymbolicLink());
}

/**
 * 从插件的 client.js 里抠出它注册的「设置页」信息。
 * 插件通常这么写：
 *   slots.register({ name: 'settings.section', id: 'bili-scroll', order: 30, label: '刷B站' }, ...)
 * 我们只要 id 和 label——后者用于在 DSH 设置面板里找到那一项。
 */
function parseClientSettings(dir) {
  const file = path.join(dir, 'client.js');
  if (!fs.existsSync(file)) return null;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }

  const idx = text.indexOf('settings.section');
  if (idx < 0) return null;

  // 注册对象通常就在附近
  const chunk = text.slice(Math.max(0, idx - 200), idx + 900);
  const idMatch = chunk.match(/id\s*:\s*['"`]([^'"`]+)['"`]/);
  const labelMatch = chunk.match(/label\s*:\s*['"`]([^'"`]+)['"`]/);
  if (!idMatch && !labelMatch) return null;
  return {
    id: idMatch ? idMatch[1] : '',
    label: labelMatch ? labelMatch[1] : '',
  };
}

/* ───────────────────────── 插件配置读写 ───────────────────────── */

/** qq-bridge 自带 js-yaml，直接借它的解析器（找不到就降级成"不能配"）。 */
function loadYaml() {
  const candidates = [
    process.env.QQ_BRIDGE_ROOT,
    path.join(os.homedir(), 'Documents', 'deepseek-harness', 'qq-bridge'),
    path.join(os.homedir(), 'deepseek-harness', 'qq-bridge'),
    'D:/DSH/qq-bridge',
    'C:/qq-bridge',
  ].filter(Boolean);

  for (const root of candidates) {
    const lib = path.join(root, 'node_modules', 'js-yaml');
    if (fs.existsSync(lib)) {
      try { return require(lib); } catch { /* 换下一个 */ }
    }
  }
  return null;
}

/** 所有可能写着插件 config 的 patch 文件。 */
function configFiles() {
  const files = [];
  const profile = profileDir();
  if (profile) files.push(path.join(profile, 'cordis.patch.yml'));

  // 桥接自带的 preset patch（qq-chat / qq-chat-v2 就在这里）
  const bridgeRoots = [
    process.env.QQ_BRIDGE_ROOT,
    path.join(os.homedir(), 'Documents', 'deepseek-harness', 'qq-bridge'),
  ].filter(Boolean);
  for (const root of bridgeRoots) {
    const presets = path.join(root, 'plugins', 'qq-agent-presets', 'presets');
    if (!fs.existsSync(presets)) continue;
    try {
      for (const name of fs.readdirSync(presets)) {
        if (name.endsWith('.patch.yml')) files.push(path.join(presets, name));
      }
    } catch { /* ignore */ }
  }
  return files;
}

/**
 * 从插件代码里猜出它的配置字段和类型。
 *
 * 大多数 Cordis 插件会写：
 *   export const Config = Schema.object({
 *     enabled: Schema.boolean().default(true),
 *     perDay: Schema.number().default(6),
 *   })
 * 这里用正则把「字段名 + Schema 类型」抠出来，给没配过的插件生成一份骨架表单。
 * 解析不到就返回 null，调用方降级成"没有可编辑配置"。
 */
function parseConfigSchema(dir) {
  // 主文件可能是 index.js 或 lib/index.js
  const candidates = [
    path.join(dir, 'index.js'),
    path.join(dir, 'lib', 'index.js'),
    path.join(dir, 'src', 'index.js'),
  ];
  let source = '';
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) { source = fs.readFileSync(f, 'utf8'); break; }
    } catch { /* 换下一个 */ }
  }
  if (!source) return null;

  // Windows 上插件文件多半是 CRLF，统一成 LF 再解析，
  // 否则 /\n\}/ 这种正则永远匹配不上
  source = source.replace(/\r\n/g, '\n');

  // ① 先找插件自己的默认配置对象（最准：有真实默认值）
  const defaultsHead = source.match(/(?:const|let|var)\s+(?:DEFAULTS|DEFAULT_CONFIG|defaults)\s*=\s*\{/);
  if (defaultsHead) {
    const braceIdx = defaultsHead.index + defaultsHead[0].length - 1;
    const literal = extractObjectLiteral(source, braceIdx);
    if (literal) {
      try {
        // 纯对象字面量，当表达式求值（不执行函数、不联网）
        const obj = new Function('return (' + literal + ');')();
        if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length > 0) {
          return obj;
        }
      } catch { /* 解析不了就退回 Schema */ }
    }
  }

  // ② 再找 Schema.object({...}) 的字段定义
  const start = source.search(/Schema\.object\s*\(\s*\{/);
  if (start < 0) return null;

  // 从 Schema.object({ 往后取一段（够覆盖大多数配置对象）
  const chunk = source.slice(start, start + 8000);

  const fields = {};
  const re = /([\w$]+)\s*:\s*Schema\.(boolean|number|natural|percent|string|array|object|union|dict|date|const)\s*\(/g;
  let m;
  while ((m = re.exec(chunk)) !== null) {
    const key = m[1];
    const type = m[2];
    if (fields[key] !== undefined) continue;
    if (type === 'boolean') fields[key] = false;
    else if (type === 'number' || type === 'natural' || type === 'percent') fields[key] = 0;
    else if (type === 'array') fields[key] = [];
    else if (type === 'object' || type === 'dict') fields[key] = {};
    else fields[key] = '';
  }

  return Object.keys(fields).length > 0 ? fields : null;
}

/**
 * 有些插件不把配置交给 Cordis，而是自己存一个 JSON 文件
 * （比如 dsh-startup-screen 存在 ~/.dsh/dsh-startup.json）。
 * 这里按名字猜几个常见位置去读，读到了就能配。
 */
function findPluginConfigFile(name) {
  const home = dshHome();
  const short = String(name).replace(/^dsh[-_]/, '');
  const candidates = [
    path.join(home, name + '.json'),
    path.join(home, short + '.json'),
    path.join(home, name, 'config.json'),
    path.join(home, short, 'config.json'),
    path.join(home, 'plugins', name, 'config.json'),
  ];

  // 再补一轮：扫 ~/.dsh 顶层 json，名字跟插件名有交集的
  try {
    for (const entry of fs.readdirSync(home)) {
      if (!entry.endsWith('.json')) continue;
      const base = entry.replace(/\.json$/, '');
      if (base === name || base === short) continue;
      if (name.indexOf(base) >= 0 || base.indexOf(short) >= 0) {
        candidates.push(path.join(home, entry));
      }
    }
  } catch { /* ignore */ }

  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
        return { file: f, config: parsed };
      }
    } catch { /* 换下一个 */ }
  }
  return null;
}

/**
 * 从代码里抠出一个完整的对象字面量。
 * 比正则可靠：能处理嵌套对象、字符串里的括号、行注释。
 * @param {string} source 源码
 * @param {number} start 指向 '{' 的下标
 */
function extractObjectLiteral(source, start) {
  let depth = 0;
  let inStr = false;
  let quote = '';
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inStr) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; quote = ch; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

/** 用 curl 拿一个 JSON（registry 会重定向 + 响应很大，http.get 容易超时）。 */
function curlJson(url, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile('curl.exe', ['-L', '-s', '--max-time', String(Math.floor(timeoutMs / 1000)), url], {
      timeout: timeoutMs + 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => {
      if (error || !stdout) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

/** 找 qq-bridge 根目录（白名单文件在那儿）。 */
function findBridgeRoot() {
  const candidates = [
    process.env.QQ_BRIDGE_ROOT,
    path.join(os.homedir(), 'Documents', 'deepseek-harness', 'qq-bridge'),
    path.join(os.homedir(), 'deepseek-harness', 'qq-bridge'),
    'D:/DSH/qq-bridge',
    'C:/qq-bridge',
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'config.json'))) return dir;
    } catch { /* 换下一个 */ }
  }
  return '';
}

/**
 * 从插件代码里找出它注册的工具名。
 * 常见的两种写法：
 *   ctx.tools.register(defineTool({ name: 'xxx', ... }))
 *   ctx.tools.register({ name: 'xxx', ... })        （外面包一层本地 defineTool）
 * 只在 register/defineTool 附近取 name，避免误抓别的 name 字段。
 */
function extractToolNames(dir) {
  const candidates = ['index.js', path.join('lib', 'index.js'), path.join('src', 'index.js')];
  const names = new Set();

  for (const rel of candidates) {
    const f = path.join(dir, rel);
    if (!fs.existsSync(f)) continue;
    let src = '';
    try { src = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); } catch { continue; }

    // 插件的工具名都是 snake_case（bili_whoami / phone_status / waimai_open …），
    // 所以直接扫「带下划线的 name: 'xxx'」就够了，比追 register 调用可靠得多
    // （各家写法不一样：tool(...) / defineTool(...) / {...spec} 包装）。
    const re = /name\s*:\s*['"`]([a-z][a-z0-9]*(?:_[a-z0-9]+)+)['"`]/g;
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }

  return [...names];
}

/**
 * 把插件提供的工具加进桥接的 QQ 工具白名单。
 * 白名单文件：qq-bridge/state/tool-allowlist.json（qq-tool-restrict 按 mtime 现读，改完即生效）。
 */
function registerToolsInAllowlist(dir) {
  const bridge = findBridgeRoot();
  if (!bridge) return { ok: false, detail: '没找到 qq-bridge 目录' };

  const tools = extractToolNames(dir);
  if (tools.length === 0) return { ok: true, added: [], detail: '这个插件没有对外工具' };

  const allowFile = path.join(bridge, 'state', 'tool-allowlist.json');
  let doc = { allow: [], deny: [], note: '' };
  try {
    if (fs.existsSync(allowFile)) {
      doc = JSON.parse(fs.readFileSync(allowFile, 'utf8').replace(/^\uFEFF/, ''));
    }
  } catch {
    return { ok: false, detail: '白名单文件解析失败，没敢动它' };
  }

  if (!Array.isArray(doc.allow)) doc.allow = [];
  if (!Array.isArray(doc.deny)) doc.deny = [];

  const added = [];
  for (const name of tools) {
    if (!doc.allow.includes(name)) { doc.allow.push(name); added.push(name); }
  }
  if (added.length === 0) return { ok: true, added: [], detail: '工具已经在白名单里' };

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (fs.existsSync(allowFile)) fs.copyFileSync(allowFile, allowFile + '.bak-allow-' + stamp);

    const noteStamp = new Date().toISOString().slice(0, 10);
    doc.note = String(doc.note || '')
      + '\n' + noteStamp + '：放行 ' + path.basename(dir) + ' 的工具（' + added.join(' / ')
      + '）—— 从桥接插件页安装时自动加入，让 QQ 会话能使用这个插件。';

    fs.writeFileSync(allowFile, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    log('工具白名单已更新：' + added.join(', '));
    return { ok: true, added, detail: '已把 ' + added.length + ' 个工具加进 QQ 白名单：' + added.join('、') };
  } catch (error) {
    return { ok: false, detail: '写白名单失败：' + error.message };
  }
}

/** 读 qq-bridge 的 config（拿 DSH 地址）。 */
function bridgeDshBase() {
  const candidates = [
    process.env.QQ_BRIDGE_ROOT,
    path.join(os.homedir(), 'Documents', 'deepseek-harness', 'qq-bridge'),
    path.join(os.homedir(), 'deepseek-harness', 'qq-bridge'),
    'D:/DSH/qq-bridge',
    'C:/qq-bridge',
  ].filter(Boolean);
  for (const root of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
      const base = cfg && cfg.dsh && cfg.dsh.baseUrl;
      if (base) return base.replace(/\/+$/, '');
    } catch { /* 换下一个 */ }
  }
  return '';
}

/** GET 一个 JSON 地址，3 秒超时。 */
function httpGetJsonQuiet(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

/** POST 一个 JSON，3 秒超时，返回响应体。 */
function httpPostJsonQuiet(url, body, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const target = new URL(url);
      const req = http.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: 'POST',
        timeout: timeoutMs,
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } resolve(null); });
      req.write(payload);
      req.end();
    } catch {
      resolve(null);
    }
  });
}

/**
 * 扫插件代码，找它自己注册的 config 路由。
 * 很多插件不把配置放在 Cordis 里，而是自己开个 HTTP 接口读写
 * （比如 dsh-startup-screen 的 /dsh-startup/config）。
 */
function findPluginConfigRoute(dir) {
  const candidates = ['index.js', path.join('lib', 'index.js'), path.join('src', 'index.js')];
  for (const rel of candidates) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) continue;
    let src = '';
    try { src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { continue; }

    // 代码里可能有 const ROUTE_BASE = '/dsh-startup'
    const baseMatch = src.match(/ROUTE_BASE\s*=\s*['"`]([^'"`]+)['"`]/);
    const routeBase = baseMatch ? baseMatch[1].replace(/\/+$/, '') : '';

    // 找 path: '...config' / path: ROUTE_BASE + '/config'
    const lines = src.split('\n');
    for (const line of lines) {
      if (!/path\s*:/.test(line)) continue;
      if (!/config/i.test(line)) continue;

      const lit = line.match(/['"`]([^'"`]*config[^'"`]*)['"`]/i);
      if (lit) {
        let route = lit[1];
        if (!route.startsWith('/') && routeBase) route = routeBase + '/' + route;
        if (!route.startsWith('/') && routeBase) route = routeBase + '/' + route;
        return route.replace(/\/{2,}/g, '/');
      }
      if (routeBase) return routeBase + '/config';
    }
  }
  return '';
}

/**
 * 尝试调插件自己的 config 接口。
 * 插件没被 DSH 加载时这个路由不存在，会超时/404 —— 调用方据此降级。
 */
async function tryPluginConfigApi(dir) {
  const route = findPluginConfigRoute(dir);
  if (!route) return null;

  const base = bridgeDshBase();
  if (!base) return null;

  const url = base + route;
  const info = await httpGetJsonQuiet(url);
  if (!info || typeof info !== 'object') return null;

  // 各家返回格式不一：{config} / {config, defaults} / 直接就是配置对象
  const config = info.config && typeof info.config === 'object'
    ? info.config
    : (info.settings && typeof info.settings === 'object' ? info.settings : null);
  if (!config) return null;

  return { route, url, config, defaults: info.defaults || null };
}

/**
 * 在 patch 文件里找某个插件的配置行。
 * patch 结构：- insert: [ { id, name, config }, ... ]
 */
function findConfigEntry(name) {
  const yaml = loadYaml();
  if (!yaml) return { ok: false, detail: '找不到 js-yaml（需要 qq-bridge 的 node_modules）' };

  for (const file of configFiles()) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(doc)) continue;
    for (const block of doc) {
      if (!block) continue;

      // 形态 1：{ insert: [ { id, name, config } ] }
      if (Array.isArray(block.insert)) {
        for (const entry of block.insert) {
          if (entry && (entry.name === name || entry.id === name)) {
            return { ok: true, file, doc, entry, yaml };
          }
        }
        continue;
      }

      // 形态 2：顶层 { id, name, config } —— 按 id 定位的配置覆盖
      if (block.name === name || block.id === name) {
        return { ok: true, file, doc, entry: block, yaml };
      }
    }
  }
  return { ok: false, detail: '在所有 patch 文件里都没找到这个插件的配置行' };
}

/** 读插件的 config。 */
async function getPluginConfig(name) {
  // ① 插件自己的 config 接口最原生 —— 但插件没被 DSH 加载时这个路由不存在，
  //    探测会超时/404，那就往下走，绝不卡住。
  let item = null;
  try {
    // 桥接自己装的插件在列表里；DSH 里自带的插件不在，需要去 vendor 里捞
    item = listPlugins().find((p) => p.name === name) || null;
    if (!item) item = vendorPlugins().find((p) => p.name === name) || null;
  } catch { /* ignore */ }

  if (item) {
    try {
      const viaApi = await tryPluginConfigApi(item.path);
      if (viaApi) {
        return {
          ok: true,
          config: viaApi.config,
          file: '',
          id: name,
          source: 'api',
          route: viaApi.route,
          detail: '配置来自插件自己的接口 ' + viaApi.route,
        };
      }
    } catch { /* 继续降级 */ }
  }

  // ② 插件自己存配置文件的情况
  try {
    const own = findPluginConfigFile(name);
    if (own) {
      return {
        ok: true,
        config: own.config,
        file: own.file,
        id: name,
        source: 'file',
        detail: '配置来自插件自己的文件 ' + own.file,
      };
    }
  } catch { /* 继续降级 */ }

  const hit = findConfigEntry(name);

  if (hit.ok) {
    return {
      ok: true,
      config: hit.entry.config || {},
      file: hit.file,
      id: hit.entry.id || hit.entry.name,
      source: 'patch',
    };
  }

  // 没配过：从插件代码的 Schema 里生成一份骨架，让用户也能用表单填
  try {
    let item = listPlugins().find((p) => p.name === name);
    if (!item) item = vendorPlugins().find((p) => p.name === name);
    if (item) {
      const skeleton = parseConfigSchema(item.path);
      if (skeleton) {
        return {
          ok: true,
          config: skeleton,
          file: '',
          id: name,
          source: 'schema',
          detail: '这个插件还没配置过，字段是从它的代码里推断的；保存后会写入 profile 配置。',
        };
      }
    }
  } catch { /* 解析失败就走下面的失败分支 */ }

  return { ok: false, detail: hit.detail, config: {} };
}

/** 写插件的 config（自动备份）。 */
async function savePluginConfig(name, config) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { ok: false, detail: 'config 必须是一个对象' };
  }

  // 如果这个插件的配置是自己管的（有 config 接口），优先写回它的接口
  try {
    let item = listPlugins().find((p) => p.name === name);
    if (!item) item = vendorPlugins().find((p) => p.name === name);
    if (item) {
      const route = findPluginConfigRoute(item.path);
      const base = bridgeDshBase();
      if (route && base) {
        const posted = await httpPostJsonQuiet(base + route, { config });
        const okPost = posted && (posted.ok === true || posted.saved === true || posted.config);
        if (okPost) {
          log('已通过插件接口保存配置：' + name + ' -> ' + route);
          return { ok: true, detail: '已写入插件自己的配置（重启 DSH 后生效）', file: route, needRestart: true };
        }
      }
    }
  } catch { /* 接口不行就走 patch */ }

  const yaml = loadYaml();
  if (!yaml) return { ok: false, detail: '找不到 js-yaml（需要 qq-bridge 的 node_modules）' };

  const hit = findConfigEntry(name);

  try {
    if (hit.ok) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.copyFileSync(hit.file, hit.file + '.bak-config-' + stamp);
      hit.entry.config = config;
      fs.writeFileSync(hit.file, hit.yaml.dump(hit.doc, { lineWidth: 200 }), 'utf8');
      log('已保存插件配置：' + name + ' -> ' + hit.file);
      return { ok: true, detail: '已保存，重启 DSH 后生效', file: hit.file, needRestart: true };
    }

    // 没有现成配置行 → 在 profile 的 patch 里新建一条覆盖项
    const profile = profileDir();
    if (!profile) return { ok: false, detail: '找不到 DSH profile 目录' };
    const patchFile = path.join(profile, 'cordis.patch.yml');
    let doc = [];
    try { doc = yaml.load(fs.readFileSync(patchFile, 'utf8')) || []; } catch { doc = []; }
    if (!Array.isArray(doc)) doc = [];

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (fs.existsSync(patchFile)) fs.copyFileSync(patchFile, patchFile + '.bak-config-' + stamp);

    doc.push({ id: name, name, config });
    fs.writeFileSync(patchFile, yaml.dump(doc, { lineWidth: 200 }), 'utf8');
    log('已新建插件配置项：' + name + ' -> ' + patchFile);
    return { ok: true, detail: '已新建配置并保存，重启 DSH 后生效', file: patchFile, needRestart: true };
  } catch (error) {
    return { ok: false, detail: '保存失败：' + error.message };
  }
}

/** 扫 ~/.dsh/plugin-vendor，看看 DSH 里已经装了哪些插件。 */
function vendorPlugins() {
  const vendorDir = path.join(dshHome(), 'plugin-vendor');
  const found = [];

  const scan = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      // scope 目录（@xxx）再下一层
      if (entry.name.startsWith('@') && depth === 0) { scan(full, 1); continue; }
      const pkgFile = path.join(full, 'package.json');
      if (!fs.existsSync(pkgFile)) continue;
      const pkg = readJson(pkgFile, null);
      if (!pkg || !pkg.dsh || !pkg.dsh.bundle) continue;
      found.push({
        name: pkg.name || entry.name,
        version: pkg.version || '',
        description: pkg.description || '',
        hasSettings: Boolean(pkg.dsh.client),
        path: full,
      });
    }
  };

  scan(vendorDir, 0);
  return found;
}

/**
 * DSH 只从 profile/node_modules 里加载插件，光写 dependencies + bundles 不够。
 * 这里在 node_modules 里建一个 junction 指向插件真实目录——
 * 参照 dsh-qq-proactive 就是这么装的。
 */
function ensureNodeModulesLink(name, targetDir) {
  const dir = profileDir();
  if (!dir) return false;
  const nm = path.join(dir, 'node_modules');
  try { fs.mkdirSync(nm, { recursive: true }); } catch { return false; }

  const parts = String(name).split('/');
  const parent = parts.length > 1 ? path.join(nm, parts[0]) : nm;
  try { fs.mkdirSync(parent, { recursive: true }); } catch { /* ignore */ }
  const linkPath = path.join(parent, parts[parts.length - 1]);

  const stat = safeLstat(linkPath);
  if (stat) {
    if (stat.isSymbolicLink()) {
      try { fs.unlinkSync(linkPath); } catch { return false; }
    } else {
      // 真实目录：pnpm 已经装好的，别动
      return true;
    }
  }

  try {
    fs.symlinkSync(targetDir, linkPath, 'junction');
    log('node_modules 链接已建：' + linkPath + ' -> ' + targetDir);
    return true;
  } catch (error) {
    log('node_modules 链接失败：' + error.message);
    return false;
  }
}

/** 把一个目录登记进 DSH profile（dependencies + bundles）。 */
function registerInProfile(name, dir, enable) {
  const { file, json } = profilePackage();
  if (!file || !json) return { ok: false, detail: '没找到 DSH 的 profile 配置（~/.dsh/profiles/*/package.json）' };

  json.dependencies = json.dependencies || {};
  json.dependencies[name] = `link:${dir.replace(/\\/g, '/')}`;

  json.dsh = json.dsh || {};
  json.dsh.profile = json.dsh.profile || {};
  const bundles = Array.isArray(json.dsh.profile.bundles) ? json.dsh.profile.bundles : (json.dsh.profile.bundles = []);
  const at = bundles.indexOf(name);
  if (enable && at < 0) bundles.push(name);
  if (!enable && at >= 0) bundles.splice(at, 1);

  saveProfile(file, json);

  // DSH 从 node_modules 加载插件，补上这个链接才算真正装好
  if (enable) ensureNodeModulesLink(name, dir);

  return { ok: true };
}

function unregisterFromProfile(name) {
  const { file, json } = profilePackage();
  if (!file || !json) return;
  if (json.dependencies) delete json.dependencies[name];
  const bundles = json.dsh && json.dsh.profile && json.dsh.profile.bundles;
  if (Array.isArray(bundles)) {
    const at = bundles.indexOf(name);
    if (at >= 0) bundles.splice(at, 1);
  }
  saveProfile(file, json);
}

/**
 * 安装：git clone 到 plugins/<包名>，然后登记到 DSH profile。
 * @param {string} repoInput GitHub 地址或 owner/repo
 */
async function installPlugin(repoInput) {
  ensureDirs();
  const parsed = parseRepo(repoInput);
  if (!parsed) return { ok: false, detail: '看不懂这个地址，示例：https://github.com/owner/repo' };

  const temp = path.join(PLUGINS_DIR, `.tmp-${parsed.repo}-${Date.now()}`);
  fs.mkdirSync(temp, { recursive: true });
  log('开始安装：' + parsed.owner + '/' + parsed.repo);

  let sourceDir;
  try {
    sourceDir = await fetchRepo(parsed.owner, parsed.repo, temp);
  } catch (error) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
    log('下载失败：' + error.message);
    return { ok: false, detail: '下载失败：' + error.message };
  }

  const pkg = readJson(path.join(sourceDir, 'package.json'), null);
  if (!pkg) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, detail: '这个仓库没有 package.json，不是 DSH 插件' };
  }
  if (!pkg.dsh || !pkg.dsh.bundle) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, detail: 'package.json 里没有 dsh.bundle 字段，不像 DSH 插件' };
  }

  const name = pkg.name || parsed.repo;
  const safeName = name.replace(/^@/, '').replace(/[/\\]/g, '__');
  const target = path.join(PLUGINS_DIR, safeName);

  try {
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(sourceDir, target);
    fs.rmSync(temp, { recursive: true, force: true });
  } catch (error) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, detail: '写入插件目录失败：' + error.message };
  }

  // 记一下来源，方便以后显示/升级
  const state = stateOf();
  state[safeName] = {
    name,
    repo: `${parsed.owner}/${parsed.repo}`,
    version: pkg.version || '',
    installedAt: new Date().toISOString(),
  };
  saveState(state);

  // 挂进 plugin-vendor，让 DSH 用原生路径看到它
  const linked = linkIntoVendor(name, target);
  if (!linked.ok) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
    // DSH 里已经有一份同名插件？那就别重复装，问用户要不要直接纳管
    const existing = vendorPlugins().find((p) => p.name === name) || null;
    return {
      ok: false,
      conflict: Boolean(existing),
      existing,
      detail: existing
        ? 'DSH 里已经装了 ' + name + (existing.version ? ' v' + existing.version : '') + '，可以把它直接加入桥接管理，不用重复安装。'
        : linked.detail,
    };
  }

  const registered = registerInProfile(name, linked.linkPath, true);

  // 顺手把这个插件的工具放进 QQ 白名单，机器人才能调用
  const allow = registerToolsInAllowlist(target);

  log('安装完成：' + name + ' -> ' + target + '（vendor 链接：' + linked.linkPath + '）');

  return {
    ok: true,
    detail: (registered.ok
      ? `已安装 ${name}，重启 DSH 后生效`
      : `已安装 ${name}，但没能写进 DSH 配置：${registered.detail}`)
      + (allow.added && allow.added.length ? `；已放行 ${allow.added.length} 个工具：${allow.added.join('、')}` : ''),
    name,
    needRestart: true,
  };
}

/* ───────────────────────── 列表 / 启停 / 卸载 ───────────────────────── */

function listPlugins() {
  ensureDirs();
  const { json } = profilePackage();
  const bundles = (json && json.dsh && json.dsh.profile && json.dsh.profile.bundles) || [];
  const state = stateOf();

  let entries = [];
  try {
    entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    entries = [];
  }

  // 桥接自己目录里的插件
  const own = entries.map((dirName) => {
    const dir = path.join(PLUGINS_DIR, dirName);
    const pkg = readJson(path.join(dir, 'package.json'), {});
    const name = pkg.name || dirName;
    const hasClient = Boolean(pkg.dsh && pkg.dsh.client);
    const clientInfo = hasClient ? parseClientSettings(dir) : null;
    return {
      dirName,
      name,
      version: pkg.version || '',
      description: pkg.description || '',
      enabled: bundles.includes(name),
      hasSettings: hasClient,
      settingsId: clientInfo ? clientInfo.id : '',
      settingsLabel: clientInfo ? clientInfo.label : '',
      repo: (state[dirName] && state[dirName].repo) || '',
      path: dir,
    };
  });

  // 被「纳管」的外部插件：文件还在 DSH 的 plugin-vendor 里，这里只是引用
  const adopted = Object.entries(state)
    .filter(([, info]) => info && info.external)
    .map(([key, info]) => {
      const pkg = readJson(path.join(info.path || '', 'package.json'), {});
      const name = info.name || pkg.name || key;
      const hasClient = Boolean(pkg.dsh && pkg.dsh.client);
      const clientInfo = hasClient ? parseClientSettings(info.path) : null;
      return {
        dirName: key,
        name,
        version: pkg.version || info.version || '',
        description: pkg.description || '',
        enabled: bundles.includes(name),
        hasSettings: hasClient,
        settingsId: clientInfo ? clientInfo.id : '',
        settingsLabel: clientInfo ? clientInfo.label : '',
        repo: info.repo || '',
        path: info.path || '',
        external: true,
      };
    })
    .filter((item) => item.path && fs.existsSync(item.path));

  return own.concat(adopted).sort((a, b) => a.name.localeCompare(b.name));
}

function setPluginEnabled(name, enabled) {
  const list = listPlugins();
  const item = list.find((p) => p.name === name);
  if (!item) return { ok: false, detail: '没找到这个插件' };

  const result = registerInProfile(name, item.path, Boolean(enabled));
  if (!result.ok) return result;

  const state = stateOf();
  state[item.dirName] = { ...(state[item.dirName] || {}), name, enabled: Boolean(enabled), changedAt: new Date().toISOString() };
  saveState(state);

  log(`${enabled ? '启用' : '关闭'}插件：${name}`);
  return { ok: true, detail: enabled ? `已启用 ${name}，重启 DSH 后生效` : `已关闭 ${name}，重启 DSH 后生效`, needRestart: true };
}

/**
 * 把 DSH 里**已经装好**的插件加入桥接管理。
 * 不复制文件、不改安装位置，只是记一条「引用」，桥接列表里就能看到它、
 * 开关它、点它的设置——用的始终是 DSH 里那一份。
 */
function adoptPlugin(name) {
  const existing = vendorPlugins().find((p) => p.name === name);
  if (!existing) return { ok: false, detail: 'DSH 的 plugin-vendor 里没找到 ' + name };

  const state = stateOf();
  state[name] = {
    ...(state[name] || {}),
    name,
    external: true,
    path: existing.path,
    version: existing.version,
    adoptedAt: new Date().toISOString(),
  };
  saveState(state);

  // 确保 profile 里有它（一般早就在了，这里只是兜底）
  registerInProfile(name, existing.path, true);
  const allow = registerToolsInAllowlist(existing.path);

  log('已纳管外部插件：' + name + ' -> ' + existing.path);
  return {
    ok: true,
    detail: '已把 ' + name + ' 加入桥接管理，直接使用 DSH 里的那一份（不复制文件）'
      + (allow.added && allow.added.length ? '；已放行 ' + allow.added.length + ' 个工具' : ''),
    needRestart: false,
  };
}

function uninstallPlugin(name) {
  const list = listPlugins();
  const item = list.find((p) => p.name === name);
  if (!item) return { ok: false, detail: '没找到这个插件' };

  // 纳管进来的外部插件：只从桥接列表移除，绝不动 DSH 里的文件
  if (item.external) {
    const state = stateOf();
    delete state[item.dirName];
    saveState(state);
    log('已移出桥接管理（未删 DSH 文件）：' + name);
    return { ok: true, detail: '已把 ' + name + ' 移出桥接管理（DSH 里的文件没有删）' };
  }

  try {
    fs.rmSync(item.path, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, detail: '删不掉插件目录：' + error.message };
  }

  // 删掉 vendor 里的 junction（只删链接，绝不动真实目录）
  try {
    const parts = String(name).split('/');
    const vendorDir = path.join(dshHome(), 'plugin-vendor');
    const linkPath = parts.length > 1
      ? path.join(vendorDir, parts[0], parts[parts.length - 1])
      : path.join(vendorDir, parts[parts.length - 1]);
    if (isLink(linkPath)) fs.unlinkSync(linkPath);
  } catch { /* ignore */ }

  unregisterFromProfile(name);
  const state = stateOf();
  delete state[item.dirName];
  saveState(state);

  log('已卸载：' + name);
  return { ok: true, detail: `已卸载 ${name}，重启 DSH 后生效` };
}

/** 插件简介（给 UI 用）。 */
function pluginSummary() {
  const { dir } = profilePackage();
  return {
    pluginsDir: PLUGINS_DIR,
    profileDir: dir,
    profileReachable: Boolean(dir),
    items: listPlugins(),
  };
}

module.exports = {
  PLUGINS_DIR,
  profileDir,
  pluginSummary,
  installPlugin,
  installFromNpm,
  registerToolsInAllowlist,
  searchCatalog,
  adoptPlugin,
  getPluginConfig,
  savePluginConfig,
  setPluginEnabled,
  uninstallPlugin,
  parseRepo,
};
