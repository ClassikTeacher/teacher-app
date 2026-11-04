/**
 * Two UUIDs do not fit a 64-byte callback payload. A list entry is referenced by its index in the rendered
 * list plus a short suffix of its id; resolving checks the suffix, so a button left on an old message
 * (list changed since) is refused instead of acting on a different row.
 */
export const REF_CHECK_LENGTH = 4;

/** The *tail* of the id: UUID v7 ids share their leading (timestamp) characters, the trailing ones are random. */
export function shortRef(id: string, index: number): [number, string] {
  return [index, id.slice(-REF_CHECK_LENGTH)];
}

export function resolveRef<T>(
  items: readonly T[],
  index: string | undefined,
  check: string | undefined,
  idOf: (item: T) => string,
): T | null {
  if (!index || !/^\d{1,3}$/.test(index) || !check) return null;
  const i = Number(index);
  if (i >= items.length) return null;
  const item = items[i]!;
  return idOf(item).endsWith(check) ? item : null;
}
