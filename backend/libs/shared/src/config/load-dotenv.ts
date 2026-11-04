import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const QUOTES = ['"', "'"];

/**
 * Minimal `.env` loader: KEY=VALUE lines, `#` comments, optional quotes.
 * Existing process.env values always win so that container and CI environments override the file.
 */
export function loadDotEnv(file = resolve(process.cwd(), '.env')): void {
  if (!existsSync(file)) return;
  const content = readFileSync(file, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const first = value.charAt(0);
    if (value.length >= 2 && QUOTES.includes(first) && value.endsWith(first)) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
