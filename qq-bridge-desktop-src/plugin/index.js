/**
 * dsh-gui-endpoint —— 把「带 token 的 DSH GUI 地址」吐给外部程序
 * ============================================================================
 * 为什么需要它：DSH 的 web token 只在它自己进程里（desktop-host 通过 IPC 拿到
 * 后交给 Electron 主进程），外部程序构造不出能直接打开设置页的 URL。
 *
 * 但插件跑在 DSH 里，天然有权限调用 `ctx.connection.authenticatedUrl()`。
 * 所以这个插件开一个**免认证**的本地路由：
 *
 *     GET http://127.0.0.1:<dsh端口>/dsh-gui/url
 *     → { ok: true, url: "http://127.0.0.1:xxxxx/?token=...", port }
 *
 * QQ 桥接桌面版拿到这个 url 之后，就能用内置窗口打开设置页，
 * 让插件作者做的设置界面正常显示出来。
 *
 * 路由本身和 /api/qq-proactive 一样是免 token 的（插件注册的 prefix 路由）。
 * 它只暴露「本机已登录的 GUI 地址」，不涉及任何密钥内容之外的权限。
 * ============================================================================
 */

export const name = 'dsh-gui-endpoint';
// 只注入 webServer。connection 如果不是普通插件能拿到的 service，
// 强注入会让插件整个不加载，所以这里用 try/catch 探测。
export const inject = ['webServer'];

export function apply(ctx) {
  const handler = (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 'no-store');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    let url = '';
    let reason = '';
    const probe = {};
    try {
      const protocol = ctx.webServer.protocol || 'http';
      const port = ctx.webServer.port;
      const base = `${protocol}://127.0.0.1:${port}`;

      // 探一下 webServer 上有没有现成的 token
      try {
        probe.webServerKeys = Object.keys(ctx.webServer || {}).slice(0, 40);
        probe.port = port;
        probe.protocol = protocol;
      } catch { /* ignore */ }

      // connection 可能需要 inject 才能碰，碰不到就记下原因
      try {
        const connection = ctx.connection;
        probe.hasConnection = Boolean(connection);
        if (connection && typeof connection.authenticatedUrl === 'function') {
          url = connection.authenticatedUrl(base);
          probe.via = 'connection.authenticatedUrl';
        } else {
          reason = 'connection 存在但没有 authenticatedUrl';
        }
      } catch (error) {
        reason = error?.message || String(error);
      }
    } catch (error) {
      reason = reason || (error?.message || String(error));
    }

    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      ok: Boolean(url),
      url,
      reason,
      port: ctx.webServer.port,
      probe,
      at: Date.now(),
    }));
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-gui',
    handler,
  }));
}
