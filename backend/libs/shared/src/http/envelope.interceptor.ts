import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { type ApiSuccess, ok, Paged } from './envelope.js';

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<ApiSuccess<unknown>> {
    return next.handle().pipe(
      map((value: unknown) => {
        if (value instanceof Paged) return ok(value.items, value.meta);
        return ok(value ?? null);
      }),
    );
  }
}
