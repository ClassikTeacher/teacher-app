import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '@shared/errors/app-error.js';
import { ActorResolver } from '@modules/identity/actor-resolver.js';
import type { Role } from '@modules/identity/schema.js';
import { type Actor, assertActive, hasRole } from '../actor.js';
import { AuthTokenService } from './auth-token.service.js';

export const ACTOR_KEY = Symbol.for('tutor.actor');
const ROLES_KEY = 'tutor:roles';

/** Early role check for controllers; use-cases still verify role + context themselves (8.0). */
export const RequireRoles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const request = ctx.switchToHttp().getRequest<FastifyRequest & Record<symbol, Actor | undefined>>();
  const actor = request[ACTOR_KEY];
  if (!actor) throw new AppError('UNAUTHORIZED', 'Not authenticated');
  return actor;
});

@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: AuthTokenService,
    private readonly actors: ActorResolver,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & Record<symbol, Actor | undefined>>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError('UNAUTHORIZED', 'Bearer token required');
    const { accountId } = await this.tokens.verify(header.slice('Bearer '.length).trim());
    const resolved = await this.actors.byAccountId(accountId, 'api');
    if (!resolved) throw new AppError('UNAUTHORIZED', 'Invalid or expired token');
    assertActive(resolved.actor);
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && required.length > 0 && !hasRole(resolved.actor, ...required)) {
      throw new AppError('FORBIDDEN', 'Insufficient role');
    }
    request[ACTOR_KEY] = { ...resolved.actor, ip: request.ip };
    return true;
  }
}
