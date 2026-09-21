/**
 * The second entry of this module, for the reason `bin.ts` is the package's:
 * `index.ts` decides what gets published, this decides how one published file
 * is served. Neither is an internal of the other.
 *
 * It exists because Cloudflare Static Assets answers a Range request with 200
 * and the whole file, which makes seeking inside a 90-second film download it
 * from the start. This reads the asset as a stream, sends only the requested
 * span and cancels upstream as soon as that span is out — so a viewer who
 * drags the scrubber to 1:15 does not pay for the first 75 seconds.
 */

const RANGE = /^bytes=(\d*)-(\d*)$/;

export interface AssetEnv {
  readonly ASSETS: { readonly fetch: (request: Request) => Promise<Response> };
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

export function sliceStream(
  body: ReadableStream<Uint8Array>,
  first: number,
  last: number
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    cancel(reason) {
      return reader.cancel(reason);
    },
    async pull(controller) {
      try {
        // A chunk that ends before the span begins is read and dropped: this
        // is the cost Static Assets imposes, and the reason moving the media
        // to R2 later would remove the seek penalty entirely.
        let chunk = await reader.read();
        while (!chunk.done && offset + chunk.value.byteLength <= first) {
          offset += chunk.value.byteLength;
          // biome-ignore lint/performance/noAwaitInLoops: the asset is read one chunk at a time, in order
          chunk = await reader.read();
        }
        if (chunk.done) {
          controller.error(new Error("Asset ended before the requested byte range."));
          return;
        }
        const chunkStart = offset;
        offset += chunk.value.byteLength;
        const data = chunk.value.subarray(
          Math.max(0, first - chunkStart),
          Math.min(chunk.value.byteLength, last - chunkStart + 1)
        );
        if (data.byteLength) {
          controller.enqueue(data);
        }
        if (offset > last) {
          controller.close();
          await reader.cancel();
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** The binding may omit Content-Length even when the outer CDN adds it. */
async function assetSize(request: Request, env: AssetEnv, pathname: string): Promise<number> {
  const index = await env.ASSETS.fetch(new Request(new URL("/media-index.json", request.url)));
  if (!index.ok) {
    await index.body?.cancel();
    return 0;
  }
  const sizes = (await index.json()) as Record<string, number>;
  return sizes[pathname] ?? 0;
}

export default {
  async fetch(request: Request, env: AssetEnv): Promise<Response> {
    const original = new Request(request);
    original.headers.delete("range");
    original.headers.delete("if-range");
    const asset = await env.ASSETS.fetch(original);
    if (!asset.ok) {
      return asset;
    }

    const headers = new Headers(asset.headers);
    headers.set("Accept-Ranges", "bytes");
    // A response generated in Worker code carries its own headers; `_headers`
    // only covers what Static Assets serves directly.
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");

    const range = request.headers.get("range");
    const ifRange = request.headers.get("if-range");
    const validatorMatches =
      !ifRange ||
      ifRange === asset.headers.get("etag") ||
      ifRange === asset.headers.get("last-modified");
    let size = Number(asset.headers.get("content-length"));
    if (request.method === "GET" && range && validatorMatches && size <= 0) {
      size = await assetSize(request, env, new URL(request.url).pathname);
    }

    const { body } = asset;
    // Multiple ranges are optional in HTTP; ignore them and send the whole file.
    const servable =
      request.method === "GET" &&
      range !== null &&
      !range.includes(",") &&
      validatorMatches &&
      Number.isSafeInteger(size) &&
      size > 0 &&
      body !== null;
    if (!(servable && range && body)) {
      return new Response(asset.body, { headers, status: asset.status });
    }

    const span = parseRange(range, size);
    if (!span) {
      await body.cancel();
      headers.set("Content-Range", `bytes */${size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { headers, status: 416 });
    }
    headers.set("Content-Range", `bytes ${span.first}-${span.last}/${size}`);
    headers.set("Content-Length", String(span.last - span.first + 1));
    return new Response(sliceStream(body, span.first, span.last), { headers, status: 206 });
  },
};
