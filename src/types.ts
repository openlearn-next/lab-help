/**
 * 领域类型与常量 —— 两端（服务端 handler / 沙箱页面）共享同一套枚举字面量。
 * 沙箱页面是纯 HTML，不走模块打包，所以这里的取值必须与 storage/*.html 里的保持一致。
 */

/** 学生维度状态：只能由学生本人切换，三者互斥。 */
export type StudentStatus = 'working' | 'stuck' | 'done';

/**
 * 看板单元格状态 = 学生状态 + 本课节尚未上报时的 `idle`。
 * `idle` 只存在于视图层，不会被写进库（学生没有上报就没有 current 行）。
 */
export type CellStatus = StudentStatus | 'idle';

/** 教师处置维度：独立于学生状态，学生改状态不会重置它。 */
export type TeacherState = 'pending' | 'acked' | 'resolved';

/** 卡住原因分类：四选一，用于教师端分诊与课后聚合。 */
export type StuckReason = 'unclear' | 'error' | 'env' | 'missing';

export const STUDENT_STATUSES: readonly StudentStatus[] = ['working', 'stuck', 'done'];
export const TEACHER_STATES: readonly TeacherState[] = ['pending', 'acked', 'resolved'];
export const STUCK_REASONS: readonly StuckReason[] = ['unclear', 'error', 'env', 'missing'];

export const REASON_LABELS: Record<StuckReason, string> = {
  unclear: '看不懂题',
  error: '代码报错',
  env: '电脑或网络',
  missing: '找不到文件',
};

export const STATUS_LABELS: Record<StudentStatus, string> = {
  working: '进行中',
  stuck: '卡住了',
  done: '已完成',
};

/** 备注长度上限：学生端输入框同步限制，服务端再做一次裁剪。 */
export const NOTE_MAX_LEN = 60;

/** 当前状态表的一行（教师端看板的单元格数据来源）。 */
export interface CurrentRow {
  lesson_id: string;
  class_id: string;
  student_id: string;
  /** 上报时快照的姓名/机位：名册读不到时也能在导出与看板里显示 */
  student_name?: string | null;
  seat_no?: string | null;
  status: StudentStatus;
  reason: StuckReason | null;
  note: string | null;
  status_at: number;
  teacher_state: TeacherState;
  acked_at: number | null;
  acked_by: string | null;
  resolved_at: number | null;
}

/** 班级名册里的一名学生（未上报也会出现在教师端网格里）。 */
export interface RosterStudent {
  studentId: string;
  name: string;
  seatNo: string;
  order: number;
}

/** 教师端单元格：名册 × 当前状态 合并后的视图模型。 */
export interface BoardCell {
  studentId: string;
  name: string;
  seatNo: string;
  status: CellStatus;
  reason: StuckReason | null;
  note: string | null;
  teacherState: TeacherState;
  /** 卡住已等待秒数（非卡住为 0）。 */
  waitingSec: number;
  /** 已响应耗时秒数（教师 ack − 学生上报）。 */
  responseSec: number | null;
}

export interface BoardStats {
  rosterCount: number;
  stuckCount: number;
  ackedCount: number;
  doneCount: number;
  completionRate: number;
  maxWaitSec: number;
  avgResponseSec: number | null;
  topReason: StuckReason | null;
  topReasonLabel: string | null;
  reasonBreakdown: Record<StuckReason, number>;
}

export interface BoardPayload {
  lessonId: string;
  classId: string;
  cells: BoardCell[];
  stats: BoardStats;
  serverTime: number;
}
