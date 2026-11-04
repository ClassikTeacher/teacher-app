import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError } from '../errors/app-error.js';

/** Validates a request part against a zod schema and throws VALIDATION_ERROR with issue details. */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw AppError.validation('Validation failed', { issues });
  }
}
