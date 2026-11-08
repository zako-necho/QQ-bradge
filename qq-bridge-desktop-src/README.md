# QQ 桥接桌面版

把 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 的控制台装进一个窗口。双击 `QQ桥接.exe` 看到的就是它原本那个界面（运行总览、会话与审批、人格与角色、二代仿真、一代仿真、黑话词库、令牌与花费、访问与安全、调试与运维、工具参考）——**UI 一行没改**。

额外多做的几件事：

- **启动页**：桥接没跑时显示，两个居中按钮（开始桥接 / 配置 SnowLuma）+ QQ 号输入框；
- **一键启动**：先确认 DSH 在不在（不在就帮你启动），再拉 SnowLuma、再拉桥接；
- **桥接日志页**：桥接不再弹黑窗，输出收进控制台侧边栏的「桥接日志」；
- **托盘常驻**：点 × 收进托盘，右键菜单才能真退出。

## 直接使用

下载 Release 里的 zip，解压到任意目录，双击 `QQ桥接.exe`。

需要本机已经有：

| 依赖 | 说明 |
|---|---|
| [DeepSeek Harness](https://github.com/…) | 主进程；桌面版或 `dsh web` 都行 |
| [qq-bridge](https://github.com/Derpyu520/qq-bridge) | 控制台和桥接后端 |
| [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases) | QQ 协议端（可选，但没它 QQ 收不到消息） |

这三个都不在默认位置也能用——启动页的「配置 SnowLuma」可以选目录，另外还有环境变量：

```
QQ_BRIDGE_ROOT=D:\path\to\qq-bridge
DSH_EXE=D:\path\to\DeepSeek Harness.exe
SNOWLUMA_ROOT=D:\path\to\SnowLuma
```

## 发布（维护者看）

三种方式，按省心程度排：

**1. GitHub Actions（推荐）**：推一个标签，自动构建并挂到 Release。

```bash
git tag v1.0.0
git push origin v1.0.0
```

`.github/workflows/release.yml` 会在 windows-latest 上跑 `build.ps1`，把产物压成
`qq-bridge-desktop-v1.0.0-win-x64.zip` 挂到 Release 下。别人点 Releases 就能下载。

**2. 手动**：本地跑 `.\build.ps1`，把 `dist\` 压成 zip，拖进 Release 附件。

**3. 只发源码**：别人自己 `build.ps1`。（对普通用户不友好，他们还得装 Node 环境——虽然脚本不依赖 Node，但要下 150MB 的 Electron。）

> ⚠️ **仓库里不要提交 exe**：GitHub 单文件限制 100MB，而 `QQ桥接.exe` 有 250MB。
> 成品一律走 Release 附件，源码走仓库。

## 从源码构建

```powershell
git clone <本仓库>
cd qq-bridge-desktop
.\build.ps1
```

脚本会从 npmmirror 镜像下载 Electron、解压、把你的 `app/` 塞进 `resources/app`、把 `electron.exe` 改名成 `QQ桥接.exe`。

产物在 `dist/`，约 350MB（Electron 占绝大部分）。

exe 的图标需要 rcedit 才能写进去（`build.ps1` 会自动去 npmmirror 拉一份，拉不到就跳过）。

没 rcedit 也能跑，只是 exe 显示 Electron 默认图标；托盘图标不受影响（它读 `app/icon.ico`）。

> 仓库里**不放**打包好的 exe：GitHub 单文件限制 100MB，而这个 exe 有 250MB。
> 成品走 Release 附件，源码走仓库。

## 插件管理

控制台左侧「**管理 → 插件管理**」可以装 DSH 插件。插件装在**软件自己的 `plugins/` 目录**，不写进 DSH 的安装目录。

- 填 GitHub 地址（`owner/repo` 也认），点「安装」。优先用 curl 下 zip（`git clone` 在很多网络里连不上），解压后校验 `package.json` 的 `dsh.bundle`，不是插件就明确报错并清理临时目录；
- 每个插件一张卡片：勾选框启用/关闭、版本、描述、来源仓库；
- 有 `dsh.client` 的插件会多一个「**设置**」按钮——点它把 DSH 窗口叫到前台，插件作者做的设置界面在 DSH 的「设置 → 插件」里（插件 UI 是注册在 DSH 设置页的，这边没法单独渲染）；
- 「卸载」会同时删目录并从 DSH 配置里移除。

**它怎么让 DSH 认到**：两步。

1. 在 `~/.dsh/plugin-vendor/<插件名>` 建一个 **junction** 指向软件目录里的插件；
2. 改 `~/.dsh/profiles/<profile>/package.json`：

```json
"dependencies": { "<插件名>": "file:<home>/.dsh/plugin-vendor/<插件名>" },
"dsh": { "profile": { "bundles": [ "…", "<插件名>" ] } }
```

**为什么用 junction 而不是直接把依赖写成 `link:<软件目录>`**：DSH 的模块解析是按 vendor 布局来的，
路径换到软件目录后插件里的 `import` 可能解析不到（实测表现就是插件加载了但设置界面出不来）。
junction 让 DSH 依旧看到原生位置，文件实际留在我们自己的目录，卸载时只删链接不动真实文件。

同名插件会被拒绝：如果 `plugin-vendor` 里已经有一个**真实目录**（你原本装的），
安装会返回「先卸载或改名再装」，不会偷偷覆盖。

每次写入 profile 前都会自动备份成 `package.json.bak-plugins-<时间戳>`；解析不了 JSON 就完全不动手。

> **安装 / 启用 / 关闭 / 卸载之后都要重启 DSH 才生效**（DSH 启动时才读 bundles）。
> 插件页上有「**应用变更（重启 DSH）**」按钮，会自动杀掉 DSH 再拉起来（约 15~20 秒），
> 重启后顺手把桥接的端点同步过去（桌面版每次启动端口都会变）。

## 为什么不能真正热插拔

试过了，结论是**做不到**，原因在 DSH 这边：

- Cordis 的插件树是 DSH 启动时按 profile 的 `bundles` 建出来的，运行中没有"往树里塞一个新 bundle"的入口；
- 连官方的 `dshmarket` 都一样。它自己的能力声明里写着：

```json
"restart": { "supported": false, "managedBy": "desktop-host" }
```

桌面版把"重启"这个动作交给了外壳进程，市场自己都不能重启，它的界面文案也是
「项变更需重启 DeepSeek Harness 后生效」。

所以这里给的是**一键生效**（自动重启），不是热加载。

## 同名插件：不覆盖，改成「纳管」

如果 DSH 的 `plugin-vendor` 里**已经有**这个插件（你自己装的、或者插件市场装的），
再装一遍会撞名。现在的处理不是拒绝，而是**问一句**：

> DSH 里已经装了 dsh-bili-scroll v2.0.2，可以把它直接加入桥接管理，不用重复安装。
> 是否把它加入桥接管理？（不复制文件，直接引用 DSH 里那一份）

点「确定」就把它**纳管**进来：

- **不复制、不覆盖、不改安装位置**——文件始终是 DSH 里那份；
- 桥接的插件列表里照常出现它的卡片，带一个「**来自 DSH**」的徽章；
- 开关直接改 profile 的 `bundles`（和正常插件一样）；
- 「设置」按钮照常可用；
- 「卸载」对这类插件是**移出桥接列表**，不会删你 DSH 里的文件。

内部就是 `plugins.json` 里记一条 `{ external: true, path: <DSH 里的路径> }`，
列表时把「自己目录里的」和「纳管的」合并显示。

## 插件设置页怎么打开的（dsh-gui-endpoint）

插件作者做的设置界面是注册在 **DSH 的「设置 → 插件」**里的，而 DSH 的 web token 只在它自己
进程内存里——外部构造不出能直接打开设置页的 URL。这是之前「点设置只跳过去、界面出不来」的原因。

解法来自 QQ 群友的建议：**让插件自己开个本地端口，桥接问插件要**。

仓库里的 `plugin/` 就是一个这样的 DSH 插件（`dsh-gui-endpoint`）：

```
GET http://127.0.0.1:<dsh端口>/dsh-gui/url
→ { "ok": true, "url": "http://127.0.0.1:xxxxx/?token=...", "port": 57806 }
```

它跑在 DSH 里，能调用 `ctx.connection.authenticatedUrl()`，所以能吐出**带登录态**的地址；
这个路由本身是免认证的（和 `/api/qq-proactive` 一样）。

「设置」按钮现在的行为：

1. 先请求上面那个端点；
2. 拿到 url → 用内置窗口打开一个**已登录的 DSH 窗口**，去「设置 → 插件」就能看到插件的设置界面；
3. 拿不到（插件没装 / DSH 没重启）→ 退回旧方案：把 DSH 主窗口叫到前台 + 复制插件名到剪贴板。

**它需要重启 DSH 才生效**（和所有插件一样）。装法：把 `plugin/` 放进
`D:\DSH-Data\plugins\dsh-gui-endpoint`，然后在 profile 的 `dependencies` 和
`dsh.profile.bundles` 里登记，重启 DSH 即可。

## 什么时候才重启 DSH

「开始桥接」对 DSH 只做**检测 + 按需启动**：

| 情况 | 行为 |
|---|---|
| DSH 在跑 | 直接用，不重启、不打断对话 |
| DSH 没跑 | 帮忙启动并等它就绪 |
| 改了插件要生效 | 手动点「应用变更（重启 DSH）」 |

> 早期版本会为了抓 DSH 的 web token 而强制重启，那个设计已经废弃——
> 插件设置页现在由桥接自己渲染（自动生成表单），不依赖 DSH 的 token。

## 弹出的 DSH 窗口：跳过启动动画

我们自己弹出的 DSH 窗口挂了一个专用 preload（`app/dsh-window-preload.js`），它在页面脚本之前执行，
抢先写进去这几样：

```js
sessionStorage['dsh-startup-screen:shown'] = '1'
localStorage['dsh-startup-screen:day'] = 今天
window.__DSH_STARTUP_SKIP__ = true
```

对应 `dsh-startup-screen` 插件的跳过条件，所以**这个窗口不播启动动画**，直接进设置页。

> **只影响我们自己的窗口**。DSH 自己的窗口不经过这个 preload，那边的启动动画和配置完全不受影响。
> 如果插件被设成了 `mode: 'always'`（每次都播），上面两个 storage 标记不生效，那就跳不过——
> 这是插件自己的配置决定的。

## 已经在用原版 qq-bridge？直接接管，不用搬

这个软件**不打包 qq-bridge**，它是套在 qq-bridge 外面的壳。所以你原来那份原版：

| 东西 | 会不会被覆盖 |
|---|---|
| `config.json`（端口 / token / 白名单） | **不动**，直接读 |
| `state/`（会话、记忆、审批、黑话…） | **不动**，直接读 |
| `plugins/`（桥接自带插件） | **不动** |
| 正在跑的进程 | 已经跑着就直接连它的控制台 |

**接管方式**：启动时按顺序找 `src/bridge.js` 所在目录——

1. 界面里选过的目录（存在 `settings.json` 的 `bridgeRoot`）
2. 环境变量 `QQ_BRIDGE_ROOT`
3. `~/Documents/deepseek-harness/qq-bridge`
4. `~/deepseek-harness/qq-bridge`
5. `D:\DSH\qq-bridge` / `C:\qq-bridge`

找到就用，找不到启动页上有「**选一下目录**」——选完重启本程序生效。
没有"导入/迁移"步骤，因为它和原版共用同一份数据。

> 唯一算得上"改装"的是：控制台里多了「桥接日志」和「插件管理」两个页签，以及右下角的桥接开关。
> 这些都是注入/加页，原控制台的其它页面一行没改。

## 装完自动加进 QQ 工具白名单

桥接的 QQ 会话受 `qq-tool-restrict` 守卫限制，插件工具必须在白名单里才调得到。
所以**安装插件时会自动把这个插件的工具加进去**：

```
安装/纳管插件 → 扫插件代码找 snake_case 的 name: 'xxx'
             → 合并进 qq-bridge/state/tool-allowlist.json 的 allow
             → 写之前备份 .bak-allow-<时间戳>
             → 在 note 里记一条「某日放行某插件的工具」
```

**不需要重启 DSH**——`qq-tool-restrict` 是按文件 mtime 现读的，改完即生效。

实测提取准确度：

| 插件 | 提取到 |
|---|---|
| dsh-qq-proactive | 2 个（status / wake） |
| dsh-bili-scroll | 12 个（whoami / search / subtitle …） |
| dsh-phone-agent | 16 个（status / screen / ocr …） |
| waimai-plugin | 8 个（open / search / enter …） |

**安全性**：白名单只是"允许"层，`qq-tool-restrict` 的静态 SAFE_EXACT / 本地执行红线**仍然优先拦**——
所以就算自动放行了某个危险工具，守卫照样会拒掉。

## 从插件市场搜索安装

不用记 GitHub 地址。插件页第二行是市场搜索框，输入关键词（`bili` / `记忆` / `语音`）就能搜。

**数据源**：npm 上的 `dsh-plugin-catalog` 包——DSH 官方市场的目录，
里面 **4872 个插件**，每条带 npm 包名、中英双语描述、类别、最新版本。

- 首次搜索会下载约 **4MB** 的目录（之后走本地缓存，24 小时有效）；
- 搜索结果点「安装」= 下载 npm tarball → 解压 → 校验 `dsh.bundle` → 装进 `plugins/` →
  建 vendor/node_modules 两个 junction → 登记 profile（和 GitHub 安装完全一样的流程）；
- 装完还是要点「应用变更（重启 DSH）」才生效。

实测搜 `bili` 命中 148 条。

## 插件配置：自动生成的表单

每张插件卡片上的「**配置**」按钮，会按下面的顺序找这个插件的配置，**任何一级成功就停**：

| 顺序 | 来源 | 什么时候命中 |
|---|---|---|
| ① | 插件自己的 config 接口（如 `/dsh-startup/config`） | 插件被 DSH 加载且路由免认证 |
| ② | 插件自己存的 JSON（如 `~/.dsh/dsh-startup.json`） | 插件把配置存在文件里 |
| ③ | DSH 的 patch 配置（profile / preset） | 插件挂进了 DSH 配置 |
| ④ | **解析插件代码**里的 `DEFAULTS` / `Schema.object` | 前三级都没有（最兜底） |

**第 ④ 级是关键**：它读的是**磁盘上的插件源码**，不依赖 DSH 是否加载过这个插件——
所以「DSH 里没有这插件」也不会导致配置界面空白。

用括号匹配（不是正则）抠对象字面量，能处理嵌套/字符串/注释。实测 `dsh-startup-screen`
在完全没配过的情况下，从代码里解析出 **33 个配置字段**。

前三级里 ① 需要 DSH 在跑，探测失败（超时/401）会立刻降级，不会卡住界面。

## 插件配置：自动生成的表单（表单细节）

插件挂进 QQ 会话的 preset 后，DSH 主界面的设置页**不一定**会显示它的设置项。所以桥接自己兜底：

每张插件卡片上有一个「**配置**」按钮，点开是**根据当前 config 自动生成的表单**：

| 值的类型 | 生成的控件 |
|---|---|
| `boolean` | 勾选框 |
| `number` | 数字输入框 |
| `string` | 文本框（长的自动变多行） |
| `string[]` | 多行文本框（一行一个） |
| 对象 / 混合数组 | JSON 小框 |

表单下面还有「高级：直接编辑 JSON」折叠区，需要整体改的时候用它。

- **不需要插件作者做任何事**——控件是从现有配置值推断出来的；
- **字段名会翻成中文**（`perDay` → 每天上限、`peakValley` → 峰谷时段），内置了 100+ 常见字段词典；
  查不到的会拆驼峰，并把原始字段名挂在鼠标悬停提示上；
- 保存前校验（类型对不上就报哪一项不对）；
- 写入前自动备份（`*.bak-config-<时间戳>`）；
- **重启 DSH 后生效**。

**配置写在哪**：优先改已有的配置行；没有就新建一条。位置是：

- `~/.dsh/profiles/<profile>/cordis.patch.yml` —— 顶层的 `{ id, name, config }` 就是按 id 覆盖配置；
- 桥接 preset 的 patch（如果插件挂在 QQ 会话的 preset 里）。

解析 YAML 用的是 qq-bridge 自带的 `js-yaml`（不额外装依赖，找不到就提示"不能配"）。

> 这么做的理由：插件作者的设置页是 DSH client 插件的一部分，只有 DSH 能渲染；
> 桥接既控制不了 DSH 的窗口，也不该为了配一个参数去开第二个 DSH。
> 给一个通用的 JSON 编辑器，**任何插件立刻可配**，不依赖作者做 UI。

## 「设置」按钮：为什么只是切过去

点插件卡片的「设置」，**只会把你自己开着的那个 DSH 窗口切到前台**，并把这个插件的名字放进剪贴板。

试过很多种"自动跳到插件设置页"的做法，都不成立：

- **另开一个窗口加载带 token 的 DSH** → 视觉上等于又开了一个 DSH，而且是第二个登录会话，用户不需要；
- **在 DSH 页面里注入 JS 点按钮** → 我们控制不了用户开着的那个窗口（没有调试端口、没有 IPC），
  只能在**自己新开的**窗口里注入，又回到上一条；
- **靠 URL hash 直达** → DSH 的设置是弹窗不是路由页面，`#/settings` 不保证有用；
  而且依然发生在"自己新开的窗口"里。

所以现在的行为是：切到 DSH + 复制插件名（`设置 → 插件` 里搜一下就到）。这不是偷懒，
是 DSH 桌面版没给外部程序留控制窗口的入口。

## 「开始桥接」只检查 DSH，不重启

点「开始桥接」时对 DSH 只做两件事：

1. **在跑** → 直接用，什么都不动（不打断你正在聊的对话）；
2. **没跑** → 帮忙启动，等它就绪。

不再为了抓 token 重启 DSH——插件设置页已经由桥接自己的配置界面（自动生成表单）提供，
不需要 DSH 的 web token 了。

**如果改过插件、想让 DSH 重新加载**，用插件页上的「应用变更（重启 DSH）」按钮手动触发。

## DSH 端口漂移（会自动跟随）

DSH 桌面版**每次启动端口都是随机的**（这一秒 57806，下一次可能就是 64463）。桥接只在启动时读一次
`config.dsh.baseUrl`，所以 DSH 一重启，桥接就开始无脑重连一个已经没人监听的端口，日志里反复刷
`连接 DSH 事件流…`。

处理方式是**端点自检**（主进程里每 45 秒一次）：

1. 探一下当前 `baseUrl` 的端口还活着吗；
2. 死了就重跑 `sync-dsh-endpoint`（它扫描本机监听端口，按 preset 选出真正的 DSH）；
3. `baseUrl` 确实变了，才重启桥接让它读新配置。

实测（故意把 baseUrl 改成 59999）：

```
05:15:01 DSH 端点连不上（http://127.0.0.1:59999），重新同步
05:15:03 扫描 28 个端口 → 发现 57806
05:15:03 DSH 端点变了，自动重启桥接
05:15:06 桥接已随新端点重启完成
```

所以现在**手动重启 DSH 也不用管桥接**，一分钟内它自己就接回去了。

## 两个踩过的坑（改代码时注意）

**1. `SNOWLUMA_HOOK_AUTOLOAD=1` 必须设。**

SnowLuma 的 `runtime.json` 里 `hookAutoLoad` 默认是 `false`。不显式打开，它只会起一个 WebUI（5099），
**不会去接管已经登录的 QQ**，于是 3000/3001 永远不监听，桥接就会一直报
`SnowLuma WebSocket closed before opening`。

**2. 多 QQ 登录会抢端口。**

SnowLuma 会把所有登录的号都加载起来，各自按 `config/onebot_<QQ>.json` 里的端口开服务。
如果两个号都写了 3000/3001，谁先起来谁占住，桥接就可能连到错误的账号（用主人的号发消息）。

所以「开始桥接」在起 SnowLuma 之前会调用 `ensureOnebotConfig(uin)`：

- 目标号 → 确保是 3000/3001；
- 其他号 → 如果也占着 3000/3001，挪到 3010/3011。

这样桥接连 3001 就一定是目标号。

## 目录结构

```
qq-bridge-desktop/
├─ app/
│  ├─ main.js            主进程：窗口 / DSH / SnowLuma 托管 / 桥接启停 / 托盘 / 浮层注入
│  ├─ launcher.html      启动页（开始桥接 + 配置 SnowLuma + 日志面板）
│  ├─ preload.js         contextBridge 门面
│  ├─ package.json
│  └─ icon.ico           exe 与托盘共用的图标
├─ build.ps1             构建脚本
├─ .gitignore
└─ README.md
```

## 一些实现说明

- **主窗口加载的是桥接控制台本身**（`http://127.0.0.1:<port>/?token=…`），所以控制台以后怎么升级这里都自动跟上；
- **桥接进程用 Electron 的 node 模式跑**（`ELECTRON_RUN_AS_NODE=1` + `src/bridge.js`），不走 `start.bat`，所以没有黑窗，stdout 还能接进界面；
- **「桥接日志」页是改的 qq-bridge 的 `public/console.html`**（加一个导航项 + 一个 section + 一段脚本）。qq-bridge 升级会覆盖它，到时候照着重加一次；
- **托盘**：点 × 只是 `hide()`，`second-instance` 里会 `show()` 把窗口叫回来；
- **DSH 探测**：环境变量 → 卸载注册表 → 常见目录 → 开始菜单，找不到就明确报错，不会瞎猜。

## License

MIT
