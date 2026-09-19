import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mp4, png } from "../../test/fixture.js";
import { sha256Of } from "../artifact/index.js";
import { attach } from "../image-model/index.js";
import { clipDuration, runVideoStage, validateVideo } from "./index.js";

const FRAME = { aspectRatio: "16:9", seconds: 14 };

function reason(result: { error?: Error; ok: boolean }): string {
  return result.ok ? "" : (result.error?.message ?? "");
}

describe("validateVideo", () => {
  it("should accept a clip in the episode's ratio and the planned duration", () => {
    const result = validateVideo(mp4({ height: 1080, seconds: 14, width: 1920 }), FRAME);

    expect(result.ok ? result.data : null).toEqual({
      bytes: expect.any(Number),
      height: 1080,
      seconds: 14,
      width: 1920,
    });
  });

  it("should refuse an answer that is not an MP4 at all", () => {
    const result = validateVideo(Buffer.from("<html>nope</html>"), FRAME);

    expect(reason(result)).toContain("MP4");
  });

  it("should refuse a clip whose duration is not the one the plan bought", () => {
    const result = validateVideo(mp4({ height: 1080, seconds: 20, width: 1920 }), FRAME);

    expect(reason(result)).toContain("20");
    expect(reason(result)).toContain("14");
  });

  /** A frame is never rounded to the ratio: the frame decided the ratio. */
  it("should refuse a clip drawn in another ratio than the episode's", () => {
    const result = validateVideo(mp4({ height: 1080, seconds: 14, width: 1080 }), FRAME);

    expect(reason(result)).toContain("16:9");
  });

  /** Last-frame rounding is a fraction of a second; a whole second is not. */
  it("should tolerate the fraction of a second a frame rate leaves over", () => {
    expect(validateVideo(mp4({ height: 1080, seconds: 13.96, width: 1920 }), FRAME).ok).toBe(true);
  });

  it("should read the picture from the video track, not from a silent one", () => {
    const result = validateVideo(
      mp4({ audio: true, height: 1080, seconds: 14, width: 1920 }),
      FRAME
    );

    expect(result.ok ? result.data.width : null).toBe(1920);
  });
});

describe("clipDuration", () => {
  it("should accept a whole number of seconds the model renders", () => {
    expect(clipDuration(14).ok).toBe(true);
    expect(clipDuration(4).ok).toBe(true);
    expect(clipDuration(30).ok).toBe(true);
  });

  /**
   * The shot list may plan any length up to `maxClipSeconds`, and the provider
   * renders a narrower range. Refused rather than rounded, exactly as a frame
   * in a ratio no track renders is refused: the plan is a stored decision and
   * the tool does not get to change the film's timing on its own.
   */
  it("should refuse a clip shorter or longer than the model renders", () => {
    expect(reason(clipDuration(3))).toContain("4");
    expect(reason(clipDuration(31))).toContain("30");
  });

  it("should name the remedy, which is upstream in the shot list", () => {
    expect(reason(clipDuration(45))).toContain("maxClipSeconds");
  });
});

/**
 * One billed video job, end to end, through the module entry.
 *
 * What is asserted here is the order of operations around the POST, because
 * that order *is* the contract of a billed call: the job id reaches disk as
 * soon as it exists, nothing is retried on its own, a finished job is never
 * bought twice, and an answer that cannot be published keeps its archive so
 * fixing the tool costs nothing.
 */
describe("runVideoStage", () => {
  const CLIP = mp4({ height: 1080, seconds: 14, width: 1920 });
  const END = png(1920, 1080);
  const FIRST = png(2816, 1584);

  let dir = "";

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dir = await mkdtemp(join(tmpdir(), "aimator-video-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { force: true, recursive: true });
  });

  interface Provider {
    readonly calls: { body: unknown; method: string; url: string }[];
    readonly fetch: typeof fetch;
  }

  /**
   * A ModelArk that answers correctly, counting every request it receives, and
   * remembering each job it started. Per job rather than per instance, because
   * the difference matters: a job the provider abandoned keeps saying so, which
   * is exactly what a later run has to discover before it starts another.
   *
   * An id this instance never issued is treated as a job that finished while
   * nobody was watching — which is what a resumed attempt actually meets.
   */
  function provider(
    options: { endFrame?: boolean; fail?: boolean; polls?: number } = {}
  ): Provider {
    const { endFrame = true, fail = false, polls = 1 } = options;
    const calls: { body: unknown; method: string; url: string }[] = [];
    const failed = new Set<string>();
    const seen = new Map<string, number>();
    let jobs = 0;

    const impl = ((url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;

      calls.push({ body, method, url: href });

      if (href === "https://download/video") {
        return Promise.resolve(new Response(CLIP, { status: 200 }));
      }

      if (href === "https://download/frame") {
        return Promise.resolve(new Response(END, { status: 200 }));
      }

      if (method === "POST") {
        jobs += 1;
        const id = `cgt-${jobs}`;

        if (fail && jobs === 1) {
          failed.add(id);
        }

        return Promise.resolve(Response.json({ id }));
      }

      const id = href.slice(href.lastIndexOf("/") + 1);

      if (failed.has(id)) {
        return Promise.resolve(
          Response.json({
            error: { code: "InternalError", message: "model odmówił" },
            id,
            status: "failed",
          })
        );
      }

      const asked = (seen.get(id) ?? 0) + 1;
      seen.set(id, asked);

      return Promise.resolve(
        Response.json(
          asked < polls
            ? { id, status: "running" }
            : {
                content: {
                  video_url: "https://download/video",
                  ...(endFrame ? { last_frame_url: "https://download/frame" } : {}),
                },
                id,
                status: "succeeded",
              }
        )
      );
    }) as unknown as typeof fetch;

    return { calls, fetch: impl };
  }

  /**
   * A wait that does not wait, and — when the job is one this test means to
   * abandon — moves the clock instead, so the module's own thirty-minute
   * patience is what ends the loop rather than a knob added for a test.
   */
  function waiting(impatient: boolean): (ms: number) => Promise<void> {
    let now = Date.now();

    return (ms: number) => {
      if (impatient) {
        now += ms * 200;
        vi.setSystemTime(now);
      }

      return Promise.resolve();
    };
  }

  function run(
    fetchImpl: typeof fetch,
    overrides: { impatient?: boolean; regenerate?: boolean; seconds?: number } = {}
  ) {
    return runVideoStage(
      {
        apiKey: "ark-test-key",
        fetch: fetchImpl,
        model: "dreamina-seedance-2-5-260628",
        regenerate: overrides.regenerate ?? false,
        runs: join(dir, "runs"),
        wait: waiting(overrides.impatient ?? false),
        workspace: { root: dir },
      },
      {
        aspectRatio: "16:9",
        blocked: (problems) => new Error(problems.join("; ")),
        endFrameTarget: join(dir, "frames", "C01", "end.png"),
        firstFrame: attach("opening-frame", FIRST),
        inputs: [{ path: "projects/demo/gpt-image/opening-frame.png", sha256: sha256Of(FIRST) }],
        key: "C01",
        prompt: "Ewa siada przy stole.",
        promptVersion: 1,
        seconds: overrides.seconds ?? 14,
        stage: "clips",
        stagePath: join(dir, "clips.stage.json"),
        target: join(dir, "clips", "C01.mp4"),
      }
    );
  }

  async function record(): Promise<Record<string, unknown>> {
    const stage = JSON.parse(await readFile(join(dir, "clips.stage.json"), "utf8")) as {
      artifacts: Record<string, Record<string, unknown> | undefined>;
    };

    return stage.artifacts.C01 ?? {};
  }

  it("should publish the clip and the end frame it will be continued from", async () => {
    const api = provider();
    const result = await run(api.fetch);

    expect(result.ok ? result.data.state : reason(result)).toBe("published");
    expect((await readFile(join(dir, "clips", "C01.mp4"))).equals(CLIP)).toBe(true);
    expect((await readFile(join(dir, "frames", "C01", "end.png"))).equals(END)).toBe(true);
  });

  it("should record both files as outputs of the one attempt that bought them", async () => {
    await run(provider().fetch);

    const outputs = (await record()).outputs as { path: string }[];

    expect(outputs.map((one) => one.path)).toEqual(["clips/C01.mp4", "frames/C01/end.png"]);
  });

  /** `jobId` is what makes a resume free, so it lands as soon as it exists. */
  it("should record the provider's job id", async () => {
    await run(provider().fetch);

    expect((await record()).jobId).toBe("cgt-1");
    expect((await record()).status).toBe("completed");
  });

  it("should submit once and then poll until the job succeeds", async () => {
    const api = provider({ polls: 3 });
    await run(api.fetch);

    const posts = api.calls.filter((call) => call.method === "POST");
    const polls = api.calls.filter((call) => call.method === "GET" && call.url.includes("/tasks/"));

    expect(posts).toHaveLength(1);
    expect(polls).toHaveLength(3);
  });

  it("should send one image, as the clip's first frame, and ask for the last one back", async () => {
    const api = provider();
    await run(api.fetch);

    const [post] = api.calls.filter((call) => call.method === "POST");
    const body = post?.body as {
      content: { role?: string; type: string }[];
      duration: number;
      generate_audio: boolean;
      ratio: string;
      return_last_frame: boolean;
    };
    const images = body.content.filter((item) => item.type === "image_url");

    expect(images).toHaveLength(1);
    expect(images[0]?.role).toBe("first_frame");
    expect(body.ratio).toBe("adaptive");
    expect(body.duration).toBe(14);
    expect(body.generate_audio).toBe(false);
    expect(body.return_last_frame).toBe(true);
  });

  /** The invariant: a run archive references its inputs, never copies them. */
  it("should archive the request without the first frame's bytes", async () => {
    await run(provider().fetch);

    const runId = (await record()).runId as string;
    const request = await readFile(join(dir, "runs", runId, "request.json"), "utf8");

    expect(request).toContain(sha256Of(FIRST));
    expect(request).not.toContain(FIRST.toString("base64"));
  });

  it("should finish a submitted job by polling it, without a second charge", async () => {
    const first = provider({ polls: Number.POSITIVE_INFINITY });
    const abandoned = await run(first.fetch, { impatient: true });

    expect(reason(abandoned)).toContain("powtórz to samo polecenie");
    expect((await record()).status).toBe("submitted");
    expect((await record()).jobId).toBe("cgt-1");

    const second = provider();
    const resumed = await run(second.fetch);

    expect(resumed.ok ? resumed.data.state : reason(resumed)).toBe("resumed");
    expect(second.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  /**
   * A job the provider reported as failed was not rendered and not billed, so
   * starting over is safe and needs no `--regenerate` — demanding one would
   * make a refusal look like a purchase.
   */
  it("should let a failed job be tried again without --regenerate", async () => {
    const api = provider({ fail: true });
    const failed = await run(api.fetch);

    expect(reason(failed)).toContain("model odmówił");

    const again = await run(api.fetch);

    expect(again.ok ? again.data.state : reason(again)).toBe("published");
    // One job per run: the abandoned one was asked after, not resumed, and the
    // second run started exactly one replacement rather than a second charge.
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(2);
  });

  /**
   * The clip is paid for by the time it is judged, so a verdict that refuses it
   * must leave the record resumable: the archive keeps the bytes and fixing the
   * validator costs nothing.
   */
  it("should keep a clip of the wrong length out of the workspace and keep its archive", async () => {
    const result = await run(provider().fetch, { seconds: 8 });

    expect(reason(result)).toContain("14");
    expect((await record()).status).toBe("submitted");

    const runId = (await record()).runId as string;
    expect((await readFile(join(dir, "runs", runId, "original.mp4"))).equals(CLIP)).toBe(true);
  });

  /** The one promise this module never delegates upward: nothing is billed twice. */
  it("should refuse to buy a clip it has already published", async () => {
    const api = provider();
    await run(api.fetch);

    const again = await run(api.fetch);

    expect(reason(again)).toContain("--regenerate");
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("should publish a clip whose provider returned no end frame, and say so", async () => {
    const result = await run(provider({ endFrame: false }).fetch);

    expect(result.ok ? result.data.note : reason(result)).toContain("końcówk");
    expect(result.ok ? result.data.endFrame : null).toBe(false);

    const outputs = (await record()).outputs as { path: string }[];
    expect(outputs.map((one) => one.path)).toEqual(["clips/C01.mp4"]);
  });
});
