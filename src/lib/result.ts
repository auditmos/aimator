/**
 * A recoverable outcome. Narrow on `ok` — TypeScript discriminates both
 * branches from that field alone, so no type-guard helpers are needed.
 */
export type Result<T, E = Error> = { ok: true; data: T } | { ok: false; error: E };

export function ok<T>(data: T): Result<T, never> {
  return { data, ok: true };
}

export function err<E = Error>(error: E): Result<never, E> {
  return { error, ok: false };
}
