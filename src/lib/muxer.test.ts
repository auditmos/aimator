import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ffmpeg } from "./muxer.js";
import { hasSound, validateVideo } from "./video-model/index.js";

/**
 * The real engine, which every other test replaces with a fake.
 *
 * Two things here cannot be faked without testing the fake instead: what
 * happens when the program is not on this machine, and whether the version
 * string a real ffmpeg prints is the one this module claims to read. The first
 * runs anywhere; the second only where ffmpeg is installed, and is skipped
 * rather than mocked, because a mocked `ffmpeg -version` would assert nothing
 * about the format it exists to parse.
 */

/** What the module promises a version string looks like: the name, then one token. */
const VERSION = /^ffmpeg \S+$/;

/** Whether this machine has one, so the second test knows to run. */
function installed(): boolean {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
}

describe("ffmpeg", () => {
  /**
   * The refusal is the whole of what stage 8 does without an engine — there is
   * no second road — so the message has to name both remedies.
   */
  it("should refuse by name when the program is not there", async () => {
    const result = await ffmpeg("aimator-no-such-muxer").version();

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("AIMATOR_FFMPEG");
  });

  it("should refuse a program that answers but is not ffmpeg", async () => {
    const result = await ffmpeg("echo").version();

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("ffmpeg");
  });

  it.runIf(installed())("should read the version a real ffmpeg prints", async () => {
    const result = await ffmpeg("ffmpeg").version();

    expect(result.ok ? result.data : "").toMatch(VERSION);
  });
});

/**
 * `mix` against the real engine, because its whole content is a filtergraph.
 *
 * A fake muxer asserts that the stage called it; only the program can say
 * whether what it was told is a thing ffmpeg does. So this synthesises its own
 * inputs with the engine, mixes them, and reads the result back with the same
 * box reader `check` uses — no decoder, no second tool.
 */
describe("ffmpeg mix", () => {
  let scratch = "";

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "aimator-mux-"));
  });

  afterEach(async () => {
    await rm(scratch, { force: true, recursive: true });
  });

  /** A silent picture and two spoken lines, made by the engine under test. */
  function inputs(): { lines: string[]; video: string } {
    const video = join(scratch, "episode.mp4");
    const lines = [join(scratch, "N01.wav"), join(scratch, "N02.wav")];

    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x180:rate=24:duration=6",
      "-pix_fmt",
      "yuv420p",
      video,
    ]);

    for (const [index, line] of lines.entries()) {
      execFileSync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${440 + index * 110}:duration=1`,
        "-ar",
        "24000",
        "-ac",
        "1",
        line,
      ]);
    }

    return { lines, video };
  }

  it.runIf(installed())("should lay each line down without touching the picture", async () => {
    const { lines, video } = inputs();
    const target = join(scratch, "narrated.mp4");
    const result = await ffmpeg("ffmpeg").mix({
      lines: [
        { atSeconds: 0.5, path: lines[0] ?? "" },
        { atSeconds: 3.25, path: lines[1] ?? "" },
      ],
      target,
      video,
    });

    expect(result.ok ? null : result.error.message).toBe(null);
    expect(result.ok ? result.data.argv.join(" ") : "").toContain("-c:v");

    const verdict = validateVideo(await readFile(target), { aspectRatio: "16:9", seconds: 6 });

    expect(verdict.ok ? verdict.data.width : null).toBe(320);
    expect(verdict.ok ? verdict.data.height : null).toBe(180);
  });

  /**
   * The picture is passed through, so the narrated file runs exactly as long as
   * the cut it was made from. Audio shorter than the film must never shorten
   * the film — the frames are somebody's accepted bytes.
   */
  it.runIf(installed())(
    "should keep the film's own length when the speech is shorter",
    async () => {
      const { lines, video } = inputs();
      const target = join(scratch, "narrated.mp4");
      const result = await ffmpeg("ffmpeg").mix({
        lines: [{ atSeconds: 0, path: lines[0] ?? "" }],
        target,
        video,
      });

      expect(result.ok).toBe(true);

      const verdict = validateVideo(await readFile(target), { aspectRatio: "16:9", seconds: 6 });

      expect(verdict.ok ? verdict.data.seconds : null).toBeCloseTo(6, 1);
    }
  );

  it.runIf(installed())("should carry a sound track where the cut had none", async () => {
    const { lines, video } = inputs();
    const target = join(scratch, "narrated.mp4");

    await ffmpeg("ffmpeg").mix({
      lines: [{ atSeconds: 1, path: lines[0] ?? "" }],
      target,
      video,
    });

    expect(hasSound(await readFile(video))).toBe(false);
    expect(hasSound(await readFile(target))).toBe(true);
  });
});
