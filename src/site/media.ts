import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Everything known about where a release's heavy files live, and how one gets
 * there. `lib/muxer` holds ffmpeg for stages 8 to 10 on the same terms:
 * **operations, never a process.** A caller says "publish this file"; how
 * wrangler spells an upload stays in here, so a bucket rename or a move to the
 * S3 API is one file's problem.
 *
 * It holds media and nothing else. A release's text, the episode's source
 * file and each stage's document, is committed to the repository instead,
 * because it is small; it is worth reading in a diff, and the page quotes it
 * rather than linking it. The split is the point: git keeps what a person
 * reads, R2 keeps what a browser streams.
 */

const run = promisify(execFile);

const BUCKET = "aimator-site-media";
/** A year, immutable: a published file's bytes never change (see `index.ts`). */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  mp4: "video/mp4",
  png: "image/png",
  webm: "video/webm",
};

class MediaError extends Error {
  readonly key: string;

  constructor(key: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MediaError";
    this.key = key;
  }
}

/** The key layout, which the worker reads back as `/media/<version>/<file>`. */
function mediaKey(version: string, file: string): string {
  return `${version}/${file}`;
}

function contentType(file: string): string {
  const extension = file.split(".").pop() ?? "";
  const type = CONTENT_TYPES[extension.toLowerCase()];
  if (!type) {
    throw new MediaError(file, `no content type for .${extension}; add one to media.ts`);
  }
  return type;
}

/**
 * Puts one file in the bucket, declaring how it is to be served.
 *
 * Deliberately unconditional: the caller has already checked the bytes against
 * the sha256 the registry recorded, so re-uploading can only ever write the
 * same file again. Skipping what is already there would need a HEAD, which
 * wrangler does not offer, and the alternative, a second list of what has been
 * published, is the drift rule 7 exists to prevent.
 */
export async function putMedia(version: string, file: string, path: string): Promise<void> {
  const key = mediaKey(version, file);
  try {
    await run("pnpm", [
      "exec",
      "wrangler",
      "r2",
      "object",
      "put",
      `${BUCKET}/${key}`,
      "--remote",
      "--file",
      path,
      "--content-type",
      contentType(file),
      "--cache-control",
      CACHE_CONTROL,
    ]);
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: MediaError carries its cause as the third argument
    throw new MediaError(key, `upload failed: ${(error as Error).message}`, { cause: error });
  }
}
