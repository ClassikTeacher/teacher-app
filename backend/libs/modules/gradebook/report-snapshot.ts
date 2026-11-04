import type { Attendance } from '@modules/schedule/schema.js';
import type { CustomStats, SchoolStats, TestStats } from './stats.js';

/**
 * 5.12: what a progress report keeps as of the moment it was built. Stored as `report.snapshot` (8.0: a
 * snapshot, not a projection), so an old report reads the same after the journals changed. Names are copied
 * in (plain text, escaped at render time).
 */
export interface ReportSnapshot {
  version: 1;
  period: { from: string; to: string };
  teacher: { id: string; name: string };
  student: { id: string; name: string };
  lessons: {
    held: number;
    notHeld: number;
    topics: string[];
    attendance: Record<Attendance, number>;
    cancelled: {
      total: number;
      byTeacher: number;
      byStudent: number;
      byParent: number;
      system: number;
      late: number;
    };
  };
  homework: {
    assigned: number;
    onTime: number;
    late: number;
    notSubmitted: number;
    accepted: number;
    returned: number;
    /** Average school mark of records tied to assignments in the period, if any. */
    averageMark: number | null;
  };
  subjects: ReportSubject[];
}

export interface ReportSubject {
  subjectId: string;
  name: string;
  school: SchoolStats | null;
  tests: (TestStats & { targetPercent: number | null }) | null;
  custom: { count: number; values: Array<{ label: string; count: number }>; average: number | null } | null;
}

export const EMPTY_ATTENDANCE: Record<Attendance, number> = {
  present: 0,
  late: 0,
  absent_notified: 0,
  absent: 0,
};

export function isReportSnapshot(value: unknown): value is ReportSnapshot {
  return typeof value === 'object' && value !== null && (value as { version?: unknown }).version === 1;
}

export type CustomStatsLike = CustomStats;
