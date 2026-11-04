import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '@shared/config/index.js';
import { S3 } from '@shared/s3/s3.module.js';

/** S3 reports a missing key as NoSuchKey / NotFound (404). */
export function isMissingObject(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/** RFC 5987 `filename*` value: percent-encode everything `encodeURIComponent` leaves (`'()*`). */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 5.9.4 💡: a download link lives one hour. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * The private bucket behind every file (7.5 «Файлы»): random object keys (never the original name), closed
 * bucket, short-lived signed links. Only this class talks to S3 for content.
 */
@Injectable()
export class FileStorage {
  constructor(
    @Inject(S3) private readonly client: S3Client,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get bucket(): string {
    return this.env.S3_BUCKET_FILES;
  }

  /** `<teacher>/<yyyy>/<mm>/<random>`: prefixes make per-teacher clean-up and lifecycle rules possible. */
  newKey(ownerTeacherId: string, now: Date): string {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${ownerTeacherId}/${yyyy}/${mm}/${randomBytes(16).toString('hex')}`;
  }

  async put(key: string, body: Uint8Array, mime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime }),
    );
  }

  async get(key: string): Promise<Readable> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = out.Body;
    if (!body) throw new Error(`empty S3 body for ${key}`);
    if (body instanceof Readable) return body;
    // browser-style stream (not expected in Node, kept for safety)
    return Readable.fromWeb(body.transformToWebStream() as never);
  }

  async getBytes(key: string): Promise<Buffer> {
    const stream = await this.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** A short-lived GET link with the original name as the download name. */
  async signedUrl(key: string, downloadName: string, ttlSeconds = SIGNED_URL_TTL_SECONDS): Promise<string> {
    const safe = downloadName.replace(/[^\p{L}\p{N} ._()-]/gu, '_');
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename*=UTF-8''${rfc5987(safe)}`,
      }),
      { expiresIn: ttlSeconds },
    );
  }
}
