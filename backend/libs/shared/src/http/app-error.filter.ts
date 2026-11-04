import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error.js';
import { type ApiFailure, fail } from './envelope.js';

const HTTP_TO_CODE: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'VALIDATION_ERROR',
  415: 'VALIDATION_ERROR',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
};

interface StatusError {
  statusCode: number;
  message: string;
}

function hasClientStatus(error: unknown): error is StatusError {
  const candidate = error as Partial<StatusError> | null;
  return (
    typeof candidate?.statusCode === 'number' &&
    candidate.statusCode >= 400 &&
    candidate.statusCode < 500 &&
    typeof candidate.message === 'string'
  );
}

/** Maps AppError, HttpException and Fastify client errors to the envelope; never leaks internals for 5xx. */
@Catch()
export class AppErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const { status, body } = this.toResponse(exception, request.id);
    if (status >= 500) {
      this.logger.error({ err: exception, method: request.method, url: request.url }, 'Unhandled error');
    }
    void reply.status(status).send(body);
  }

  private toResponse(exception: unknown, correlationId: string): { status: number; body: ApiFailure } {
    if (exception instanceof AppError) {
      return {
        status: exception.httpStatus,
        body: fail(exception.code, exception.message, { ...exception.details, correlationId }),
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status < 500) {
        return {
          status,
          body: fail(HTTP_TO_CODE[status] ?? 'VALIDATION_ERROR', exception.message, { correlationId }),
        };
      }
    } else if (hasClientStatus(exception)) {
      const status = exception.statusCode;
      return {
        status,
        body: fail(HTTP_TO_CODE[status] ?? 'VALIDATION_ERROR', exception.message, { correlationId }),
      };
    }
    return { status: 500, body: fail('INTERNAL', 'Internal server error', { correlationId }) };
  }
}
