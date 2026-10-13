import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mp4, png, wav } from "../../test/fixture.js";
import { sha256Of } from "../artifact/index.js";
import { attach } from "../image-model/index.js";
import type { ConcatReport, Muxer } from "../muxer.js";
import { err, ok, type Result } from "../result.js";
import { identifyFaces, runLipSync, runVideoStage } from "./index.js";

/**
 * Kling Lip Sync, the second kind of job this module buys, through the entry.
 *
 * Assumptions this file pins:
 * - Faces are found once, by a paid synchronous call that is handed the clip
 *   either by the id Kling gave it, when Kling rendered it less than thirty
 *   days ago, or by a signed URL from the private bucket (`lib/hosting`).
 * - That call is the only one that ever sees the video: the job afterwards is
 *   addressed by `session_id` alone, and binding a face to a character is a
 *   person's decision taken between the two, which can outlast a signed URL.
 *   So the lent object is taken back when the face call ends, whichever way it
 *   ends, rather than when the lip-sync job does.
 * - A job carries one face and one sound, and follows the order of operations
 *   a clip does: receipt before the first poll, resumed by asking, published
 *   only past a verdict that holds it to the input's frame and length.
 * - Time is injected where the thirty days are measured, and the network is a
 *   fake that answers as Kling's and R2's documentation say they do.
 */

const CLIP = mp4({ height: 1080, seconds: 14, width: 1920 });
const FIRST = png(1920, 1080);
const DAY = 24 * 60 * 60 * 1000;
const HOSTING = {
  AIMATOR_LIPSYNC_BUCKET: "aimator-lipsync",
  R2_ACCESS_KEY_ID: "access-id",
  R2_ACCOUNT_ID: "acc123",
  R2_SECRET_ACCESS_KEY: "secret",
};

interface Sent {
  readonly body: unknown;
  readonly method: string;
  readonly url: URL;
}

interface Network {
  readonly fetch: typeof fetch;
  readonly sent: Sent[];
}

/**
 * Kling and the private bucket, answering the way their documentation says.
 * Image-to-video is here too, because the clip whose id a face call sends has
 * to have been rendered by Kling through the real stage first.
 */
function network(options: { readonly faces?: "refused" } = {}): Network {
  const sent: Sent[] = [];

  const impl = ((url: string | URL, init?: RequestInit) => {
    const href = new URL(String(url));
    const method = init?.method ?? "GET";

    sent.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      method,
      url: href,
    });

    if (href.hostname.endsWith("r2.cloudflarestorage.com")) {
      return Promise.resolve(new Response(null, { status: method === "DELETE" ? 204 : 200 }));
    }

    if (href.href === "https://download/video") {
      return Promise.resolve(new Response(CLIP, { status: 200 }));
    }

    if (href.pathname === "/v1/videos/identify-face" && options.faces === "refused") {
      return Promise.resolve(
        Response.json({ code: 1201, data: null, message: "video content check failed" })
      );
    }

    if (href.pathname === "/v1/videos/identify-face") {
      return Promise.resolve(
        Response.json({
          code: 0,
          data: {
            face_data: [
              { end_time: 9000, face_id: "0", face_image: "https://faces/0.png", start_time: 0 },
            ],
            session_id: "session-1",
          },
          message: "SUCCEED",
        })
      );
    }

    if (method === "POST") {
      return Promise.resolve(Response.json({ code: 0, data: { id: "kt-1", status: "submitted" } }));
    }

    return Promise.resolve(
      Response.json({
        code: 0,
        data: [
          {
            id: "kt-1",
            outputs: [
              { duration: "14", id: "vid-kt-1", type: "video", url: "https://download/video" },
            ],
            status: "succeeded",
          },
        ],
      })
    );
  }) as unknown as typeof fetch;

  return { fetch: impl, sent };
}

/** ffmpeg at its boundary: asked for the last frame, it writes one. */
const mux: Muxer = {
  concat: (): Promise<Result<ConcatReport>> => Promise.resolve(err(new Error("nieużywane"))),
  lastFrame: async (input) => {
    await mkdir(dirname(input.target), { recursive: true });
    await writeFile(input.target, FIRST);

    return ok({ argv: ["ffmpeg"], engine: "ffmpeg 9.0.2", stderr: "" });
  },
  master: () => Promise.resolve(err(new Error("nieużywane"))),
  mix: () => Promise.resolve(err(new Error("nieużywane"))),
  version: () => Promise.resolve(ok("ffmpeg 9.0.2")),
};

function reason(result: { error?: Error; ok: boolean }): string {
  return result.ok ? "" : (result.error?.message ?? "");
}

describe("identifyFaces", () => {
  let dir = "";

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dir = await mkdtemp(join(tmpdir(), "aimator-faces-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { force: true, recursive: true });
  });

  /** A clip rendered by Kling through stage 7's own lifecycle, and its record. */
  async function renderedByKling(api: Network) {
    const rendered = await runVideoStage(
      {
        apiKey: "kling-key",
        fetch: api.fetch,
        model: "kling-3.0",
        mux,
        regenerate: false,
        runs: join(dir, "runs"),
        wait: () => Promise.resolve(),
        workspace: { root: dir },
      },
      {
        aspectRatio: "16:9",
        blocked: (problems) => new Error(problems.join("; ")),
        endFrameTarget: () => ok(join(dir, "frames", "C01", "end.png")),
        firstFrame: attach("opening-frame", FIRST),
        inputs: [{ path: "opening-frame.png", sha256: sha256Of(FIRST) }],
        key: "C01",
        prompt: "Ewa siada przy stole.",
        promptVersion: 1,
        seconds: 14,
        stage: "clips",
        stagePath: join(dir, "clips.stage.json"),
        target: join(dir, "clips", "C01.mp4"),
      }
    );

    if (!rendered.ok) {
      throw rendered.error;
    }

    const record = rendered.data.stage.artifacts.C01;

    if (record === undefined) {
      throw new Error("brak rekordu C01");
    }

    return record;
  }

  function identify(
    api: Network,
    record: { producer: { model: string | null }; runId: string },
    now = Date.now()
  ) {
    return identifyFaces(
      {
        apiKey: "kling-key",
        fetch: api.fetch,
        hosting: HOSTING,
        now: () => new Date(now),
        runs: join(dir, "runs"),
        workspace: { root: dir },
      },
      {
        blocked: (problems) => new Error(problems.join("; ")),
        path: join(dir, "clips", "C01.mp4"),
        record,
      }
    );
  }

  function faceCalls(api: Network): Sent[] {
    return api.sent.filter((one) => one.url.pathname === "/v1/videos/identify-face");
  }

  it("should hand Kling its own id for a clip it rendered this month", async () => {
    const api = network();
    const record = await renderedByKling(api);
    const found = await identify(api, record, Date.now() + DAY);

    expect(found.ok ? found.data.sessionId : reason(found)).toBe("session-1");
    expect(faceCalls(api).map((one) => one.body)).toEqual([{ video_id: "vid-kt-1" }]);
    expect(bucketCalls(api)).toEqual([]);
  });

  function bucketCalls(api: Network): string[] {
    return api.sent
      .filter((one) => one.url.hostname.endsWith("r2.cloudflarestorage.com"))
      .map((one) => one.method);
  }

  /** A clip Seedance rendered, on disk where stage 7 publishes one. */
  async function renderedBySeedance(clip = CLIP) {
    await mkdir(join(dir, "clips"), { recursive: true });
    await writeFile(join(dir, "clips", "C01.mp4"), clip);

    return {
      producer: { model: "dreamina-seedance-2-5-260628" },
      runId: "20261001T120000Z-abcd1234",
    };
  }

  it("should lend a Seedance clip from the bucket and send its signed address", async () => {
    const api = network();
    const found = await identify(api, await renderedBySeedance());
    const [put] = api.sent.filter((one) => one.method === "PUT");
    const [face] = faceCalls(api);
    const sentUrl = new URL((face?.body as { video_url?: string } | undefined)?.video_url ?? "");

    expect(found.ok ? found.data.source : reason(found)).toBe("video_url");
    expect(sentUrl.origin + sentUrl.pathname).toBe(
      `${put?.url.origin ?? ""}${put?.url.pathname ?? ""}`
    );
    expect(sentUrl.searchParams.get("X-Amz-Signature")).not.toBeNull();
  });

  it("should lend a clip Kling rendered more than thirty days ago", async () => {
    const api = network();
    const record = await renderedByKling(api);
    const found = await identify(api, record, Date.now() + 31 * DAY);

    expect(found.ok ? found.data.source : reason(found)).toBe("video_url");
    expect(Object.keys((faceCalls(api)[0]?.body ?? {}) as object)).toEqual(["video_url"]);
  });

  /**
   * The lent clip is taken back when the face call ends, whichever way it ends:
   * the job after it is addressed by the session alone, so nothing fetches the
   * clip again, and a call Kling turned down needs it no more than one it took.
   */
  it("should take the lent clip back after faces were found", async () => {
    const api = network();
    await identify(api, await renderedBySeedance());

    expect(bucketCalls(api)).toEqual(["PUT", "DELETE"]);
  });

  it("should take the lent clip back after Kling turned the call down", async () => {
    const api = network({ faces: "refused" });
    const found = await identify(api, await renderedBySeedance());

    expect(reason(found)).toContain("video content check failed");
    expect(bucketCalls(api)).toEqual(["PUT", "DELETE"]);
  });

  /** Kling's own limits, judged here, because the call that would find out is paid. */
  it.each([
    ["61 s", mp4({ height: 1080, seconds: 61, width: 1920 }), "61"],
    ["2200 px", mp4({ height: 1238, seconds: 14, width: 2200 }), "2200"],
  ])("should refuse a %s clip before anything is sent", async (_, clip, number) => {
    const api = network();
    const found = await identify(api, await renderedBySeedance(clip));

    expect(reason(found)).toContain(number);
    expect(api.sent).toEqual([]);
  });
});

describe("runLipSync", () => {
  const SPEECH = wav({ fill: 0x11, seconds: 2 });
  const FACE = { end: 9000, id: "0", start: 0 };
  const ENDPOINT = "https://api-singapore.klingai.com/v1/videos/advanced-lip-sync";

  let dir = "";

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dir = await mkdtemp(join(tmpdir(), "aimator-lip-sync-"));
    await mkdir(join(dir, "clips"), { recursive: true });
    await writeFile(join(dir, "clips", "C01.mp4"), CLIP);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { force: true, recursive: true });
  });

  interface Kling {
    readonly fetch: typeof fetch;
    /** The task id the stage file held at the moment of each poll. */
    readonly receipts: (string | null)[];
    readonly sent: Sent[];
  }

  /**
   * Kling's lip-sync, as documented: `data.task_id` from the POST, the task at
   * its own path, `succeed` with the result among `task_result.videos`.
   */
  function kling(
    options: { readonly polls?: number; readonly result?: Buffer; readonly status?: string } = {}
  ): Kling {
    const { polls = 1, result = CLIP, status = "succeed" } = options;
    const sent: Sent[] = [];
    const receipts: (string | null)[] = [];
    let asked = 0;

    const impl = (async (url: string | URL, init?: RequestInit) => {
      const href = new URL(String(url));
      const method = init?.method ?? "GET";

      sent.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        method,
        url: href,
      });

      if (href.href === "https://download/lip-synced") {
        return new Response(result, { status: 200 });
      }

      if (method === "POST") {
        return Response.json({ code: 0, data: { task_id: "ls-1", task_status: "submitted" } });
      }

      asked += 1;
      receipts.push(await jobId());

      return Response.json({
        code: 0,
        data:
          asked < polls
            ? { task_id: "ls-1", task_status: "processing" }
            : {
                task_id: "ls-1",
                task_result: {
                  videos: [{ duration: "14", id: "lsv-1", url: "https://download/lip-synced" }],
                },
                task_status: status,
                task_status_msg: status === "failed" ? "twarz zasłonięta" : "",
              },
      });
    }) as unknown as typeof fetch;

    return { fetch: impl, receipts, sent };
  }

  async function jobId(): Promise<string | null> {
    const stage = JSON.parse(await readFile(join(dir, "versions.stage.json"), "utf8")) as {
      artifacts: Record<string, { jobId: string | null } | undefined>;
    };

    return stage.artifacts.C01?.jobId ?? null;
  }

  function lipSync(
    api: Kling,
    overrides: { face?: typeof FACE; impatient?: boolean; start?: number } = {}
  ) {
    let now = Date.now();

    return runLipSync(
      {
        apiKey: "kling-key",
        fetch: api.fetch,
        regenerate: false,
        runs: join(dir, "runs"),
        wait: (ms) => {
          if (overrides.impatient === true) {
            now += ms * 200;
            vi.setSystemTime(now);
          }

          return Promise.resolve();
        },
        workspace: { root: dir },
      },
      {
        blocked: (problems) => new Error(problems.join("; ")),
        clip: join(dir, "clips", "C01.mp4"),
        face: overrides.face ?? FACE,
        inputs: [{ path: "clips/C01.mp4", sha256: sha256Of(CLIP) }],
        key: "C01",
        sessionId: "session-1",
        speech: { seconds: 2, start: overrides.start ?? 1, wav: SPEECH },
        stage: "clips",
        stagePath: join(dir, "versions.stage.json"),
        target: join(dir, "versions", "clips", "C01.mp4"),
      }
    );
  }

  function posts(api: Kling): Sent[] {
    return api.sent.filter((one) => one.method === "POST");
  }

  it("should move one face to one sound and publish what came back", async () => {
    const api = kling();
    const result = await lipSync(api);

    expect(result.ok ? result.data.state : reason(result)).toBe("published");
    expect(posts(api).map((one) => one.url.href)).toEqual([ENDPOINT]);
    expect(posts(api)[0]?.body).toEqual({
      face_choose: [
        {
          face_id: "0",
          sound_end_time: 2000,
          sound_file: SPEECH.toString("base64"),
          sound_insert_time: 1000,
          sound_start_time: 0,
        },
      ],
      session_id: "session-1",
      watermark_info: { enabled: false },
    });
    expect((await readFile(join(dir, "versions", "clips", "C01.mp4"))).equals(CLIP)).toBe(true);
  });

  /** The receipt is on disk before Kling is asked anything about the job. */
  it("should record the task id before the first poll", async () => {
    const api = kling({ polls: 2 });
    await lipSync(api);

    expect(api.receipts).toEqual(["ls-1", "ls-1"]);
  });

  it("should finish an interrupted job by asking after it, without a second POST", async () => {
    const abandoned = await lipSync(kling({ polls: Number.POSITIVE_INFINITY }), {
      impatient: true,
    });

    expect(reason(abandoned)).toContain("powtórz to samo polecenie");

    const second = kling();
    const resumed = await lipSync(second);

    expect(resumed.ok ? resumed.data.state : reason(resumed)).toBe("resumed");
    expect(posts(second)).toEqual([]);
    expect(second.sent.map((one) => one.url.href)).toContain(`${ENDPOINT}/ls-1`);
  });

  /**
   * Kling refuses a sound whose window shares less than two seconds with the
   * face, so this does too, before anything is sent: the numbers say which
   * line to move, and nobody pays for learning it.
   */
  it("should refuse a window that shares only 1.5 s with the face", async () => {
    const api = kling();
    const result = await lipSync(api, { face: { end: 2500, id: "0", start: 0 } });

    expect(reason(result)).toContain("1.5");
    expect(api.sent).toEqual([]);
  });

  /** A result that is not the input clip's frame is not the input clip lip-synced. */
  it("should not publish a result whose frame differs from the input's", async () => {
    const api = kling({ result: mp4({ height: 720, seconds: 14, width: 1280 }) });
    const result = await lipSync(api);

    expect(reason(result)).toContain("1280x720");
    expect(await jobId()).toBe("ls-1");
    await expect(readFile(join(dir, "versions", "clips", "C01.mp4"))).rejects.toThrow();
  });

  it("should give Kling's own reason for a failed job and publish nothing", async () => {
    const result = await lipSync(kling({ status: "failed" }));

    expect(reason(result)).toContain("twarz zasłonięta");
    await expect(readFile(join(dir, "versions", "clips", "C01.mp4"))).rejects.toThrow();
  });
});
