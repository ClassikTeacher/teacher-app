import { Socket } from 'node:net';
import { Injectable, Logger } from '@nestjs/common';

/** `unavailable`: the scanner could not be reached; the file waits for a re-scan instead of being lost (10.4). */
export type ScanResult = 'clean' | 'infected' | 'skipped' | 'unavailable';

/** HW-05: the antivirus step is pluggable; without a configured scanner every file is `skipped`. */
export abstract class VirusScanner {
  abstract readonly enabled: boolean;
  abstract scan(bytes: Uint8Array): Promise<{ result: ScanResult; detail: string | null }>;
}

@Injectable()
export class NoopVirusScanner extends VirusScanner {
  readonly enabled = false;

  async scan(): Promise<{ result: ScanResult; detail: string | null }> {
    return { result: 'skipped', detail: null };
  }
}

export interface ClamdOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

const CHUNK = 64 * 1024;
const FOUND = /^stream: (.+) FOUND$/m;

/** clamd `zINSTREAM`: length-prefixed chunks over TCP, a zero-length chunk ends the stream. */
export class ClamdVirusScanner extends VirusScanner {
  readonly enabled = true;
  private readonly logger = new Logger(ClamdVirusScanner.name);

  constructor(private readonly options: ClamdOptions) {
    super();
  }

  async scan(bytes: Uint8Array): Promise<{ result: ScanResult; detail: string | null }> {
    try {
      const reply = await this.instream(bytes);
      const match = FOUND.exec(reply);
      if (match) return { result: 'infected', detail: match[1]!.trim() };
      if (/stream: OK/.test(reply)) return { result: 'clean', detail: null };
      this.logger.warn({ reply }, 'unexpected clamd reply');
      return { result: 'unavailable', detail: reply.slice(0, 200) };
    } catch (error) {
      this.logger.warn({ err: error }, 'clamd unavailable');
      return { result: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private instream(bytes: Uint8Array): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      socket.setTimeout(this.options.timeoutMs ?? 30_000);
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('clamd timeout'));
      });
      socket.once('error', reject);
      socket.on('data', (d: Buffer) => chunks.push(d));
      socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.connect(this.options.port, this.options.host, () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          const part = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
          const header = Buffer.alloc(4);
          header.writeUInt32BE(part.length, 0);
          socket.write(header);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk terminates
      });
    });
  }
}
