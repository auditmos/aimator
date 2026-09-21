/**
 * The second entry of this module, for the reason `bin.ts` is the package's:
 * `index.ts` decides what gets published, this decides how one published file
 * is served. Neither is an internal of the other.
 *
 * `/media/*` is the bucket; everything else is the deployed assets. That split
 * is what the worker exists for, and it is also what made it simpler: when the
 * films were assets, Static Assets answered a Range request with 200 and the
 * whole file, so seeking to 1:15 meant reading and discarding the first 75
 * seconds. R2 takes an offset, so the bytes a viewer asked for are the only
 * ones read.
 *
 * The bucket stays private. Nothing reaches it except through this worker, on
 * the site's own origin — which is also what lets the page keep
 * `default-src 'self'` and what keeps a download link a download.
 */

const RANGE = /^bytes=(\d*)-(\d*)$/;
const MEDIA_PREFIX = "/media/";
/** A published file's bytes never change, so its cache never has to. */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

interface MediaObject {
  readonly httpEtag: string;
  readonly size: number;
  readonly writeHttpMetadata: (headers: Headers) => void;
}

interface MediaBody extends MediaObject {
  readonly body: ReadableStream;
}

export interface AssetEnv {
  readonly ASSETS: { readonly fetch: (request: Request) => Promise<Response> };
  readonly MEDIA: {
    readonly get: (
      key: string,
      options?: { range: { length: number; offset: number } }
    ) => Promise<MediaBody | null>;
    readonly head: (key: string) => Promise<MediaObject | null>;
  };
}

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
  if (first > last || first >= size) {
    return null;
  }
  return { first, last };
}

function mediaHeaders(object: MediaObject): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  // A response generated in worker code carries its own headers; `_headers`
  // only covers what Static Assets serves directly.
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", CACHE_CONTROL);
  return headers;
}

const missing = (body: string | null) => new Response(body, { status: 404 });

async function whole(env: AssetEnv, key: string): Promise<Response> {
  const object = await env.MEDIA.get(key);
  if (!object) {
    return missing("Not found");
  }
  return new Response(object.body, { headers: mediaHeaders(object), status: 200 });
}

async function serveMedia(request: Request, env: AssetEnv, key: string): Promise<Response> {
  if (request.method === "HEAD") {
    const object = await env.MEDIA.head(key);
    if (!object) {
      return missing(null);
    }
    const headers = mediaHeaders(object);
    headers.set("Content-Length", String(object.size));
    return new Response(null, { headers, status: 200 });
  }

  const range = request.headers.get("range");
  // Multiple ranges are optional in HTTP; ignore them and send the whole file.
  const wanted = request.method === "GET" && range && !range.includes(",") ? range : null;
  if (!wanted) {
    return whole(env, key);
  }

  const head = await env.MEDIA.head(key);
  if (!head) {
    return missing("Not found");
  }
  // A validator that no longer matches means the file moved on under a paused
  // player; answering with the whole file is the honest way to resume.
  const ifRange = request.headers.get("if-range");
  if (ifRange && ifRange !== head.httpEtag) {
    return whole(env, key);
  }

  const span = parseRange(wanted, head.size);
  if (!span) {
    const headers = mediaHeaders(head);
    headers.set("Content-Range", `bytes */${head.size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { headers, status: 416 });
  }

  const length = span.last - span.first + 1;
  const object = await env.MEDIA.get(key, { range: { length, offset: span.first } });
  if (!object) {
    return missing("Not found");
  }
  const headers = mediaHeaders(object);
  headers.set("Content-Range", `bytes ${span.first}-${span.last}/${head.size}`);
  headers.set("Content-Length", String(length));
  return new Response(object.body, { headers, status: 206 });
}

export default {
  fetch(request: Request, env: AssetEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(MEDIA_PREFIX)) {
      return serveMedia(request, env, decodeURIComponent(pathname.slice(MEDIA_PREFIX.length)));
    }
    return env.ASSETS.fetch(request);
  },
};
