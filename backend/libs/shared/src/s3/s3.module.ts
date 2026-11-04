import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';

export const S3 = Symbol('S3');

export type S3Env = Pick<
  Env,
  'S3_ENDPOINT' | 'S3_REGION' | 'S3_ACCESS_KEY' | 'S3_SECRET_KEY' | 'S3_FORCE_PATH_STYLE'
>;

export function createS3Client(env: S3Env): S3Client {
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

/**
 * Creates the private bucket if it does not exist (replaces an `mc mb` init container).
 * A concurrent creator (api and worker starting together) yields 409, which counts as "exists".
 */
export async function ensureBucket(
  client: S3Client,
  bucket: string,
  attempts = 5,
): Promise<'exists' | 'created'> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return 'exists';
    } catch (error) {
      const status = httpStatus(error);
      if (status === 404) break;
      if (attempt >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    return 'created';
  } catch (error) {
    if (httpStatus(error) === 409) return 'exists';
    throw error;
  }
}

@Injectable()
export class S3Bootstrap implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(S3Bootstrap.name);

  constructor(
    @Inject(S3) private readonly client: S3Client,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.env.S3_AUTO_CREATE_BUCKET) return;
    const state = await ensureBucket(this.client, this.env.S3_BUCKET_FILES);
    this.logger.log(`S3 bucket ${this.env.S3_BUCKET_FILES}: ${state}`);
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

@Global()
@Module({
  providers: [
    { provide: S3, inject: [ENV], useFactory: (env: Env): S3Client => createS3Client(env) },
    S3Bootstrap,
  ],
  exports: [S3],
})
export class S3Module {}
