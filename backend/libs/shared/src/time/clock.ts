import { Injectable } from '@nestjs/common';

/** Injectable clock so that use-cases are testable without faking global timers. */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock extends Clock {
  private current: Date;

  constructor(initial: Date | string) {
    super();
    this.current = new Date(initial);
  }

  override now(): Date {
    return new Date(this.current);
  }

  set(next: Date | string): void {
    this.current = new Date(next);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export function addHours(date: Date, hours: number): Date {
  return addMs(date, hours * HOUR_MS);
}

export function addDays(date: Date, days: number): Date {
  return addMs(date, days * DAY_MS);
}
