import { describe, expect, it } from "vitest";
import worker, { type AssetEnv } from "./worker.js";

/**
 * The worker, tested through its entry. What is worth proving here is that a
 * partial response asks the bucket for exactly the span it was sent, which is
 * the whole reason the films moved out of the deployed assets. The arithmetic
 * of the range itself belongs to `lib/byte-range` and is tested beside it.
 */

const BODY = "0123456789abcdefghijABCDEFGHIJ";
const SIZE = BODY.length;
const KEY = "0.1.0/gpt-image-mixed.mp4";
const ETAG = '"a1b2c3"';

interface Bucket {
  /** Every range the bucket was asked for, in order. */
  readonly asked: { length: number; offset: number }[];
  readonly env: AssetEnv;
}

function bucket(objects: Record<string, string> = { [KEY]: BODY }): Bucket {
  const asked: { length: number; offset: number }[] = [];
  const object = (key: string, text: string) => ({
    body: new Response(text).body as ReadableStream,
    httpEtag: ETAG,
    size: objects[key]?.length ?? text.length,
    writeHttpMetadata(headers: Headers) {
      headers.set("Content-Type", "video/mp4");
    },
  });
  return {
    asked,
    env: {
      ASSETS: {
        fetch: () => Promise.resolve(new Response("the page", { status: 200 })),
      },
      MEDIA: {
        get(key, options) {
          const text = objects[key];
          if (text === undefined) {
            return Promise.resolve(null);
          }
          if (!options) {
            return Promise.resolve(object(key, text));
          }
          asked.push(options.range);
          const { length, offset } = options.range;
          return Promise.resolve(object(key, text.slice(offset, offset + length)));
        },
        head(key) {
          const text = objects[key];
          return Promise.resolve(
            text === undefined
              ? null
              : {
                  httpEtag: ETAG,
                  size: text.length,
                  writeHttpMetadata(headers: Headers) {
                    headers.set("Content-Type", "video/mp4");
                  },
                }
          );
        },
      },
    },
  };
}

const media = (range?: string, method = "GET") =>
  new Request(`https://aimator.auditmos.com/media/${KEY}`, {
    headers: range ? { range } : {},
    method,
  });

describe("worker", () => {
  it("should answer a range request with 206 and only the bytes it asked for", async () => {
    const { asked, env } = bucket();

    const response = await worker.fetch(media("bytes=5-9"), env);

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 5-9/${SIZE}`);
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await response.text()).toBe("56789");
    // The point of the bucket: nothing before byte 5 was ever read.
    expect(asked).toEqual([{ length: 5, offset: 5 }]);
  });

  it("should ask the bucket for a suffix span by its real offset", async () => {
    const { asked, env } = bucket();

    await worker.fetch(media("bytes=-10"), env);

    expect(asked).toEqual([{ length: 10, offset: SIZE - 10 }]);
  });

  it("should answer an unsatisfiable range with 416 and the file's size", async () => {
    const { asked, env } = bucket();

    const response = await worker.fetch(media("bytes=999-"), env);

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${SIZE}`);
    expect(asked).toEqual([]);
  });

  it("should send the whole file when nothing was asked for", async () => {
    const { asked, env } = bucket();

    const response = await worker.fetch(media(), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY);
    expect(asked).toEqual([]);
  });

  it("should carry the object's own type and an immutable cache", async () => {
    const { env } = bucket();

    const response = await worker.fetch(media(), env);

    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("ETag")).toBe(ETAG);
  });

  it("should answer HEAD with the size and no body", async () => {
    const { env } = bucket();

    const response = await worker.fetch(media(undefined, "HEAD"), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(SIZE));
    expect(response.body).toBeNull();
  });

  it("should send the whole file when If-Range does not match the object", async () => {
    const { asked, env } = bucket();
    const request = media("bytes=5-9");
    request.headers.set("if-range", '"stale"');

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(asked).toEqual([]);
  });

  it("should send the range when If-Range matches the object", async () => {
    const { env } = bucket();
    const request = media("bytes=5-9");
    request.headers.set("if-range", ETAG);

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(206);
  });

  it("should ignore a multi-range request rather than answering half of it", async () => {
    const { asked, env } = bucket();

    const response = await worker.fetch(media("bytes=0-4,10-14"), env);

    expect(response.status).toBe(200);
    expect(asked).toEqual([]);
  });

  it("should answer 404 for a key the bucket does not hold", async () => {
    const { env } = bucket({});

    expect((await worker.fetch(media(), env)).status).toBe(404);
    expect((await worker.fetch(media("bytes=0-4"), env)).status).toBe(404);
    expect((await worker.fetch(media(undefined, "HEAD"), env)).status).toBe(404);
  });

  it("should leave every other path to the deployed assets", async () => {
    const { env } = bucket();

    const response = await worker.fetch(new Request("https://aimator.auditmos.com/"), env);

    expect(await response.text()).toBe("the page");
  });
});
