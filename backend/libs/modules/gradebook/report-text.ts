import { DateTime } from 'luxon';
import { trim } from './format.js';
import type { ReportSnapshot } from './report-snapshot.js';

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const DATE = 'dd.MM.yyyy';

/**
 * The report as a Telegram HTML message (5.12 «форматированное сообщение»), the same for the teacher's preview,
 * the `report.sent` notification and the «Отчёты» screens. Texts come from `report-*` keys of the locale.
 */
export function renderReport(t: Translate, s: ReportSnapshot, comment: string | null): string {
  const lines: string[] = [
    t('rpt-title', {
      student: esc(s.student.name),
      from: DateTime.fromISO(s.period.from).toFormat(DATE),
      to: DateTime.fromISO(s.period.to).toFormat(DATE),
      teacher: esc(s.teacher.name),
    }),
    '',
    t('rpt-lessons', {
      held: s.lessons.held,
      notHeld: s.lessons.notHeld,
      present: s.lessons.attendance.present,
      late: s.lessons.attendance.late,
      absentNotified: s.lessons.attendance.absent_notified,
      absent: s.lessons.attendance.absent,
    }),
  ];
  if (s.lessons.topics.length > 0) lines.push(t('rpt-topics', { topics: esc(s.lessons.topics.join('; ')) }));
  const c = s.lessons.cancelled;
  if (c.total > 0)
    lines.push(
      t('rpt-cancelled', {
        total: c.total,
        byTeacher: c.byTeacher,
        byStudent: c.byStudent + c.byParent,
        system: c.system,
        late: c.late,
      }),
    );
  const hw = s.homework;
  if (hw.assigned > 0)
    lines.push(
      '',
      t('rpt-homework', {
        assigned: hw.assigned,
        onTime: hw.onTime,
        late: hw.late,
        notSubmitted: hw.notSubmitted,
        accepted: hw.accepted,
        returned: hw.returned,
        average: hw.averageMark === null ? '—' : trim(hw.averageMark),
      }),
    );
  for (const subject of s.subjects) {
    const block: string[] = [];
    if (subject.school && subject.school.count > 0)
      block.push(
        t('rpt-school', {
          count: subject.school.count,
          average: subject.school.average === null ? '—' : trim(subject.school.average),
        }),
      );
    if (subject.tests && subject.tests.count > 0) {
      const ts = subject.tests;
      block.push(
        t('rpt-tests', {
          count: ts.count,
          last: ts.last ? `${trim(ts.last.value)}/${trim(ts.last.max)} (${trim(ts.last.percent)} %)` : '—',
          delta:
            ts.delta === null
              ? ''
              : ts.delta > 0
                ? ` ▲ +${trim(ts.delta)}`
                : ts.delta < 0
                  ? ` ▼ −${trim(Math.abs(ts.delta))}`
                  : '',
          best: ts.best ? `${trim(ts.best.percent)} %` : '—',
          average: ts.average === null ? '—' : `${trim(ts.average)} %`,
          target: ts.targetPercent === null ? '—' : `${trim(ts.targetPercent)} %`,
        }),
      );
    }
    if (subject.custom && subject.custom.count > 0)
      block.push(
        t('rpt-custom', {
          values: subject.custom.values.map((v) => `${esc(v.label)} × ${v.count}`).join(', '),
        }),
      );
    if (block.length > 0) lines.push('', t('rpt-subject', { subject: esc(subject.name) }), ...block);
  }
  if (comment) lines.push('', t('rpt-teacher-comment', { comment: esc(comment) }));
  return lines.join('\n');
}
