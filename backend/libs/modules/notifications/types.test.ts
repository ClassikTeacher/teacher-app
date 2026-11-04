import { describe, expect, it } from 'vitest';
import { NotificationRenderer } from './render.js';
import { botForRecipient, NOTIFICATION_TYPES } from './types.js';

describe('notification routing (5.13.1)', () => {
  it('picks the bot from the recipient roles', () => {
    expect(botForRecipient(['TEACHER'])).toBe('staff');
    expect(botForRecipient(['ADMIN'])).toBe('staff');
    expect(botForRecipient(['TEACHER', 'PARENT'])).toBe('staff');
    expect(botForRecipient(['PARENT'])).toBe('parent');
    expect(botForRecipient(['STUDENT'])).toBe('student');
    expect(botForRecipient(['STUDENT', 'PARENT'])).toBe('student');
    expect(botForRecipient([])).toBe('student');
    expect(botForRecipient(['TEACHER'], 'security')).toBe('auth');
  });
});

describe('notification templates', () => {
  const renderer = new NotificationRenderer();

  it('has a Russian template for every registered type', () => {
    for (const code of Object.keys(NOTIFICATION_TYPES)) {
      expect(
        renderer.render({
          typeCode: code,
          payload: {
            name: 'Анна',
            handle: ' (@anna)',
            feature: 'x',
            enabled: 'on',
            from: 'A',
            to: 'B',
            subjects: 'Математика',
            parent: 'Мария',
            child: 'Петя',
            view: 'student',
            byText: 'по решению родителя',
            teacher: 'Анна',
            student: 'Петя',
            reason: 'ученик ушёл',
            message: 'Пока',
            decision: 'approved',
            comment: '',
            when: 'вт 20.10 10:00',
            duration: 60,
            subject: 'Математика',
            withWhom: '',
            dates: 'вт 20.10 10:00',
            created: 3,
            ended: 'no',
            who: 'Петя',
            topic: 'Дроби',
            attendance: 'present',
            days: 'пн, ср',
            time: '16:00',
            by: 'Мария',
            lateMark: '',
            date: 'пн 19.10',
            group: '10А',
            cause: 'Причина',
            source: 'other',
            count: 2,
            lessons: '10:00 Петя',
            awaiting: 0,
            requests: 1,
            slots: 'сб 24.10 12:00',
            kind: 'reschedule',
            title: 'Формулы',
            due: '05.11 18:00',
            unchecked: 1,
            hours: 2,
            attempt: 1,
            late: 'no',
            files: 0,
            cancelled: 'x',
            cancelledCount: 1,
            absences: '',
            absenceCount: 0,
            grades: 0,
            value: '8',
            type: 'school',
            by: 'Петя',
          },
        }),
        code,
      ).not.toBeNull();
    }
  });

  it('renders variables and selectors', () => {
    expect(
      renderer.render({
        typeCode: 'admin.teacher_onboarded',
        payload: { name: 'Анна П', handle: ' (@anna)' },
      }),
    ).toContain('(@anna)');
    expect(
      renderer.render({ typeCode: 'admin.teacher_onboarded', payload: { name: 'Анна П', handle: '' } }),
    ).not.toContain('@');
    expect(
      renderer.render({ typeCode: 'feature.changed', payload: { feature: 'Группы', enabled: 'off' } }),
    ).toContain('отключена');
    expect(renderer.render({ typeCode: 'unknown.type', payload: {} })).toBeNull();
    expect(renderer.render({ typeCode: 'security.sa_transfer_confirmed', payload: {} })).toBeNull(); // missing vars
  });
});
