import { AppError, type ErrorCode } from '@shared/errors/app-error.js';

/** Errors after which repeating the dialog cannot succeed: the flow is dropped, the error text is shown. */
const TERMINAL: readonly ErrorCode[] = [
  'NOT_FOUND',
  'CONFLICT',
  'LINK_NOT_ACTIVE',
  'LIMIT_EXCEEDED',
  'FEATURE_DISABLED',
  'FORBIDDEN',
];

export function isTerminalFlowError(error: unknown): boolean {
  return AppError.is(error) && TERMINAL.includes(error.code);
}
