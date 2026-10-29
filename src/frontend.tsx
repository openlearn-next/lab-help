/**
 * 机房求助灯 —— 前端入口（沙箱桥接占位）
 *
 * ⚠️ 这个文件存在的首要原因是**激活门槛**，不是 UI：
 *   宿主 activateRemotePlugin() 的第一步就是 `fetch('/plugins/{pluginId}/frontend.js')`，
 *   HTTP 非 2xx 直接 throw，而 `registerManifestContributions()` 排在这次 fetch **之后**。
 *   ZIP 里没有 frontend.js ⇒ manifest 的 teacher.tab / student.classroom.overlay
 *   一条都不会注册 ⇒ 教师端没有页签、学生端没有浮层，且安装向导不报错。
 *
 * 本插件的可见 UI 全部是声明式可视沙箱视图：
 *   - teacher.tab            → storage/dashboard.html（机位网格看板）
 *   - student.classroom.overlay → storage/overlay.html（学生三态浮层）
 * 两页都通过 view-bridge 的 api.get/post 调用插件 HTTP 路由（见 src/routes.ts），
 * 因此这里**不需要**注册任何扩展点，也不做任何 UI 渲染。
 *
 * 三方 ZIP 插件被平台强制为 process 执行模式，本文件不会在宿主父页面执行，
 * 只被送进隐藏沙箱 iframe；但仍按官方契约保留 default export { activate, deactivate }，
 * 以免将来切换到 inline 时因子函数缺失进入错误态。
 */

/** 沙箱 iframe 注入的桥接上下文（此处只用到 pluginId，其余成员按需扩展）。 */
interface SandboxFrontendContext {
  pluginId: string;
}

async function activate(hostCtx: SandboxFrontendContext): Promise<void> {
  // 无运行期注册：可见入口与数据通道都由 manifest + storage/*.html 承担。
  // 保留一行日志便于在主控台确认「前端确实激活了、只是没有组件」。
  console.info('[lab-help] frontend activated (declarative views only)', hostCtx?.pluginId ?? '');
}

async function deactivate(): Promise<void> {
  // 无定时器 / 无订阅 / 无 DOM 挂载，无需清理。
}

export { activate, deactivate };
export default { activate, deactivate };
