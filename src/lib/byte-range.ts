/**
 * One HTTP byte range, parsed. Single-file form, and promoted at its second
 * caller for the reason `lib/timeline` was: two modules serve films, the
 * published page from a bucket and the local screen from the workspace, and
 * the arithmetic that turns `bytes=16-47` into an offset and a length is the
 * same arithmetic in both. It is not a formula anybody would want written
 * twice, and the second caller was a certainty rather than a discovery: a clip
 * nobody can seek is a clip somebody has to watch from the beginning in order
 * to approve its twelfth second.
 *
 * What it deliberately does **not** hold is everything around the parse. Where
 * the bytes come from, what an `ETag` means, whether a miss is a 404 or a 416:
 * those differ between a bucket and a file on disk, and a module that decided
 * them would be a process rather than an operation, which is the same line
 * `lib/muxer` draws.
 */

const RANGE = /^bytes=(\d*)-(\d*)$/;

interface ByteRange {
  readonly first: number;
  readonly last: number;
}

/**
 * A single byte range, in both spellings HTTP allows: `bytes=100-` counts from
 * the start, `bytes=-100` counts back from the end. Anything else is `null`,
 * which the caller answers with 416 rather than guessing.
 */
export function parseRange(header: string, size: number): ByteRange | null {
  const match = RANGE.exec(header);

  if (!match) {
    return null;
  }

  const [, from = "", to = ""] = match;

  if (!(from || to)) {
    return null;
  }

  const first = from ? Number(from) : Math.max(0, size - Number(to));
  const last = from && to ? Math.min(Number(to), size - 1) : size - 1;

  if (!(Number.isSafeInteger(first) && Number.isSafeInteger(last))) {
    return null;
  }

  return first > last || first >= size ? null : { first, last };
}
