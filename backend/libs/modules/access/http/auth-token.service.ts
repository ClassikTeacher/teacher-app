import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { ENV, type Env } from '@shared/config/index.js';
import { AppError } from '@shared/errors/app-error.js';
import { isUuid } from '@shared/ids/index.js';
import { Clock } from '@shared/time/clock.js';

const ISSUER = 'tutor-platform';
const AUDIENCE = 'api';
const ALGORITHM = 'HS256';
export const MAX_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/**
 * Short-lived access tokens (HS256). Issuance via AuthBot codes is stage 2 (5.2); in the MVP tokens are
 * minted for tests and operators (`pnpm token:issue`). Verification is already in place for every REST call.
 */
@Injectable()
export class AuthTokenService {
  private readonly key: Uint8Array;

  constructor(
    @Inject(ENV) env: Env,
    private readonly clock: Clock,
  ) {
    this.key = new TextEncoder().encode(env.JWT_SECRET);
  }

  async issue(accountId: string, ttlSeconds = 15 * 60): Promise<string> {
    if (!isUuid(accountId)) throw AppError.validation('accountId must be a UUID');
    if (!Number.isFinite(ttlSeconds) || ttlSeconds > MAX_TOKEN_TTL_SECONDS) {
      throw AppError.validation(`ttl must be a number of seconds up to ${MAX_TOKEN_TTL_SECONDS}`);
    }
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(accountId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + ttlSeconds)
      .sign(this.key);
  }

  async verify(token: string): Promise<{ accountId: string }> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: [ALGORITHM],
        currentDate: this.clock.now(),
      });
      if (!isUuid(payload.sub)) throw new Error('invalid sub');
      return { accountId: payload.sub };
    } catch {
      throw new AppError('UNAUTHORIZED', 'Invalid or expired token');
    }
  }
}
