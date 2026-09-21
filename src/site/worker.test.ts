import { describe, expect, it } from "vitest";
import worker, { type AssetEnv, parseRange, sliceStream } from "./worker.js";

/**
 * The worker, tested through its entry. Two things are worth proving: the
 * arithmetic of a byte range, which is where an off-by-one hides, and that a
 * partial response stops reading the asset once the requested span is out —
 * the whole reason this worker exists rather than letting Static Assets answer.
 */

const CHUNKS = ["0123456789", "abcdefghij", "ABCDEFGHIJ"];
const SIZE = CHUNKS.join("").length;

interface Upstream {
  readonly cancelled: () => boolean;
  /** How many chunks the reader pulled before it was cancelled. */
  readonly read: () => number;
  readonly stream: ReadableStream<Uint8Array>;
}

function upstream(): Upstream {
  const encoder = new TextEncoder();
  let index = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    pull(controller) {
      if (index >= CHUNKS.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(CHUNKS[index] ?? ""));
      index += 1;
    },
  });
  return { cancelled: () => cancelled, read: () => index, stream };
}

function env(response: () => Response, index: Record<string, number> = {}): AssetEnv {
  return {
    ASSETS: {
      fetch(request: Request) {
        if (new URL(request.url).pathname === "/media-index.json") {
          return Promise.resolve(Response.json(index));
        }
        return Promise.resolve(response());
      },
    },
  };
}

const asset = (headers: Record<string, string>) =>
  new Response(upstream().stream, { headers: { "content-type": "video/mp4", ...headers } });

const get = (range?: string) =>
  new Request("https://aimator.auditmos.com/media/0.1.0/gpt-image-mixed.mp4", {
    headers: range ? { range } : {},
  });

describe("parseRange", () => {
  it("should read a span counted from the start", () => {
    expect(parseRange("bytes=5-9", SIZE)).toEqual({ first: 5, last: 9 });
  });

  it("should run an open-ended span to the last byte", () => {
    expect(parseRange("bytes=20-", SIZE)).toEqual({ first: 20, last: SIZE - 1 });
  });

  it("should read a suffix span counted back from the end", () => {
    expect(parseRange("bytes=-10", SIZE)).toEqual({ first: SIZE - 10, last: SIZE - 1 });
  });

  it("should clamp a span that runs past the end of the file", () => {
    expect(parseRange("bytes=25-999", SIZE)).toEqual({ first: 25, last: SIZE - 1 });
  });

  it("should clamp a suffix longer than the file to the whole file", () => {
    expect(parseRange("bytes=-999", SIZE)).toEqual({ first: 0, last: SIZE - 1 });
  });

  it("should refuse a header that names no span at all", () => {
    expect(parseRange("bytes=-", SIZE)).toBeNull();
    expect(parseRange("bytes=abc", SIZE)).toBeNull();
    expect(parseRange("items=0-9", SIZE)).toBeNull();
  });

  it("should refuse a span that starts at or past the end", () => {
    expect(parseRange(`bytes=${SIZE}-`, SIZE)).toBeNull();
    expect(parseRange("bytes=9-5", SIZE)).toBeNull();
  });
});

describe("sliceStream", () => {
  it("should emit exactly the requested bytes", async () => {
    const source = upstream();

    const text = await new Response(sliceStream(source.stream, 8, 14)).text();

    expect(text).toBe("89abcde");
  });

  it("should stop reading the asset once the span is out", async () => {
    const source = upstream();

    await new Response(sliceStream(source.stream, 0, 4)).text();

    // A stream reads one chunk ahead, so the exact count is not the point:
    // the last chunk was never pulled and the asset was let go.
    expect(source.read()).toBeLessThan(CHUNKS.length);
    expect(source.cancelled()).toBe(true);
  });

  it("should fail rather than truncate when the asset ends early", async () => {
    const source = upstream();

    await expect(new Response(sliceStream(source.stream, 0, 999)).text()).rejects.toThrow(
      "Asset ended before the requested byte range."
    );
  });
});

describe("worker", () => {
  it("should answer a range request with 206 and the span it sent", async () => {
    const binding = env(() => asset({ "content-length": String(SIZE) }));

    const response = await worker.fetch(get("bytes=5-9"), binding);

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 5-9/${SIZE}`);
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await response.text()).toBe("56789");
  });

  it("should answer an unsatisfiable range with 416 and the file's size", async () => {
    const binding = env(() => asset({ "content-length": String(SIZE) }));

    const response = await worker.fetch(get("bytes=999-"), binding);

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${SIZE}`);
  });

  it("should send the whole file when nothing was asked for", async () => {
    const binding = env(() => asset({ "content-length": String(SIZE) }));

    const response = await worker.fetch(get(), binding);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(CHUNKS.join(""));
  });

  it("should send the whole file when If-Range does not match the asset", async () => {
    const binding = env(() => asset({ "content-length": String(SIZE), etag: '"v2"' }));
    const request = get("bytes=5-9");
    request.headers.set("if-range", '"v1"');

    const response = await worker.fetch(request, binding);

    expect(response.status).toBe(200);
  });

  it("should send the range when If-Range matches the asset's etag", async () => {
    const binding = env(() => asset({ "content-length": String(SIZE), etag: '"v2"' }));
    const request = get("bytes=5-9");
    request.headers.set("if-range", '"v2"');

    const response = await worker.fetch(request, binding);

    expect(response.status).toBe(206);
  });

  it("should take the size from the generated index when the binding omits it", async () => {
    const binding = env(() => asset({}), {
      "/media/0.1.0/gpt-image-mixed.mp4": SIZE,
    });

    const response = await worker.fetch(get("bytes=5-9"), binding);

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 5-9/${SIZE}`);
  });

  it("should send the whole file when no size can be established", async () => {
    const binding = env(() => asset({}));

    const response = await worker.fetch(get("bytes=5-9"), binding);

    expect(response.status).toBe(200);
  });

  it("should ignore a multi-range request rather than answering half of it", async () => {
    const binding = env(() => asset({ "content-length": String(SIZE) }));

    const response = await worker.fetch(get("bytes=0-4,10-14"), binding);

    expect(response.status).toBe(200);
  });

  it("should pass a failed asset lookup through untouched", async () => {
    const binding = env(() => new Response("not found", { status: 404 }));

    const response = await worker.fetch(get("bytes=0-4"), binding);

    expect(response.status).toBe(404);
  });
});
