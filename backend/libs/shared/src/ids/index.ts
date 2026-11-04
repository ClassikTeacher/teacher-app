import { v7 as uuidv7, validate as uuidValidate } from 'uuid';

/** UUID v7 generated in the application (PostgreSQL 16 has no native generator). */
export function newId(): string {
  return uuidv7();
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidValidate(value);
}
