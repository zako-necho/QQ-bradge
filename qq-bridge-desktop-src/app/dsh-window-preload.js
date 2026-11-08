/**
 * dsh-window-preload.js
 * ============================================================================
 * 只挂在「QQ 桥接弹出的 DSH 窗口」上，用来跳过启动动画。
 *
 * 为什么能跳过：dsh-startup-screen 插件的判断条件是
 *   mode === 'session' && sessionStorage['dsh-startup-screen:shown'] === '1'
 *   mode === 'daily'   && localStorage['dsh-startup-screen:day'] === 今天
 * 这两种标记都写在页面同源的 storage 里，preload 在页面脚本之前执行，
 * 所以抢先写进去就能让动画这次不播。
 *
 * 注意：只影响我们自己弹出的窗口。DSH 自己的窗口不经过这个 preload，
 * 那边的启动动画照常。
 * ============================================================================
 */

(function () {
  try {
    sessionStorage.setItem('dsh-startup-screen:shown', '1');
  } catch {
    /* storage 不可用就算了 */
  }
  try {
    localStorage.setItem('dsh-startup-screen:day', new Date().toISOString().slice(0, 10));
  } catch {
    /* 同上 */
  }
  try {
    // Host 侧兜底标记（插件会读它决定不播）
    window.__DSH_STARTUP_SKIP__ = true;
  } catch {
    /* 同上 */
  }
})();
