/**
 * 机房求助灯 —— 服务端入口 (dist/index.js)
 *
 * 平台基线 v0.7.7 / SDK 3.7.4。
 *
 * 运行形态约束（决定了本插件的架构）：
 *   - 第三方 ZIP 插件被 execution-policy 强制 `process` 模式，无法向宿主传 React
 *     组件（DataCloneError），因此全部可见 UI 走 `contributes[*].view` 声明的
 *     沙箱 HTML（storage/*.html），经 /plugin-sandbox/view-bridge.js 与宿主通信。
 *   - 沙箱页面的数据通道是 `bridge.api.get/post` → `/api/plugins/{id}/*`
 *     → 本文件的 HTTP 路由（ctx.http）。这样才能拿到真实登录身份
 *     （`req.actor = { userId, role }`）；若走 `bridge.invokeCommand`，
 *     宿主的 sandbox-command 用的是「插件自己的 actor」，学生/教师身份会丢。
 */

import { IDatabaseToken, type PluginContext } from '@openlearn/plugin-sdk';
import { initSchema, type RawDb, type Tables } from './db.js';
import { registerRoutes } from './routes.js';

const PLUGIN_ID = '@ext/lab-help';

let logInfo: (msg: string) => void = () => {};
let logWarn: (msg: string) => void = () => {};

export async function activate(ctx: PluginContext): Promise<void> {
  const { commandBus, actionRegistry } = ctx.services;
  logInfo = (msg) => ctx.log.info(msg);
  logWarn = (msg) => ctx.log.warn(msg);

  // ── 数据层 ──
  let tables: Tables | null = null;
  let rawDb: RawDb | null = null;
  try {
    tables = await initSchema(ctx);
    rawDb = (await ctx.resolve(IDatabaseToken)) as unknown as RawDb;
  } catch (err) {
    logWarn(`数据表初始化失败，看板与上报将不可用：${(err as Error).message}`);
  }

  if (tables && rawDb) {
    registerRoutes(ctx, rawDb, tables);
    logInfo('HTTP 路由已注册：/board /self /report /ack /resolve /reopen /history /export /meta');
  }

  // ── 探针命令 ──
  // 保留它用于排障：当沙箱页面「看起来没反应」时，先用 ping 区分
  // 「iframe/桥接坏了」还是「业务路由/权限有问题」。
  await actionRegistry.register({
    id: 'lab-help-ping',
    commandType: 'lab_help.ping',
    description: '探针：回显调用方上下文，用于验证沙箱 iframe → 命令桥接链路',
    capabilityRequired: 'lesson:read',
    inputSchema: {
      type: 'OBJECT',
      properties: {
        note: { type: 'STRING', description: '调用方附加的任意文本，原样回显' },
      },
      required: [],
    },
  });

  await commandBus.registerHandler('lab_help.ping', {
    async execute(command) {
      const payload = (command.payload ?? {}) as { note?: string };
      return {
        ok: true,
        pong: true,
        pluginId: ctx.pluginId ?? PLUGIN_ID,
        actorId: command.actorId ?? null,
        executionMode: (ctx.manifest as { executionMode?: string } | undefined)?.executionMode ?? 'unknown',
        note: String(payload.note ?? ''),
        serverTime: Date.now(),
      };
    },
  });

  logInfo('已激活');
}

export async function deactivate(): Promise<void> {
  logInfo('已停用');
}

export default { activate, deactivate };
