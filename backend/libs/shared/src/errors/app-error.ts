/**
 * Domain error codes (PRODUCT-SPEC 9.1). Bots map them to i18n messages, REST maps them to HTTP statuses.
 */
export const ERROR_CODES = [
  'LESSON_CONFLICT',
  'LESSON_STARTED',
  'OUTSIDE_AVAILABILITY',
  'WEEKLY_LIMIT_EXCEEDED',
  'SLOT_REQUESTS_FULL',
  'FEATURE_DISABLED',
  'LIMIT_EXCEEDED',
  'STORAGE_QUOTA_EXCEEDED',
  'UPLOAD_RATE_LIMIT',
  'CANCEL_REASON_REQUIRED',
  'CANCEL_CUTOFF',
  'CANCEL_DISABLED',
  'LINK_NOT_ACTIVE',
  'PARENT_CONSENT_REQUIRED',
  'FILE_TYPE_NOT_ALLOWED',
  'FILE_TOO_LARGE',
  'FILE_REJECTED',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'CONFLICT',
  'INVITATION_INVALID',
  'INVITATION_NOT_FOR_YOU',
  'ACCOUNT_BLOCKED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Record<ErrorCode, number> = {
  LESSON_CONFLICT: 409,
  LESSON_STARTED: 409,
  OUTSIDE_AVAILABILITY: 422,
  WEEKLY_LIMIT_EXCEEDED: 422,
  SLOT_REQUESTS_FULL: 409,
  FEATURE_DISABLED: 403,
  LIMIT_EXCEEDED: 422,
  STORAGE_QUOTA_EXCEEDED: 422,
  UPLOAD_RATE_LIMIT: 429,
  CANCEL_REASON_REQUIRED: 422,
  CANCEL_CUTOFF: 422,
  CANCEL_DISABLED: 403,
  LINK_NOT_ACTIVE: 409,
  PARENT_CONSENT_REQUIRED: 409,
  FILE_TYPE_NOT_ALLOWED: 422,
  FILE_TOO_LARGE: 422,
  FILE_REJECTED: 422,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  INVITATION_INVALID: 410,
  INVITATION_NOT_FOR_YOU: 403,
  ACCOUNT_BLOCKED: 403,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  static notFound(entity: string, id?: string): AppError {
    return new AppError('NOT_FOUND', `${entity} not found`, id ? { entity, id } : { entity });
  }

  static forbidden(reason?: string, details?: Record<string, unknown>): AppError {
    return new AppError('FORBIDDEN', reason ?? 'Forbidden', details);
  }

  static validation(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('VALIDATION_ERROR', message, details);
  }

  static is(error: unknown, code?: ErrorCode): error is AppError {
    return error instanceof AppError && (code === undefined || error.code === code);
  }
}
