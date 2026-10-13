import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jpeg, mp4, png } from "../../test/fixture.js";
import { sha256Of } from "../artifact/index.js";
import { attach } from "../image-model/index.js";
import type { ConcatReport, Muxer } from "../muxer.js";
import { err, ok, type Result } from "../result.js";
import { clipDuration, runVideoStage, validateEndFrame, validateVideo } from "./index.js";

const FRAME = { aspectRatio: "16:9", seconds: 14 };

function reason(result: { error?: Error; ok: boolean }): string {
  return result.ok ? "" : (result.error?.message ?? "");
}

describe("validateVideo", () => {
  it("should accept a clip in the episode's ratio and the planned duration", () => {
    const result = validateVideo(mp4({ height: 1080, seconds: 14, width: 1920 }), FRAME);

    expect(result.ok ? result.data : null).toEqual({
      bytes: expect.any(Number),
      codec: "hvc1",
      frameRate: 24,
      height: 1080,
      seconds: 14,
      width: 1920,
    });
  });

  /**
   * What a stream copy needs to agree on, read from the picture's own sample
   * tables: 30000/1001 is how a camera spells 29.97, and the format is the
   * sample entry's four letters.
   */
  it("should read the picture's frame rate and codec from its sample tables", () => {
    const result = validateVideo(
      mp4({
        audio: true,
        codec: "avc1",
        fps: 30_000 / 1001,
        height: 1080,
        seconds: 14,
        width: 1920,
      }),
      FRAME
    );

    expect(result.ok ? [result.data.frameRate, result.data.codec] : reason(result)).toEqual([
      29.97,
      "avc1",
    ]);
  });

  /** A header without sample tables still has a length and a frame; it has no rate to compare. */
  it("should report no frame rate and no codec where the sample tables are missing", () => {
    const result = validateVideo(mp4({ fps: null, height: 1080, seconds: 14, width: 1920 }), FRAME);

    expect(result.ok ? [result.data.frameRate, result.data.codec] : reason(result)).toEqual([
      null,
      null,
    ]);
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

describe("validateEndFrame", () => {
  const CLIP_FRAME = { height: 1080, width: 1920 };

  /** The provider hands back a JPEG, whatever the rest of the pipeline draws in. */
  it("should accept the JPEG the provider actually returns", () => {
    const result = validateEndFrame(jpeg(1920, 1080), CLIP_FRAME);

    expect(result.ok ? result.data.format : reason(result)).toBe("jpeg");
  });

  it("should accept a PNG just as readily", () => {
    const result = validateEndFrame(png(1920, 1080), CLIP_FRAME);

    expect(result.ok ? result.data.format : reason(result)).toBe("png");
  });

  it("should refuse a still that is not the last frame of this clip", () => {
    expect(reason(validateEndFrame(jpeg(1280, 720), CLIP_FRAME))).toContain("1280x720");
  });

  it("should refuse bytes that are neither format", () => {
    expect(reason(validateEndFrame(Buffer.from("not a picture"), CLIP_FRAME))).toContain("JPEG");
  });
});

describe("clipDuration", () => {
  const SEEDANCE = "dreamina-seedance-2-5-260628";
  const KLING = "kling-3.0";

  it("should accept a whole number of seconds the model renders", () => {
    expect(clipDuration(14, SEEDANCE).ok).toBe(true);
    expect(clipDuration(4, SEEDANCE).ok).toBe(true);
    expect(clipDuration(30, SEEDANCE).ok).toBe(true);
  });

  /**
   * The shot list may plan any length up to `maxClipSeconds`, and the provider
   * renders a narrower range. Refused rather than rounded, exactly as a frame
   * in a ratio no track renders is refused: the plan is a stored decision and
   * the tool does not get to change the film's timing on its own.
   */
  it("should refuse a clip shorter or longer than the model renders", () => {
    expect(reason(clipDuration(3, SEEDANCE))).toContain("4");
    expect(reason(clipDuration(31, SEEDANCE))).toContain("30");
  });

  it("should name the remedy, which is upstream in the shot list", () => {
    expect(reason(clipDuration(45, SEEDANCE))).toContain("maxClipSeconds");
  });

  /** Each model has its own range; the shot list is judged against the one chosen. */
  it("should hold Kling to its own three to fifteen seconds", () => {
    expect(clipDuration(3, KLING).ok).toBe(true);
    expect(clipDuration(15, KLING).ok).toBe(true);
    expect(reason(clipDuration(2, KLING))).toContain("3");
    expect(reason(clipDuration(16, KLING))).toContain("15");
  });

  it("should refuse a fraction of a second on either model", () => {
    expect(clipDuration(7.5, KLING).ok).toBe(false);
    expect(clipDuration(7.5, SEEDANCE).ok).toBe(false);
  });

  /**
   * `check` has no model to ask about, so it refuses only a length that no model
   * this module knows would render: three seconds is Kling's, sixteen Seedance's.
   */
  it("should accept, with no model named, what some known model renders", () => {
    expect(clipDuration(3, null).ok).toBe(true);
    expect(clipDuration(16, null).ok).toBe(true);
    expect(reason(clipDuration(2, null))).toContain("maxClipSeconds");
  });

  it("should refuse a model it does not know, naming the ones it does", () => {
    const refused = reason(clipDuration(10, "veo-9"));

    expect(refused).toContain("dreamina-seedance-");
    expect(refused).toContain("kling-3.0");
  });
});

/**
 * One billed video job, end to end, through the module entry.
 *
 * What is asserted here is the order of operations around the POST, because
 * that order *is* the contract of a billed call: the job id reaches disk as
 * soon as it exists; nothing is retried on its own, a finished job is never
 * bought twice, and an answer that cannot be published keeps its archive so
 * fixing the tool costs nothing.
 */
describe("runVideoStage", () => {
  const CLIP = mp4({ height: 1080, seconds: 14, width: 1920 });
  /** What ModelArk actually hands back beside the clip: a JPEG, not a PNG. */
  const END = jpeg(1920, 1080);
  const END_AS_PNG = png(1920, 1080);
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
   * nobody was watching, which is what a resumed attempt actually meets.
   */
  function provider(
    options: { endFrame?: boolean; fail?: boolean; polls?: number; still?: Buffer } = {}
  ): Provider {
    const { endFrame = true, fail = false, polls = 1, still = END } = options;
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
        return Promise.resolve(new Response(still, { status: 200 }));
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
   * A wait that does not wait, and, when the job is one this test means to
   * abandon, moves the clock instead, so the module's own thirty-minute
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

  interface Cutter {
    /** Every clip the muxer was asked to cut a last frame out of. */
    readonly cuts: string[];
    readonly mux: Muxer;
  }

  /**
   * The local engine, faked at its boundary: asked for a last frame, it writes
   * the PNG a real ffmpeg would, in the clip's size. The real one is exercised
   * in `muxer.test.ts`, against a clip it made itself.
   */
  function cutter(options: { absent?: boolean } = {}): Cutter {
    const cuts: string[] = [];
    const refuse = (): Promise<Result<ConcatReport>> =>
      Promise.resolve(err(new Error("etap 7 tylko wycina klatkę")));

    return {
      cuts,
      mux: {
        concat: refuse,
        lastFrame: async (input) => {
          cuts.push(input.video);

          if (options.absent === true) {
            return err(new Error("nie znaleziono ffmpeg, wskaż go przez AIMATOR_FFMPEG"));
          }

          await mkdir(dirname(input.target), { recursive: true });
          await writeFile(input.target, END_AS_PNG);

          return ok({ argv: ["ffmpeg", "-sseof"], engine: "ffmpeg 9.0.2", stderr: "" });
        },
        master: refuse,
        mix: refuse,
        picture: refuse,
        version: () =>
          Promise.resolve(
            options.absent === true ? err(new Error("nie znaleziono ffmpeg")) : ok("ffmpeg 9.0.2")
          ),
      },
    };
  }

  function callOf(fetchImpl: typeof fetch, impatient = false) {
    return {
      apiKey: "ark-test-key",
      fetch: fetchImpl,
      model: "dreamina-seedance-2-5-260628",
      mux: cutter().mux,
      regenerate: false,
      runs: join(dir, "runs"),
      wait: waiting(impatient),
      workspace: { root: dir },
    };
  }

  function artifactOf(seconds = 14) {
    return {
      aspectRatio: "16:9",
      blocked: (problems: readonly string[]) => new Error(problems.join("; ")),
      endFrameTarget: (format: "jpeg" | "png") =>
        ok(join(dir, "frames", "C01", format === "jpeg" ? "end.jpg" : "end.png")),
      firstFrame: attach("opening-frame", FIRST),
      inputs: [{ path: "projects/demo/gpt-image/opening-frame.png", sha256: sha256Of(FIRST) }],
      key: "C01",
      prompt: "Ewa siada przy stole.",
      promptVersion: 1,
      seconds,
      stage: "clips" as const,
      stagePath: join(dir, "clips.stage.json"),
      target: join(dir, "clips", "C01.mp4"),
    };
  }

  function run(
    fetchImpl: typeof fetch,
    overrides: {
      impatient?: boolean;
      model?: string;
      mux?: Muxer;
      regenerate?: boolean;
      seconds?: number;
    } = {}
  ) {
    return runVideoStage(
      {
        apiKey: "ark-test-key",
        fetch: fetchImpl,
        model: overrides.model ?? "dreamina-seedance-2-5-260628",
        mux: overrides.mux ?? cutter().mux,
        regenerate: overrides.regenerate ?? false,
        runs: join(dir, "runs"),
        wait: waiting(overrides.impatient ?? false),
        workspace: { root: dir },
      },
      {
        aspectRatio: "16:9",
        blocked: (problems) => new Error(problems.join("; ")),
        endFrameTarget: (format: "jpeg" | "png") =>
          ok(join(dir, "frames", "C01", format === "jpeg" ? "end.jpg" : "end.png")),
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

  /**
   * The still is published in the format it arrived in, under a name that says
   * so. Re-encoding it would mean approving one picture and attaching another;
   * naming a JPEG `.png` would mean the workspace lying about its own bytes.
   */
  it("should publish the clip and the end frame it will be continued from", async () => {
    const api = provider();
    const result = await run(api.fetch);

    expect(result.ok ? result.data.state : reason(result)).toBe("published");
    expect((await readFile(join(dir, "clips", "C01.mp4"))).equals(CLIP)).toBe(true);
    expect((await readFile(join(dir, "frames", "C01", "end.jpg"))).equals(END)).toBe(true);
  });

  it("should publish a PNG still under its own name instead", async () => {
    await run(provider({ still: END_AS_PNG }).fetch);

    expect((await readFile(join(dir, "frames", "C01", "end.png"))).equals(END_AS_PNG)).toBe(true);
  });

  it("should record both files as outputs of the one attempt that bought them", async () => {
    await run(provider().fetch);

    const outputs = (await record()).outputs as { path: string }[];

    expect(outputs.map((one) => one.path)).toEqual(["clips/C01.mp4", "frames/C01/end.jpg"]);
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
   * starting over is safe and needs no `--regenerate`, demanding one would
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

  /**
   * The one thing this module renders rather than saves is the still: what it
   * is and what to call it. A mistake there surfaces after publication, on a
   * record that already says `completed`, so it has to be fixable for nothing.
   */
  it("should publish again from its archive, sending nothing", async () => {
    const api = provider();
    await run(api.fetch);
    const before = api.calls.length;

    const again = await runVideoStage({ ...callOf(api.fetch), republish: true }, artifactOf());

    expect(again.ok ? again.data.state : reason(again)).toBe("resumed");
    expect(api.calls).toHaveLength(before);
    expect((await record()).status).toBe("completed");
  });

  it("should refuse to republish an attempt that never happened", async () => {
    const again = await runVideoStage(
      { ...callOf(provider().fetch), republish: true },
      artifactOf()
    );

    expect(reason(again)).toContain("nie ma próby");
  });

  it("should publish a clip whose provider returned no end frame, and say so", async () => {
    const result = await run(provider({ endFrame: false }).fetch);

    expect(result.ok ? result.data.note : reason(result)).toContain("końcówk");
    expect(result.ok ? result.data.endFrame : null).toBe(false);

    const outputs = (await record()).outputs as { path: string }[];
    expect(outputs.map((one) => one.path)).toEqual(["clips/C01.mp4"]);
  });

  /**
   * The second provider. The model id decides who renders, through a closed
   * table, so everything below is the same lifecycle on a different wire:
   * the receipt before the poll, resume by asking, the answer archived before
   * it is judged. What differs is that Kling hands back no final frame, so the
   * clip's end is cut out of the downloaded MP4, here, before the verdict.
   */
  describe("on Kling", () => {
    const KLING = "kling-3.0";
    const TASKS = "https://api-singapore.klingai.com/tasks?task_ids=";

    interface KlingCall {
      readonly authorization: string | null;
      readonly body: unknown;
      readonly method: string;
      readonly url: string;
    }

    /**
     * A Kling that answers the way its documentation says it does: `data.id`
     * from the POST, `data[0]` from the task query, and the video among the
     * task's `outputs`, with no final frame anywhere.
     */
    function kling(options: { fail?: string; polls?: number; video?: Buffer } = {}): {
      readonly calls: KlingCall[];
      readonly fetch: typeof fetch;
      /** The job id `clips.stage.json` held at the moment of each poll. */
      readonly receipts: (string | null)[];
    } {
      const { fail, polls = 1, video = CLIP } = options;
      const calls: KlingCall[] = [];
      const receipts: (string | null)[] = [];
      const seen = new Map<string, number>();
      let jobs = 0;

      const impl = ((url: string | URL, init?: RequestInit) => {
        const href = String(url);
        const method = init?.method ?? "GET";
        const headers = new Headers(init?.headers);

        calls.push({
          authorization: headers.get("authorization"),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
          method,
          url: href,
        });

        if (href === "https://download/video") {
          return Promise.resolve(new Response(video, { status: 200 }));
        }

        if (method === "POST") {
          jobs += 1;

          return Promise.resolve(
            Response.json({
              code: 0,
              data: { id: `kt-${jobs}`, status: "submitted" },
              message: "SUCCEED",
              request_id: `req-${jobs}`,
            })
          );
        }

        const id = new URL(href).searchParams.get("task_ids") ?? "";
        const asked = (seen.get(id) ?? 0) + 1;
        seen.set(id, asked);
        receipts.push(
          (
            JSON.parse(readFileSync(join(dir, "clips.stage.json"), "utf8")) as {
              artifacts: Record<string, { jobId: string | null } | undefined>;
            }
          ).artifacts.C01?.jobId ?? null
        );

        if (fail !== undefined) {
          return Promise.resolve(
            Response.json({ code: 0, data: [{ id, message: fail, status: "failed" }] })
          );
        }

        return Promise.resolve(
          Response.json({
            code: 0,
            data: [
              asked < polls
                ? { id, status: "processing" }
                : {
                    id,
                    outputs: [
                      {
                        duration: "14",
                        id: `vid-${id}`,
                        type: "video",
                        url: "https://download/video",
                      },
                    ],
                    status: "succeeded",
                  },
            ],
          })
        );
      }) as unknown as typeof fetch;

      return { calls, fetch: impl, receipts };
    }

    it("should send a kling-3.0 job to Kling, silent, starting on the entry frame", async () => {
      const api = kling();
      const result = await run(api.fetch, { model: KLING });

      expect(result.ok ? result.data.state : reason(result)).toBe("published");

      const [post] = api.calls.filter((call) => call.method === "POST");

      expect(post?.url).toBe("https://api-singapore.klingai.com/image-to-video/kling-3.0");
      expect(post?.authorization).toBe("Bearer ark-test-key");
      expect(post?.body).toEqual({
        contents: [
          { text: "Ewa siada przy stole.", type: "prompt" },
          // Raw Base64, no `data:` prefix: the format the first real call confirms.
          { type: "first_frame", url: FIRST.toString("base64") },
        ],
        options: { watermark_info: { enabled: false } },
        settings: { audio: "off", duration: 14, multi_shot: false, resolution: "1080p" },
      });
      expect(api.calls.map((call) => call.url)).toContain(`${TASKS}kt-1`);
    });

    it("should keep sending a Seedance model to ModelArk", async () => {
      const api = provider();
      await run(api.fetch);

      const [post] = api.calls.filter((call) => call.method === "POST");

      expect(post?.url).toContain("ark.ap-southeast.bytepluses.com");
    });

    /**
     * The frame is cut out of the bytes that were downloaded, before anything
     * judges them, and published as a second output of the same record, under
     * the name of what it is.
     */
    it("should cut the end frame out of the clip and publish it beside it", async () => {
      const engine = cutter();
      await run(kling().fetch, { model: KLING, mux: engine.mux });

      const runId = (await record()).runId as string;
      const outputs = (await record()).outputs as { path: string }[];

      expect(engine.cuts).toEqual([join(dir, "runs", runId, "original.mp4")]);
      expect(outputs.map((one) => one.path)).toEqual(["clips/C01.mp4", "frames/C01/end.png"]);
      expect((await readFile(join(dir, "frames", "C01", "end.png"))).equals(END_AS_PNG)).toBe(true);
      expect((await record()).producer).toMatchObject({
        endpoint: "https://api-singapore.klingai.com/image-to-video/kling-3.0",
        model: KLING,
      });
    });

    /** The receipt is on disk before Kling is asked anything about the job. */
    it("should record the task id before the first poll", async () => {
      const api = kling({ polls: 2 });
      await run(api.fetch, { model: KLING });

      expect(api.receipts).toEqual(["kt-1", "kt-1"]);
    });

    it("should finish an interrupted Kling job by asking after the same id", async () => {
      const abandoned = await run(kling({ polls: Number.POSITIVE_INFINITY }).fetch, {
        impatient: true,
        model: KLING,
      });

      expect(reason(abandoned)).toContain("powtórz to samo polecenie");
      expect((await record()).jobId).toBe("kt-1");

      const second = kling();
      const resumed = await run(second.fetch, { model: KLING });

      expect(resumed.ok ? resumed.data.state : reason(resumed)).toBe("resumed");
      expect(second.calls.filter((call) => call.method === "POST")).toHaveLength(0);
      expect(second.calls.map((call) => call.url)).toContain(`${TASKS}kt-1`);
    });

    /**
     * A job is collected from the provider that started it. Asking ModelArk
     * about a Kling task would be a 404 at best; the person is told which
     * model to name instead.
     */
    it("should refuse to collect a job with a model other than the one that started it", async () => {
      await run(kling({ polls: Number.POSITIVE_INFINITY }).fetch, {
        impatient: true,
        model: KLING,
      });

      const other = provider();
      const resumed = await run(other.fetch);

      expect(reason(resumed)).toContain("--video-model kling-3.0");
      expect(other.calls).toHaveLength(0);
    });

    /**
     * Kling's `message` is the only account of why a job was turned down, so
     * it is the reason the person reads, and the answer carrying it is
     * archived. Nothing is published, and nothing was rendered to publish.
     */
    it("should give Kling's own message as the reason a job failed, and publish nothing", async () => {
      const result = await run(kling({ fail: "Treść nie przeszła moderacji" }).fetch, {
        model: KLING,
      });

      expect(reason(result)).toContain("Treść nie przeszła moderacji");
      expect((await record()).status).toBe("submitted");
      expect((await record()).outputs).toEqual([]);
      await expect(readFile(join(dir, "clips", "C01.mp4"))).rejects.toThrow();

      const runId = (await record()).runId as string;
      const archived = await readFile(join(dir, "runs", runId, "response.json"), "utf8");

      expect(archived).toContain("Treść nie przeszła moderacji");
    });

    /**
     * The download is handed to ffmpeg only once it has passed for an MP4 by
     * this module's own box reader: a local parser is not where a provider's
     * bytes are first looked at.
     */
    it("should not hand ffmpeg a download that is not an MP4", async () => {
      const engine = cutter();
      const result = await run(
        kling({ video: Buffer.from("ffconcat version 1.0\nfile previous.mp4\n") }).fetch,
        { model: KLING, mux: engine.mux }
      );

      expect(reason(result)).toContain("MP4");
      expect(engine.cuts).toEqual([]);
      expect((await record()).status).toBe("submitted");
    });

    /** The video's own id, which a later lip-sync call is addressed by. */
    it("should archive the answer that carried the result, with the output's id", async () => {
      await run(kling().fetch, { model: KLING });

      const runId = (await record()).runId as string;
      const archived = JSON.parse(
        await readFile(join(dir, "runs", runId, "response.json"), "utf8")
      ) as { data: { outputs: { id: string; type: string }[] }[] };

      expect(archived.data[0]?.outputs).toContainEqual(
        expect.objectContaining({ id: "vid-kt-1", type: "video" })
      );
    });
  });
});
