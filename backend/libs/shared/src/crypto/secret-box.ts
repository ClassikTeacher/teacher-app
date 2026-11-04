import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Authenticated encryption of secrets at rest (10.1: «токены Google … в БД шифруются»): AES-256-GCM with a random
 * nonce per value. The sealed form is `v1.<iv>.<tag>.<ciphertext>` in base64url, so a future key or algorithm
 * change can read old rows by the prefix. The key never leaves the process; rotating it means re-sealing rows.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('SecretBox: the key must be 32 bytes in hex');
    this.key = Buffer.from(keyHex, 'hex');
  }

  seal(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join(
      '.',
    );
  }

  /** Throws on a tampered, truncated or foreign-key value: the caller treats it as «no token». */
  open(sealed: string): string {
    const [version, ivB64, tagB64, bodyB64] = sealed.split('.');
    if (version !== VERSION || !ivB64 || !tagB64 || bodyB64 === undefined)
      throw new Error('SecretBox: malformed value');
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('SecretBox: malformed value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64url')), decipher.final()]).toString(
      'utf8',
    );
  }
}
