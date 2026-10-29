/**
 * HTTP 路由 —— 沙箱页面的**唯一**数据通道。
 *
 * 为什么不用 `OpenLearnPluginBridge.invokeCommand()` 走业务：
 *   宿主 `/api/plugins/:id/sandbox-command` 用的是 `pluginActorIdFor(...)`，
 *   即「插件自己的 actor」。命令处理器拿不到登录用户身份，学生端无法自报、
 *   教师端也无法确认操作者是谁（`command.actorId` 恒为插件）。
 *   而桥接的 `api.get/post` 是在宿主页面发起的同源 fetch，带 session cookie，
 *   经 `pluginApiGatewayMiddleware` 组装出 `req.actor = { userId, role, ... }`。
 *   所以：身份敏感操作一律走本文件的路由，命令只留给课堂工具入口做无身份动作。
 *
 * 网关侧的限流键是 `clientIp:pluginId:method:path` —— 机房 40 台机器同一个出口 IP，
 * 5 秒轮询（12 次/分钟/人 ×40 = 480/分钟）会打爆默认 120/分钟的配额。
 * 因此 manifest.api.routes 里为每个端点单独放大了 rateLimit，改这里时别忘同步 manifest。
 */

import type { PluginApiRequest, PluginApiResponse, PluginContext } from '@openlearn/plugin-sdk';
import {
  appendEvent,
  buildCells,
  computeStats,
  listCurrent,
  loadRoster,
  resolveActiveSession,
  resolveStudentIdentity,
  sanitizeNote,
  studentsIdOf,
  updateTeacherState,
  upsertCurrent,
  upsertSummary,
  type RawDb,
  type Tables,
} from './db.js';
import {
  NOTE_MAX_LEN,
  REASON_LABELS,
  STUCK_REASONS,
  STUDENT_STATUSES,
  STATUS_LABELS,
  type BoardPayload,
  type StuckReason,
  type StudentStatus,
  type TeacherState,
} from './types.js';

type Res<T = unknown> = PluginApiResponse<T>;

const ok = <T>(body: T): Res<T> => ({ status: 200, body });
const bad = (error: string, status = 400): Res<{ ok: false; error: string }> => ({ status, body: { ok: false, error } });

const asString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const queryOf = (req: PluginApiRequest, key: string): string => asString(req.query?.[key]);

function isTeacher(req: PluginApiRequest): boolean {
  return req.actor.role === 'teacher' || req.actor.role === 'administrator';
}

/**
 * 解析本次请求的课堂 —— 显式参数优先，缺失时回退到「进行中的课堂会话」。
 *
 * 第三方 `view` 页拿到的上下文只有宿主 store 里的 `selectedLesson` /
 * `liveClassSelectedClassId`（教师侧选择态），学生端通常两者皆空。
 * 之前 `/self`、`/report` 硬性要求二者齐全，结果学生进了课堂也只能看到
 * 「还没进入课堂，稍后再试」—— 而平台其实有 `classroom_sessions` 记录。
 */
async function sessionOf(
  rawDb: RawDb,
  opts: { lessonId?: string; classId?: string; userId?: string },
): Promise<{ lessonId: string; classId: string } | null> {
  const studentId = opts.userId ? await studentsIdOf(rawDb, opts.userId) : null;
  return resolveActiveSession(rawDb, {
    lessonId: opts.lessonId,
    classId: opts.classId,
    studentId,
  });
}

export function registerRoutes(ctx: PluginContext, rawDb: RawDb, tables: Tables): void {
  // 统一成 Res<unknown>：ok/bad 两个分支的 body 类型不同，直接传给 ctx.http.*
  // 会按第一个分支推断出 TRes 而报类型不兼容。
  type Handler = (req: PluginApiRequest) => Promise<Res<unknown>>;
  const get = (path: string, handler: Handler) => ctx.http.get<unknown>(path, handler);
  const post = (path: string, handler: Handler) => ctx.http.post<unknown>(path, handler);

  // ── 教师端：看板快照 ────────────────────────────────────────────────
  get('/board', async (req) => {
    if (!isTeacher(req)) return bad('仅教师可访问', 403);
    const session = await sessionOf(rawDb, {
      lessonId: queryOf(req, 'lessonId'),
      classId: queryOf(req, 'classId'),
      userId: String(req.actor.userId ?? ''),
    });
    if (!session) return bad('还没有进行中的课堂', 409);
    const { lessonId, classId } = session;

    const now = Date.now();
    const [roster, current] = await Promise.all([loadRoster(rawDb, classId), listCurrent(rawDb, tables, lessonId)]);
    const cells = buildCells(roster, current, now);
    const stats = await computeStats(rawDb, tables, { lessonId, classId, cells, now });

    // 汇总在教师端读取时顺带刷新：学生上报不写汇总，避免 40 人 × 每 5 秒的写放大。
    try {
      await upsertSummary(rawDb, tables, { lessonId, classId, stats, now });
    } catch {
      /* 汇总写失败不影响看板可用性 */
    }

    const payload: BoardPayload = { lessonId, classId, cells, stats, serverTime: now };
    return ok(payload);
  });

  // ── 学生端：读取自己当前状态（浮层 5 秒轮询）────────────────────────
  get('/self', async (req) => {
    if (req.actor.role !== 'student') return bad('仅学生可访问', 403);
    const uid = String(req.actor.userId ?? '');

    // 课堂由服务端解析：页面上的 ctx.lessonId/classId 只是提示，可能为空。
    const session = await sessionOf(rawDb, {
      lessonId: queryOf(req, 'lessonId'),
      classId: queryOf(req, 'classId'),
      userId: uid,
    });
    if (!session) {
      // 200 + active:false —— 让浮层显示「等老师开课」，而不是一个报错
      return ok({
        active: false,
        lessonId: null,
        classId: null,
        reported: false,
        status: null,
        teacherState: null,
        name: null,
        seatNo: null,
        serverTime: Date.now(),
      });
    }

    const { lessonId, classId } = session;
    const me = await resolveStudentIdentity(rawDb, uid, classId);
    if (!me) {
      // 名册里认不出这个会话 —— 把身份信息原样带回，便于前端/排障定位
      return ok({
        active: true,
        lessonId,
        classId,
        identityResolved: false,
        reported: false,
        status: null,
        teacherState: null,
        name: null,
        seatNo: null,
        actorUserId: uid,
        serverTime: Date.now(),
      });
    }

    const rows = await listCurrent(rawDb, tables, lessonId);
    const row = rows.find((r) => r.student_id === me.studentId);
    return ok({
      active: true,
      lessonId,
      classId,
      identityResolved: true,
      reported: Boolean(row),
      status: row?.status ?? null,
      reason: row?.reason ?? null,
      note: row?.note ?? null,
      teacherState: row?.teacher_state ?? null,
      ackedAt: row?.acked_at ?? null,
      statusAt: row?.status_at ?? null,
      name: me.name,
      seatNo: me.seatNo,
      reasonLabel: row?.reason ? REASON_LABELS[row.reason] : null,
      serverTime: Date.now(),
    });
  });

  // ── 学生端：上报状态 ────────────────────────────────────────────────
  post('/report', async (req) => {
    if (req.actor.role !== 'student') return bad('仅学生可上报自己的状态', 403);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = asString(body.status) as StudentStatus;
    if (!(STUDENT_STATUSES as readonly string[]).includes(status)) return bad(`status 非法：${status}`);

    const session = await sessionOf(rawDb, {
      lessonId: asString(body.lessonId),
      classId: asString(body.classId),
      userId: String(req.actor.userId ?? ''),
    });
    if (!session) return bad('当前没有进行中的课堂', 409);
    const { lessonId, classId } = session;

    let reason: StuckReason | null = null;
    if (status === 'stuck') {
      const rawReason = asString(body.reason);
      if (rawReason && (STUCK_REASONS as readonly string[]).includes(rawReason)) reason = rawReason as StuckReason;
    }
    const note = sanitizeNote(body.note);

    const me = await resolveStudentIdentity(rawDb, String(req.actor.userId ?? ''), classId);
    const studentId = me?.studentId ?? String(req.actor.userId ?? '');
    if (!studentId) return bad('无法识别学生身份', 401);

    const now = Date.now();
    const rows = await listCurrent(rawDb, tables, lessonId);
    const prev = rows.find((r) => r.student_id === studentId);

    // 再次求助要把教师处置维度拉回待处理，否则「已解决」会把新的求助吞掉。
    const reStuck = status === 'stuck' && (prev?.teacher_state === 'acked' || prev?.teacher_state === 'resolved');
    const teacherState: TeacherState = reStuck ? 'pending' : (prev?.teacher_state ?? 'pending');

    await upsertCurrent(rawDb, tables, {
      lessonId,
      classId,
      studentId,
      studentName: me?.name ?? null,
      seatNo: me?.seatNo ?? null,
      status,
      reason,
      note,
      teacherState,
      ackedAt: reStuck ? null : (prev?.acked_at ?? null),
      ackedBy: reStuck ? null : (prev?.acked_by ?? null),
      resolvedAt: reStuck ? null : (prev?.resolved_at ?? null),
      at: now,
    });

    await appendEvent(rawDb, tables, {
      lessonId,
      classId,
      studentId,
      studentName: me?.name ?? null,
      seatNo: me?.seatNo ?? null,
      kind: 'status',
      status,
      reason,
      note,
      actorId: req.actor.actorId,
      actorRole: req.actor.role,
      at: now,
    });

    return ok({ ok: true, status, teacherState, at: now });
  });

  // ── 教师端：处置动作（ack / resolve / reopen）────────────────────────
  const teacherAction = (kind: 'ack' | 'resolve' | 'reopen') => async (req: PluginApiRequest) => {
    if (!isTeacher(req)) return bad('仅教师可操作', 403);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const studentId = asString(body.studentId);
    if (!studentId) return bad('缺少 studentId');
    const session = await sessionOf(rawDb, {
      lessonId: asString(body.lessonId),
      classId: asString(body.classId),
      userId: String(req.actor.userId ?? ''),
    });
    if (!session) return bad('还没有进行中的课堂', 409);
    const { lessonId, classId } = session;

    const rows = await listCurrent(rawDb, tables, lessonId);
    const row = rows.find((r) => r.student_id === studentId);
    if (!row) return bad('该学生本节课没有上报记录', 404);

    const now = Date.now();
    let next: TeacherState;
    let ackedAt = row.acked_at;
    let ackedBy = row.acked_by;
    let resolvedAt = row.resolved_at;

    if (kind === 'ack') {
      next = 'acked';
      // 重复点「我来了」不刷新响应时长，保留第一次的计时。
      if (ackedAt == null) {
        ackedAt = now;
        ackedBy = req.actor.actorId ?? null;
      }
    } else if (kind === 'resolve') {
      next = 'resolved';
      if (ackedAt == null) {
        ackedAt = now;
        ackedBy = req.actor.actorId ?? null;
      }
      resolvedAt = now;
    } else {
      next = 'pending';
      ackedAt = null;
      ackedBy = null;
      resolvedAt = null;
    }

    await updateTeacherState(rawDb, tables, {
      lessonId,
      classId,
      studentId,
      teacherState: next,
      ackedAt,
      ackedBy,
      resolvedAt,
    });
    await appendEvent(rawDb, tables, {
      lessonId,
      classId,
      studentId,
      studentName: row.student_name ?? null,
      seatNo: row.seat_no ?? null,
      kind,
      status: row.status,
      actorId: req.actor.actorId,
      actorRole: req.actor.role,
      at: now,
    });

    return ok({ ok: true, teacherState: next, ackedAt, resolvedAt });
  };

  post('/ack', teacherAction('ack'));
  post('/resolve', teacherAction('resolve'));
  post('/reopen', teacherAction('reopen'));

  // ── 教师端：历史汇总 ────────────────────────────────────────────────
  get('/history', async (req) => {
    if (!isTeacher(req)) return bad('仅教师可访问', 403);
    const classId = queryOf(req, 'classId');
    if (!classId) return bad('缺少 classId');
    const limit = Math.min(Math.max(Number(queryOf(req, 'limit')) || 20, 1), 100);

    const rows = (await rawDb
      .prepare(
        `SELECT lesson_id, class_id, stuck_count, stuck_students, acked_count, avg_response_sec,
                max_wait_sec, completion_rate, top_reason, reason_breakdown, roster_count, updated_at
           FROM ${tables.summary}
          WHERE class_id = ?
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(classId, limit)) as Array<Record<string, unknown>>;

    return ok({
      rows: rows.map((r) => ({
        lessonId: String(r.lesson_id),
        stuckCount: Number(r.stuck_count ?? 0),
        stuckStudents: Number(r.stuck_students ?? 0),
        ackedCount: Number(r.acked_count ?? 0),
        avgResponseSec: r.avg_response_sec == null ? null : Number(r.avg_response_sec),
        maxWaitSec: r.max_wait_sec == null ? null : Number(r.max_wait_sec),
        completionRate: r.completion_rate == null ? null : Number(r.completion_rate),
        topReason: r.top_reason ? String(r.top_reason) : null,
        topReasonLabel: r.top_reason ? (REASON_LABELS[r.top_reason as StuckReason] ?? String(r.top_reason)) : null,
        rosterCount: Number(r.roster_count ?? 0),
        updatedAt: Number(r.updated_at ?? 0),
      })),
    });
  });

  // ── 教师端：导出 CSV ────────────────────────────────────────────────
  get('/export', async (req) => {
    if (!isTeacher(req)) return bad('仅教师可访问', 403);
    const lessonId = queryOf(req, 'lessonId');
    if (!lessonId) return bad('缺少 lessonId');

    const rows = (await rawDb
      .prepare(
        `SELECT created_at, seat_no, student_name, student_id, kind, status, reason, note, actor_role
           FROM ${tables.events}
          WHERE lesson_id = ?
          ORDER BY created_at ASC`,
      )
      .all(lessonId)) as Array<Record<string, unknown>>;

    const header = ['时间', '机位', '姓名', '学生ID', '事件', '状态', '原因', '备注', '操作者角色'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          new Date(Number(r.created_at)).toLocaleString('zh-CN'),
          String(r.seat_no ?? ''),
          String(r.student_name ?? ''),
          String(r.student_id ?? ''),
          String(r.kind ?? ''),
          r.status ? (STATUS_LABELS[r.status as StudentStatus] ?? String(r.status)) : '',
          r.reason ? (REASON_LABELS[r.reason as StuckReason] ?? String(r.reason)) : '',
          String(r.note ?? ''),
          String(r.actor_role ?? ''),
        ]
          .map(csvCell)
          .join(','),
      );
    }

    return ok({
      filename: `机房求助_${lessonId.slice(0, 8)}.csv`,
      // BOM 让 Excel 直接按 UTF-8 打开不乱码
      csv: '\ufeff' + lines.join('\r\n'),
      rowCount: rows.length,
    });
  });

  // ── 只读：给沙箱页面拉取字典，避免两端各写一份中文标签 ──────────────
  get('/meta', async () => {
    return ok({
      noteMaxLen: NOTE_MAX_LEN,
      statuses: STUDENT_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
      reasons: STUCK_REASONS.map((r) => ({ value: r, label: REASON_LABELS[r] })),
    });
  });
}

function csvCell(value: string): string {
  const v = String(value ?? '');
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
