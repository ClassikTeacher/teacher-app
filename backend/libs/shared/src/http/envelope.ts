/** Unified REST envelope (PRODUCT-SPEC 9.1). */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  error: null;
  meta?: PageMeta;
}

export interface ApiFailure {
  success: false;
  data: null;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** Controllers return this to attach pagination meta; the interceptor unwraps it. */
export class Paged<T> {
  constructor(
    readonly items: T[],
    readonly meta: PageMeta,
  ) {}
}

export function ok<T>(data: T, meta?: PageMeta): ApiSuccess<T> {
  return meta ? { success: true, data, error: null, meta } : { success: true, data, error: null };
}

export function fail(code: string, message: string, details?: Record<string, unknown>): ApiFailure {
  return { success: false, data: null, error: details ? { code, message, details } : { code, message } };
}
