import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal in-process S3 stand-in for machines without Docker (`TEST_SERVICES=local`): path-style
 * HeadBucket / CreateBucket / PutObject / GetObject / HeadObject / DeleteObject, nothing more. CI keeps
 * using the real S3 container from Testcontainers; this exists only so the integration suite can run locally.
 */
export class FakeS3 {
  private readonly buckets = new Map<string, Map<string, { body: Buffer; mime: string }>>();
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        res.statusCode = 500;
        res.end(String(error));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [, bucketName = '', ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    const method = req.method ?? 'GET';
    const bucket = this.buckets.get(bucketName);
    if (!key) {
      if (method === 'PUT') {
        if (bucket) return this.xmlError(res, 409, 'BucketAlreadyOwnedByYou');
        this.buckets.set(bucketName, new Map());
        res.statusCode = 200;
        res.end();
        return;
      }
      if (method === 'HEAD') {
        res.statusCode = bucket ? 200 : 404;
        res.end();
        return;
      }
      return this.xmlError(res, 400, 'NotImplemented');
    }
    if (!bucket) return this.xmlError(res, 404, 'NoSuchBucket', method === 'HEAD');
    if (method === 'PUT') {
      const body = await this.readBody(req);
      bucket.set(key, { body, mime: String(req.headers['content-type'] ?? 'application/octet-stream') });
      res.setHeader('ETag', `"${body.length}"`);
      res.statusCode = 200;
      res.end();
      return;
    }
    const object = bucket.get(key);
    if (method === 'DELETE') {
      bucket.delete(key);
      res.statusCode = 204;
      res.end();
      return;
    }
    if (!object) return this.xmlError(res, 404, 'NoSuchKey', method === 'HEAD');
    res.setHeader('Content-Type', object.mime);
    res.setHeader('Content-Length', object.body.length);
    res.setHeader('ETag', `"${object.body.length}"`);
    res.statusCode = 200;
    res.end(method === 'HEAD' ? undefined : object.body);
  }

  /** Plain bodies and `aws-chunked` bodies (signed chunks with trailers) alike. */
  private async readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const encoding = String(req.headers['content-encoding'] ?? '');
    if (!encoding.includes('aws-chunked')) return raw;
    const out: Buffer[] = [];
    let offset = 0;
    while (offset < raw.length) {
      const lineEnd = raw.indexOf('\r\n', offset);
      if (lineEnd < 0) break;
      const size = parseInt(raw.subarray(offset, lineEnd).toString('latin1').split(';')[0]!, 16);
      if (!Number.isFinite(size) || size === 0) break;
      out.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
      offset = lineEnd + 2 + size + 2;
    }
    return Buffer.concat(out);
  }

  private xmlError(res: ServerResponse, status: number, code: string, headOnly = false): void {
    res.statusCode = status;
    if (headOnly) {
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/xml');
    res.end(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
    );
  }
}
