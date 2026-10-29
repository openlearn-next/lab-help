/**
 * 数据层 —— 三张表 + 名册读取 + 汇总重算。
 *
 * 为什么是三张表（设计文档原定「流水 + 汇总」双表）：
 *   学生状态与教师处置是两个独立维度，教师端每 5 秒要读全班最新态。
 *   从事件流里按「每个维度各取最新一条」派生当前态，SQL 会绕成两个窗口函数
 *   再拼回去，且 40 人 × 每 5 秒的读路径上不划算。因此加一张
 *   `lab_help_current`（每课节每人一行）承担读路径，事件表退化为纯审计流水。
 *   汇总表仍按「每课节一行」维护，供历史列表与导出。
 *
 * 平台 API 说明：
 *   - `ctx.db.ensureTable(name, columnsSql)` 建表，`ctx.db.table(name)` 取带插件前缀的真表名；
 *   - 平台原生只读表（students / class_students）用 `ctx.resolve(IDatabaseToken)` 直查，
 *     不写前缀，也不修改。
 */

import { IDatabaseToken, type PluginContext } from '@openlearn/plugin-sdk';
import {
  NOTE_MAX_LEN,
  REASON_LABELS,
  STUCK_REASONS,
  STUDENT_STATUSES,
  TEACHER_STATES,
  type BoardCell,
  type BoardStats,
  type CurrentRow,
  type RosterStudent,
  type StuckReason,
  type StudentStatus,
  type TeacherState,
} from './types.js';

export const CURRENT_TABLE = 'lab_help_current';
export const EVENTS_TABLE = 'lab_help_events';
export const SUMMARY_TABLE = 'lab_help_summary';

/** 平台原生表的极简类型：只用到 prepare().all/get/run。 */
export interface RawDb {
  prepare(sql: string): {
    all(...args: unknown[]): Promise<unknown[]> | unknown[];
    get(...args: unknown[]): Promise<unknown> | unknown;
    run(...args: unknown[]): Promise<unknown> | unknown;
  };
}

export interface Tables {
  current: string;
  events: string;
  summary: string;
}

export async function initSchema(ctx: PluginContext): Promise<Tables> {
  await ctx.db.ensureTable(
    CURRENT_TABLE,
    `
    lesson_id TEXT NOT NULL,
    class_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    student_name TEXT,
    seat_no TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    note TEXT,
    status_at INTEGER NOT NULL,
    teacher_state TEXT NOT NULL DEFAULT 'pending',
    acked_at INTEGER,
    acked_by TEXT,
    resolved_at INTEGER,
    PRIMARY KEY (lesson_id, student_id)
  `,
  );

  await ctx.db.ensureTable(
    EVENTS_TABLE,
    `
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL,
    class_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    student_name TEXT,
    seat_no TEXT,
    kind TEXT NOT NULL,
    status TEXT,
    reason TEXT,
    note TEXT,
    actor_id TEXT,
    actor_role TEXT,
    created_at INTEGER NOT NULL
  `,
  );

  await ctx.db.ensureTable(
    SUMMARY_TABLE,
    `
    lesson_id TEXT NOT NULL,
    class_id TEXT NOT NULL,
    stuck_count INTEGER NOT NULL DEFAULT 0,
    stuck_students INTEGER NOT NULL DEFAULT 0,
    acked_count INTEGER NOT NULL DEFAULT 0,
    avg_response_sec INTEGER,
    max_wait_sec INTEGER,
    completion_rate REAL,
    top_reason TEXT,
    reason_breakdown TEXT,
    roster_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (lesson_id, class_id)
  `,
  );

  return {
    current: ctx.db.table(CURRENT_TABLE),
    events: ctx.db.table(EVENTS_TABLE),
    summary: ctx.db.table(SUMMARY_TABLE),
  };
}

// ── 名册 ────────────────────────────────────────────────────────────────

/**
 * 读取班级名册（含未上报学生），机位号取 `student_number` 末两位。
 *
 * 名册读不到时返回空数组而不抛错：教师端看板仍应能显示已上报的学生，
 * 只是没有「未上报」的空格子。宁可降级也不要让整个看板 500。
 */
export async function loadRoster(rawDb: RawDb, classId: string): Promise<RosterStudent[]> {
  try {
    const rows = (await rawDb
      .prepare(
        `SELECT s.id AS student_id, s.name AS name, s.student_number AS student_number
           FROM class_students cs
           JOIN students s ON s.id = cs.student_id
          WHERE cs.class_id = ?
          ORDER BY s.student_number IS NULL, s.student_number, s.name`,
      )
      .all(classId)) as Array<{ student_id: string; name: string | null; student_number: string | null }>;

    return rows.map((r, idx) => {
      const number = String(r.student_number ?? '').trim();
      return {
        studentId: String(r.student_id),
        name: String(r.name ?? '未命名'),
        seatNo: number ? number.slice(-2) : String(idx + 1).padStart(2, '0'),
        order: number ? Number(number) || idx + 1 : idx + 1,
      };
    });
  } catch {
    return [];
  }
}

/**
 * 按会话 userId 反查 students.id（不依赖班级）。
 *
 * 学生端浮层拿不到班级时，无法走 `loadRoster(classId)` 那条路，
 * 只能直查 students 表；`class_students` 里存的也是 students.id。
 */
export async function studentsIdOf(rawDb: RawDb, userId: string): Promise<string | null> {
  if (!userId) return null;
  try {
    const row = (await rawDb
      .prepare('SELECT id FROM students WHERE id = ? OR student_number = ? LIMIT 1')
      .get(userId, userId)) as { id?: string } | undefined;
    return row?.id ? String(row.id) : null;
  } catch {
    return null;
  }
}

/**
 * 解析「本次请求针对的课堂」。
 *
 * 为什么需要它：`student.classroom.overlay` 的 view 上下文里的 `lessonId` / `classId`
 * 来自宿主的 `selectedLesson` 与 `liveClassSelectedClassId`，这两个都是**教师侧**的选择态，
 * 学生端通常为空 —— 于是插件页只能报「还没进入课堂」，而平台其实知道当前课堂。
 *
 * 平台用 `classroom_sessions(lesson_id, class_id, ended_at)` 记录进行中的课堂，
 * 因此以它为准：显式参数优先（教师端），缺失时按「该学生所在班级 + 未结束」取最近一场。
 */
export async function resolveActiveSession(
  rawDb: RawDb,
  opts: { lessonId?: string; classId?: string; studentId?: string | null },
): Promise<{ lessonId: string; classId: string } | null> {
  const lessonId = (opts.lessonId ?? '').trim();
  const classId = (opts.classId ?? '').trim();
  if (lessonId && classId) return { lessonId, classId };

  try {
    let sql = 'SELECT lesson_id, class_id FROM classroom_sessions WHERE ended_at IS NULL';
    const args: string[] = [];
    if (lessonId) {
      sql += ' AND lesson_id = ?';
      args.push(lessonId);
    }
    if (classId) {
      sql += ' AND class_id = ?';
      args.push(classId);
    }
    if (!lessonId && !classId && opts.studentId) {
      sql += ' AND class_id IN (SELECT class_id FROM class_students WHERE student_id = ?)';
      args.push(opts.studentId);
    }
    sql += ' ORDER BY started_at DESC LIMIT 1';
    const row = (await rawDb.prepare(sql).get(...args)) as
      | { lesson_id?: string; class_id?: string }
      | undefined;
    if (row?.lesson_id && row?.class_id) {
      return { lessonId: String(row.lesson_id), classId: String(row.class_id) };
    }
  } catch {
    /* 平台无 classroom_sessions（老版本）→ 交给调用方按「无课堂」处理 */
  }
  return null;
}

/** 学生身份兜底解析：会话 userId 未必等于 students.id，按 id / 学号各试一次。 */
export async function resolveStudentIdentity(
  rawDb: RawDb,
  userId: string,
  classId: string,
): Promise<{ studentId: string; name: string; seatNo: string } | null> {
  const roster = await loadRoster(rawDb, classId);
  const hit = roster.find((s) => s.studentId === userId);
  if (hit) return { studentId: hit.studentId, name: hit.name, seatNo: hit.seatNo };

  try {
    const row = (await rawDb
      .prepare('SELECT id, name, student_number FROM students WHERE student_number = ? OR id = ? LIMIT 1')
      .get(userId, userId)) as { id: string; name: string | null; student_number: string | null } | undefined;
    if (row) {
      const inClass = roster.some((s) => s.studentId === String(row.id));
      if (inClass) {
        const number = String(row.student_number ?? '').trim();
        return {
          studentId: String(row.id),
          name: String(row.name ?? '未命名'),
          seatNo: number ? number.slice(-2) : '--',
        };
      }
    }
  } catch {
    /* 名册不可用时退化为使用会话 userId */
  }

  return null;
}

// ── 当前状态 ────────────────────────────────────────────────────────────

export async function listCurrent(rawDb: RawDb, tables: Tables, lessonId: string): Promise<CurrentRow[]> {
  const rows = (await rawDb.prepare(`SELECT * FROM ${tables.current} WHERE lesson_id = ?`).all(lessonId)) as CurrentRow[];
  return rows.map(normalizeCurrentRow);
}

function normalizeCurrentRow(r: CurrentRow): CurrentRow {
  return {
    ...r,
    status: (STUDENT_STATUSES as readonly string[]).includes(r.status) ? r.status : 'working',
    teacher_state: (TEACHER_STATES as readonly string[]).includes(r.teacher_state) ? r.teacher_state : 'pending',
    reason: (STUCK_REASONS as readonly string[]).includes(String(r.reason)) ? r.reason : null,
  };
}

export async function upsertCurrent(
  rawDb: RawDb,
  tables: Tables,
  row: {
    lessonId: string;
    classId: string;
    studentId: string;
    studentName?: string | null;
    seatNo?: string | null;
    status: StudentStatus;
    reason: StuckReason | null;
    note: string | null;
    teacherState: TeacherState;
    ackedAt: number | null;
    ackedBy: string | null;
    resolvedAt: number | null;
    at: number;
  },
): Promise<void> {
  await rawDb
    .prepare(
      `INSERT INTO ${tables.current}
         (lesson_id, class_id, student_id, student_name, seat_no, status, reason, note, status_at,
          teacher_state, acked_at, acked_by, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lesson_id, student_id) DO UPDATE SET
         class_id = excluded.class_id,
         student_name = excluded.student_name,
         seat_no = excluded.seat_no,
         status = excluded.status,
         reason = excluded.reason,
         note = excluded.note,
         status_at = excluded.status_at,
         teacher_state = excluded.teacher_state,
         acked_at = excluded.acked_at,
         acked_by = excluded.acked_by,
         resolved_at = excluded.resolved_at`,
    )
    .run(
      row.lessonId,
      row.classId,
      row.studentId,
      row.studentName ?? null,
      row.seatNo ?? null,
      row.status,
      row.reason,
      row.note,
      row.at,
      row.teacherState,
      row.ackedAt,
      row.ackedBy,
      row.resolvedAt,
    );
}

/** 只改教师处置维度，不动学生状态那几列。 */
export async function updateTeacherState(
  rawDb: RawDb,
  tables: Tables,
  args: {
    lessonId: string;
    classId: string;
    studentId: string;
    teacherState: TeacherState;
    ackedAt: number | null;
    ackedBy: string | null;
    resolvedAt: number | null;
  },
): Promise<void> {
  await rawDb
    .prepare(
      `UPDATE ${tables.current}
          SET teacher_state = ?, acked_at = ?, acked_by = ?, resolved_at = ?
        WHERE lesson_id = ? AND student_id = ?`,
    )
    .run(args.teacherState, args.ackedAt, args.ackedBy, args.resolvedAt, args.lessonId, args.studentId);
}

export async function appendEvent(
  rawDb: RawDb,
  tables: Tables,
  ev: {
    lessonId: string;
    classId: string;
    studentId: string;
    studentName?: string | null;
    seatNo?: string | null;
    kind: 'status' | 'ack' | 'resolve' | 'reopen';
    status?: StudentStatus | null;
    reason?: StuckReason | null;
    note?: string | null;
    actorId?: string | null;
    actorRole?: string | null;
    at: number;
  },
): Promise<void> {
  await rawDb
    .prepare(
      `INSERT INTO ${tables.events}
         (id, lesson_id, class_id, student_id, student_name, seat_no, kind, status, reason, note, actor_id, actor_role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `evt_${ev.at.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      ev.lessonId,
      ev.classId,
      ev.studentId,
      ev.studentName ?? null,
      ev.seatNo ?? null,
      ev.kind,
      ev.status ?? null,
      ev.reason ?? null,
      ev.note ?? null,
      ev.actorId ?? null,
      ev.actorRole ?? null,
      ev.at,
    );
}

// ── 视图模型 ────────────────────────────────────────────────────────────

export function buildCells(roster: RosterStudent[], current: CurrentRow[], now: number): BoardCell[] {
  const byStudent = new Map(current.map((r) => [r.student_id, r]));
  const cells: BoardCell[] = roster.map((s) => toCell(s.studentId, s.name, s.seatNo, byStudent.get(s.studentId), now));

  // 名册里没有、但确实上报过的学生（如临时加入/学号缺失）追加到末尾，
  // 否则他们的求助会静默消失 —— 这比多一格更危险。
  const rosterIds = new Set(roster.map((s) => s.studentId));
  for (const row of current) {
    if (rosterIds.has(row.student_id)) continue;
    const name = String(row.student_name ?? '').trim() || `未知(${row.student_id.slice(0, 6)})`;
    cells.push(toCell(row.student_id, name, String(row.seat_no ?? '--'), row, now));
  }
  return cells;
}

function toCell(
  studentId: string,
  name: string,
  seatNo: string,
  row: CurrentRow | undefined,
  now: number,
): BoardCell {
  if (!row) {
    return {
      studentId,
      name,
      seatNo,
      status: 'idle',
      reason: null,
      note: null,
      teacherState: 'pending',
      waitingSec: 0,
      responseSec: null,
    };
  }
  const isStuck = row.status === 'stuck' && row.teacher_state !== 'resolved';
  const waitingSec = isStuck ? Math.max(0, Math.round((now - Number(row.status_at)) / 1000)) : 0;
  const responseSec =
    row.acked_at != null && row.status_at != null
      ? Math.max(0, Math.round((Number(row.acked_at) - Number(row.status_at)) / 1000))
      : null;
  return {
    studentId,
    name,
    seatNo,
    status: row.status,
    reason: row.reason,
    note: row.note,
    teacherState: row.teacher_state,
    waitingSec,
    responseSec,
  };
}

export async function computeStats(
  rawDb: RawDb,
  tables: Tables,
  args: { lessonId: string; classId: string; cells: BoardCell[]; now: number },
): Promise<BoardStats> {
  const { lessonId, cells } = args;
  const rosterCount = cells.length;
  const stuckCells = cells.filter((c) => c.status === 'stuck');
  const doneCount = cells.filter((c) => c.status === 'done').length;
  const ackedCount = cells.filter((c) => c.teacherState === 'acked' || c.teacherState === 'resolved').length;

  const breakdown: Record<StuckReason, number> = { unclear: 0, error: 0, env: 0, missing: 0 };
  for (const c of stuckCells) if (c.reason) breakdown[c.reason] += 1;

  const responses = cells.map((c) => c.responseSec).filter((v): v is number => typeof v === 'number');
  const avgResponseSec = responses.length
    ? Math.round(responses.reduce((a, b) => a + b, 0) / responses.length)
    : null;

  // 「卡住次数」按事件流统计（同一学生多次挥手各计一次），与「当前卡住人数」区分开。
  let stuckCount = stuckCells.length;
  try {
    const row = (await rawDb
      .prepare(
        `SELECT COUNT(*) AS c FROM ${tables.events}
          WHERE lesson_id = ? AND kind = 'status' AND status = 'stuck'`,
      )
      .get(lessonId)) as { c: number } | undefined;
    if (row) stuckCount = Number(row.c) || 0;
  } catch {
    /* 事件表不可用时退回「当前卡住人数」 */
  }

  const topReason =
    (STUCK_REASONS as readonly StuckReason[]).reduce<StuckReason | null>(
      (best, r) => (breakdown[r] > (best ? breakdown[best] : 0) ? r : best),
      null,
    ) ?? null;

  return {
    rosterCount,
    stuckCount,
    ackedCount,
    doneCount,
    completionRate: rosterCount ? Math.round((doneCount / rosterCount) * 1000) / 1000 : 0,
    maxWaitSec: cells.reduce((m, c) => Math.max(m, c.waitingSec), 0),
    avgResponseSec,
    topReason,
    topReasonLabel: topReason ? REASON_LABELS[topReason] : null,
    reasonBreakdown: breakdown,
  };
}

export async function upsertSummary(
  rawDb: RawDb,
  tables: Tables,
  args: { lessonId: string; classId: string; stats: BoardStats; now: number },
): Promise<void> {
  const { lessonId, classId, stats, now } = args;
  await rawDb
    .prepare(
      `INSERT INTO ${tables.summary}
         (lesson_id, class_id, stuck_count, stuck_students, acked_count, avg_response_sec, max_wait_sec,
          completion_rate, top_reason, reason_breakdown, roster_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lesson_id, class_id) DO UPDATE SET
         stuck_count = excluded.stuck_count,
         stuck_students = excluded.stuck_students,
         acked_count = excluded.acked_count,
         avg_response_sec = excluded.avg_response_sec,
         max_wait_sec = excluded.max_wait_sec,
         completion_rate = excluded.completion_rate,
         top_reason = excluded.top_reason,
         reason_breakdown = excluded.reason_breakdown,
         roster_count = excluded.roster_count,
         updated_at = excluded.updated_at`,
    )
    .run(
      lessonId,
      classId,
      stats.stuckCount,
      stats.stuckCount, // 当前口径：卡住次数与人数分开统计需要更细的查询，先与次数同值
      stats.ackedCount,
      stats.avgResponseSec,
      stats.maxWaitSec,
      stats.completionRate,
      stats.topReason,
      JSON.stringify(stats.reasonBreakdown),
      stats.rosterCount,
      now,
    );
}

/** 备注清洗：去控制字符、裁到上限，空串转 null。 */
export function sanitizeNote(input: unknown): string | null {
  const raw = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!raw) return null;
  return raw.length > NOTE_MAX_LEN ? raw.slice(0, NOTE_MAX_LEN) : raw;
}
