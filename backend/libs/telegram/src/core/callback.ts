/**
 * callback_data helpers. Telegram allows 64 bytes, so keys are `ns:action[:arg...]` with short namespaces;
 * anything larger (two UUIDs) must live in the session instead.
 */
const SEPARATOR = ':';
const MAX_BYTES = 64;

export interface ParsedCallback {
  ns: string;
  action: string;
  args: string[];
}

export function cb(ns: string, action: string, ...args: Array<string | number>): string {
  const data = [ns, action, ...args.map(String)].join(SEPARATOR);
  if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) {
    throw new Error(`callback_data exceeds ${MAX_BYTES} bytes: ${data}`);
  }
  return data;
}

export function parseCb(data: string | undefined): ParsedCallback | null {
  if (!data) return null;
  const [ns, action, ...args] = data.split(SEPARATOR);
  if (!ns || !action) return null;
  return { ns, action, args };
}

/** Namespace used by flow steps; the flow itself is known from the session. */
export const FLOW_NS = 'f';
export const MENU_NS = 'm';
