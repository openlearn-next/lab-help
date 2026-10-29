# 机房求助灯 `@ext/lab-help`

机房课堂的求助状态灯：学生在课中浮层一键上报「进行中 / 卡住了 / 已完成」（卡住需选原因，可留一句话），
教师在讲台用机位网格一眼看到全班状态、一键「我来了」闭环，课后拿到求助与响应统计。

设计文档：`../artifacts/plan_lab_help_plugin.md`

## 为什么是这种形态（关键约束）

平台 0.7.7 上，第三方 ZIP 插件被 `execution-policy` **强制 `process` 模式**，无法把 React 组件交给宿主
（会 `DataCloneError`），所以可见 UI 只能走官方的「声明式可视沙箱视图」：

```
manifest.contributes["teacher.tab"][].view = "storage/dashboard.html"
        ↓ 宿主 iframe（sandbox="allow-scripts allow-forms allow-downloads"，无 allow-same-origin）
storage/dashboard.html  ──引入 /plugin-sandbox/view-bridge.js──→  window.OpenLearnPluginBridge
        ↓ bridge.api.get/post('board?…')  （宿主页面同源 fetch，带 session cookie）
    /api/plugins/@ext/lab-help/board  →  pluginApiGateway 组装 req.actor{userId,role}
        ↓
    服务端 src/routes.ts 的处理器
```

> 为什么不是 `invokeCommand`：宿主 `/sandbox-command` 用的是「插件自己的 actor」，
> 命令处理器拿不到登录用户身份 —— 学生无法自报、教师操作也无法归属到人。
> 所以业务走 HTTP 路由，命令只留 `lab_help.ping` 作排障探针。

两条容易踩的坑，已在本仓库规避：

1. **`view` 曾被 zod 剥掉**：`manifestSchema.parse()` 对 `teacher.tab` / `teacher.panel` / `student.view`
   的条目没有 `.passthrough()`，漏声明 `view` 就会被静默删除，面板退化成空白占位。已在平台侧
   `packages/core/esm-loader/manifest-schema.ts` 补上字段与回归用例，本插件依赖该补丁。
2. **官方 CLI 的 `pack` 只打 3 个文件**（`index.js` / `manifest.json` / `frontend.js`），HTML 不会入包；
   平台安装侧也只解压 `storage/**`。因此本项目用 `scripts/pack.mjs` 自行打包，并在打包期校验
   `view` 必须以 `storage/` 开头且文件真实存在。
3. **`ctx.lessonId` / `ctx.classId` 在学生端是空的** —— 它们取自宿主的 `selectedLesson` 与
   `liveClassSelectedClassId`，都是教师侧选择态。因此两端页面都**不把上下文当必要条件**：
   服务端 `/board`、`/self` 用 `classroom_sessions(ended_at IS NULL)` 自行解析「进行中的课堂」，
   并在响应里回传 `lessonId`/`classId`，前端再回填 `ctx`。

### ⚠️ 最致命的那个坑：ZIP 里不能没有 `frontend.js`

宿主 `activateRemotePlugin()` 的第一步是：

```ts
const res = await fetch(`/plugins/${pluginId}/frontend.js`);
if (!res.ok) throw new Error(`Failed to fetch frontend.js ...`);
this.registerManifestContributions(pluginId, manifest); // ← 排在 fetch 之后
```

`registerManifestContributions()` 在 fetch **之后**。所以 ZIP 里没有 `frontend.js`（或它 404）时：

- manifest 的 `teacher.tab` / `student.classroom.overlay` **一条都不会注册**；
- 表现是「教师端没有页签、学生端没有浮层」，但安装向导完全成功、没有任何报错；
- 插件状态还会显示 `active`（服务端进程模式照常加载，与前端无关）。

因此 `src/frontend.tsx` 是**硬依赖**，哪怕本插件一个可见组件都不提供 —— 它只是激活门槛。
`scripts/pack.mjs` 现在会在缺失 `dist/frontend.js` 时直接失败。

## 开发

```bash
npm install
npm run build      # openlearn-plugin-sdk build → dist/index.js + dist/frontend.js
npm run typecheck  # tsc --noEmit
npm run pack       # scripts/pack.mjs → dist/openlearn-plugin-lab-help.zip（含 frontend.js 与 storage/）
npm run dist       # build + pack
```

## 安装验证

1. 平台需包含 `manifest-schema.ts` 的 `view` 补丁（本仓库 `../openlearnv2`），且**补丁要在安装之前生效**
   —— `manifest` 是安装那一刻解析后落库的，补丁上线前的旧实例必须重装才会补回 `view`。
2. 平台「插件管理 → 安装 ZIP」上传 `openlearn-plugin-lab-help.zip`，启用。
3. 教师端左侧「扩展应用」分组出现「机房求助」页签；点开后是机位网格。
   看板需要课节 + 班级上下文，请先进入课堂视图再打开，否则会提示「未进入课堂」。
4. 学生端进入课堂视图，应出现「求助」浮层（三态按钮）。
5. 排查顺序：浏览器 Network 里 `/plugins/{id}/frontend.js` 必须 200；否则一切贡献都不会出现。

## 目录

```
manifest.json            插件清单（id / 权限 / contributes.view）
src/index.ts             服务端入口：注册 action + command handler
src/commands/            按命令拆分（业务阶段补充）
storage/dashboard.html   教师端看板（teacher.tab）
storage/overlay.html     学生端浮层（student.classroom.overlay）
storage/assets/          公共样式与脚本（按需拆分）
scripts/pack.mjs         打包 + view 路径守卫
```

## 当前进度

- [x] 平台 `view` 字段修复 + 回归测试（`packages/core/esm-loader`，35 项测试通过）
- [x] 脚手架、打包脚本（含 view 路径守卫）、两端页面
- [x] 数据层三表（current / events / summary）+ 名册与身份解析
- [x] 业务路由 9 个（board / self / report / ack / resolve / reopen / history / export / meta）
- [x] manifest 的 `api.routes` 与机房同出口 IP 的限流放大
- [ ] 平台实测安装（需重启平台使 `view` 补丁生效）
- [ ] 课堂实战校准：身份映射（session.userId ↔ students.id）、浮层槽位高度、40 并发压测
