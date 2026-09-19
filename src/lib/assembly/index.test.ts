import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EPISODE, makeTrack, makeUpstream, mp4, PROJECT } from "../../test/fixture.js";
import { err, ok, type Result } from "../result.js";
import { type ImageTrack, resolveWorkspace, type Workspace } from "../workspace.js";
import { approveAssembly, type ConcatReport, checkAssembly, generateAssembly } from "./index.js";

/**
 * Stage 8 end to end, through the module entry.
 *
 * It is the first stage that buys nothing, the first whose result is produced
 * by a local engine rather than by a person or a model, and the last row of the
 * table. Three things are therefore under test and everything else is borrowed:
 * the gate over another stage's per-track results, the cut derived from the
 * approved shot list rather than from a stored plan, and the drift between the
 * seconds a human approved and the seconds that actually came back.
 *
 * Stages 0 to 4 come from `src/test/fixture`; so does the finished track, built
 * through the real entries of stages 5, 6 and 7. The muxer is injected exactly
 * as `fetch` is in a paid stage, so no test ever spawns a process.
 */

/** Three clips of ten planned seconds each — the shot list `three-clips` cuts. */
const CLIP_IDS = ["C01", "C02", "C03"] as const;
const PLANNED_SECONDS = 30;
/** What a 24 fps renderer actually hands back for ten ordered seconds. */
const DRIFTING = { C01: 10.04, C02: 10.04, C03: 10.04 };
const DRIFTED_SECONDS = 30.12;
const ENGINE = "ffmpeg 7.1.1";

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

function answer(): string {
  return JSON.stringify({
    clips: CLIP_IDS.map((id) => ({
      id,
      prompt: `Akcja klipu ${id}.`,
      referenceIds: ["hero:ewa", "hero:tata", "R01"],
    })),
    entryFrames: CLIP_IDS.slice(1).map((id) => ({
      clipId: id,
      prompt: `Pierwsza chwila klipu ${id}.`,
    })),
    opening: { prompt: "Ewa centralnie, burza za oknem.", referenceIds: ["hero:ewa", "R01"] },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        prompt: "Salon z niską kanapą.",
        subject: "Living room — evening",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

function upstream(): Promise<void> {
  return makeUpstream({
    answer: answer(),
    approvePackage: true,
    root,
    scratch,
    shotList: "three-clips",
    workspace,
  });
}

interface Fake {
  readonly mux: Parameters<typeof generateAssembly>[0]["mux"];
  /** Every concat the command asked for; the count is the assertion. */
  readonly runs: { clips: readonly string[]; target: string }[];
}

/**
 * An ffmpeg that is present and does its job, or one that is not there at all.
 *
 * `seconds` is what the file it writes turns out to run, so a test can hand the
 * stage a cut that does not add up to its own inputs — which is the one verdict
 * stage 8 passes on its own work rather than on somebody else's.
 */
function muxer(options: { absent?: boolean; seconds?: number } = {}): Fake {
  const { absent = false, seconds = DRIFTED_SECONDS } = options;
  const runs: { clips: readonly string[]; target: string }[] = [];

  return {
    mux: {
      concat: async (input): Promise<Result<ConcatReport>> => {
        runs.push({ clips: input.clips, target: input.target });

        if (absent) {
          return err(new Error("nie znaleziono ffmpeg"));
        }

        const { writeFile } = await import("node:fs/promises");
        await writeFile(input.target, mp4({ height: 1080, seconds, width: 1920 }));

        return ok({
          argv: ["ffmpeg", "-f", "concat", "-c", "copy", input.target],
          engine: ENGINE,
          stderr: "",
        });
      },
      version: () =>
        Promise.resolve(
          absent ? err(new Error("nie znaleziono ffmpeg w PATH ani w AIMATOR_FFMPEG")) : ok(ENGINE)
        ),
    },
    runs,
  };
}

function generate(overrides: Partial<Parameters<typeof generateAssembly>[0]> = {}) {
  return generateAssembly({
    artifacts: [],
    episodeId: EPISODE,
    mode: "apply",
    mux: muxer().mux,
    projectId: PROJECT,
    regenerate: false,
    track: "gpt-image",
    workspace,
    ...overrides,
  });
}

function accept(overrides: Partial<Parameters<typeof approveAssembly>[0]> = {}) {
  return approveAssembly({
    artifacts: [],
    episodeId: EPISODE,
    mode: "apply",
    note: "ok",
    projectId: PROJECT,
    reviewer: "tester",
    track: "gpt-image",
    workspace,
    ...overrides,
  });
}

function inspect(track: ImageTrack = "gpt-image") {
  return checkAssembly({ episodeId: EPISODE, projectId: PROJECT, track, workspace });
}

function trackDir(track: ImageTrack = "gpt-image"): string {
  return join(root, "projects", PROJECT, "episodes", EPISODE, track);
}

async function stageFile(track: ImageTrack = "gpt-image") {
  const raw = await readFile(join(trackDir(track), "assembly.stage.json"), "utf8");

  return JSON.parse(raw) as {
    artifacts: Record<
      string,
      | {
          inputs: { path: string; sha256: string }[];
          producer: { kind: string; model: string | null };
          review: { status: string };
          status: string;
        }
      | undefined
    >;
  };
}

function reason(result: { error?: Error; ok: boolean }): string {
  return result.ok ? "" : (result.error?.message ?? "");
}

async function present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-stage8-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);
  workspace = resolved.ok ? resolved.data : { root: "" };
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("generateAssembly gates", () => {
  /**
   * The table says stage 8 consumes approved clips, and that is the whole gate:
   * every clip the shot list plans, finished and accepted on this track. The
   * entry frames and end frames are not in the cut — an entry frame is already
   * the first frame of its own clip — so asking after them would be a gate on a
   * file this stage never opens.
   */
  it("should refuse to cut until every clip the plan names is accepted here", async () => {
    await upstream();
    await makeTrack({ pending: ["C03"], root, track: "gpt-image", workspace });

    const fake = muxer();
    const result = await generate({ mux: fake.mux });

    expect(fake.runs).toHaveLength(0);
    expect(reason(result)).toContain("C03");
  });

  it("should not let a track finished elsewhere open this one", async () => {
    await upstream();
    await makeTrack({ root, track: "gpt-image", workspace });

    const fake = muxer();
    const result = await generate({ mux: fake.mux, track: "seedream" });

    expect(fake.runs).toHaveLength(0);
    expect(reason(result)).toContain("C01");
  });

  /**
   * There is no second road. A muxer written here would be a decoder this
   * repository would have to trust, which is exactly what stage 7 avoided by
   * reading boxes, and re-encoding would publish frames nobody accepted.
   */
  it("should refuse when the muxer is missing rather than find another way", async () => {
    await upstream();
    await makeTrack({ root, track: "gpt-image", workspace });

    const fake = muxer({ absent: true });
    const result = await generate({ mux: fake.mux });

    expect(reason(result)).toContain("ffmpeg");
    expect(await present(join(trackDir(), "episode.mp4"))).toBe(false);
  });

  /** One artifact per track, so `--artifact` narrows nothing — but it is read. */
  it("should refuse an --artifact that is not the episode", async () => {
    await upstream();
    await makeTrack({ root, track: "gpt-image", workspace });

    const result = await generate({ artifacts: ["C01"] });

    expect(reason(result)).toContain("etap 8");
  });
});

describe("generateAssembly", () => {
  it("should cut the clips into one episode and record a local producer", async () => {
    await upstream();
    await makeTrack({ clipSeconds: DRIFTING, root, track: "gpt-image", workspace });

    const fake = muxer();
    const result = await generate({ mux: fake.mux });

    expect(result.ok ? result.data.artifact.state : reason(result)).toBe("published");
    expect(fake.runs).toHaveLength(1);
    expect(await present(join(trackDir(), "episode.mp4"))).toBe(true);

    const { artifacts } = await stageFile();
    expect(artifacts.episode?.producer.kind).toBe("local");
    expect(artifacts.episode?.producer.model).toBe(ENGINE);
    expect(artifacts.episode?.review.status).toBe("pending");
  });

  /** The cut is the plan's order, never the directory's. */
  it("should hand the muxer the clips in the order the shot list plans", async () => {
    await upstream();
    await makeTrack({ root, track: "gpt-image", workspace });

    const fake = muxer({ seconds: PLANNED_SECONDS });
    await generate({ mux: fake.mux });

    expect(fake.runs[0]?.clips.map((path) => path.slice(-7))).toEqual([
      "C01.mp4",
      "C02.mp4",
      "C03.mp4",
    ]);
  });

  /**
   * Every clip is a recorded input, so redrawing one is drift the next check
   * reports — the same contract every stage above this one already keeps.
   */
  it("should record every clip it cut, by path and digest", async () => {
    await upstream();
    await makeTrack({ root, track: "gpt-image", workspace });
    await generate({ mux: muxer({ seconds: PLANNED_SECONDS }).mux });

    const paths = (await stageFile()).artifacts.episode?.inputs.map((one) => one.path) ?? [];

    expect(paths.filter((one) => one.endsWith(".mp4"))).toHaveLength(CLIP_IDS.length);
    expect(paths.some((one) => one.endsWith("shot-list.md"))).toBe(true);
  });

  /**
   * Clips do not come back to the second, and stage 7 publishes them as they
   * arrived rather than trimming. So the cut is what arrived, and the
   * difference from the approved plan is stated instead of being corrected.
   */
  it("should report the drift between the approved plan and what came back", async () => {
    await upstream();
    await makeTrack({ clipSeconds: DRIFTING, root, track: "gpt-image", workspace });

    const result = await generate({ mux: muxer().mux });

    expect(result.ok ? result.data.plannedSeconds : null).toBe(PLANNED_SECONDS);
    expect(result.ok ? result.data.actualSeconds : null).toBeCloseTo(DRIFTED_SECONDS, 2);
    expect(result.ok ? result.data.problems.join("\n") : null).toContain("0.12");
  });

  /**
   * The verdict compares the cut against the sum of its own inputs, never
   * against `durationSeconds`: a correct concatenation of drifting clips must
   * not fail for a reason nobody downstream can fix.
   */
  it("should refuse a cut that does not add up to the clips it was made from", async () => {
    await upstream();
    await makeTrack({ clipSeconds: DRIFTING, root, track: "gpt-image", workspace });

    const result = await generate({ mux: muxer({ seconds: 20 }).mux });

    expect(reason(result)).toContain("30.12");
    expect(await present(join(trackDir(), "episode.mp4"))).toBe(false);
  });

  /**
   * Here `--regenerate` guards an approval rather than a wallet: nothing is
   * bought, but a finished cut carries a human's yes, and overwriting it
   * silently would withdraw that yes on nobody's authority.
   */
  it("should leave a finished cut alone until --regenerate names the re-cut", async () => {
    await upstream();
    await makeTrack({ root, track: "gpt-image", workspace });
    await generate({ mux: muxer({ seconds: PLANNED_SECONDS }).mux });

    const fake = muxer({ seconds: PLANNED_SECONDS });
    const result = await generate({ mux: fake.mux });

    expect(fake.runs).toHaveLength(0);
    expect(result.ok ? result.data.artifact.state : reason(result)).toBe("skipped");
  });

  it("should preserve the previous cut when it does re-cut", async () => {
    await upstream();
    await makeTrack({ root, track: "gpt-image", workspace });
    await generate({ mux: muxer({ seconds: PLANNED_SECONDS }).mux });

    const result = await generate({
      mux: muxer({ seconds: PLANNED_SECONDS }).mux,
      regenerate: true,
    });
    const created = result.ok ? result.data.created : [];

    expect(created.some((one) => one.endsWith("previous.mp4"))).toBe(true);
  });

  it("should show the plan, name the engine and write nothing on a dry run", async () => {
    await upstream();
    await makeTrack({ root, track: "gpt-image", workspace });

    const fake = muxer();
    const result = await generate({ mode: "dry-run", mux: fake.mux });

    expect(fake.runs).toHaveLength(0);
    expect(result.ok ? result.data.engine : null).toBe(ENGINE);
    expect(result.ok ? result.data.artifact.state : null).toBe("planned");
    expect(await present(join(trackDir(), "episode.mp4"))).toBe(false);
  });
});

describe("checkAssembly and approveAssembly", () => {
  /**
   * The episode declares a soundtrack and no stage produces one, so the cut is
   * silent. That is reported rather than hidden: the file is the whole of what
   * stage 8 was contracted to make, and the film is still not finished.
   */
  it("should say the declared soundtrack is missing without blocking the cut", async () => {
    await upstream();
    await makeTrack({ root, track: "gpt-image", workspace });
    await generate({ mux: muxer({ seconds: PLANNED_SECONDS }).mux });

    const status = await inspect();

    expect(status.ok ? status.data.problems.join("\n") : "").toContain("narration");
    expect(status.ok ? status.data.artifact.state : null).toBe("completed");
  });

  it("should accept the whole episode without an --artifact to disambiguate", async () => {
    await upstream();
    await makeTrack({ root, track: "gpt-image", workspace });
    await generate({ mux: muxer({ seconds: PLANNED_SECONDS }).mux });

    const result = await accept();

    expect(result.ok ? result.data.approved : reason(result)).toBe(true);
    expect((await stageFile()).artifacts.episode?.review.status).toBe("approved");
  });

  it("should refuse an approval before there is a cut to accept", async () => {
    await upstream();
    await makeTrack({ root, track: "gpt-image", workspace });

    expect(reason(await accept())).toContain("nie ma czego zatwierdzić");
  });

  /**
   * A clip redrawn after the cut is input drift: the approval expires, `check`
   * says so, and re-approving is a person watching the episode again beside the
   * new version — exactly as it is everywhere above this stage.
   */
  it("should let a redrawn clip expire the approval without failing validation", async () => {
    await upstream();
    await makeTrack({ root, track: "gpt-image", workspace });
    await generate({ mux: muxer({ seconds: PLANNED_SECONDS }).mux });
    await accept();

    // A clip redrawn to a length the plan still accepts: stage 7's verdict
    // tolerates a fraction of a second, so this is drift and not a broken file.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(trackDir(), "clips", "C02.mp4"),
      mp4({ height: 1080, seconds: 10.5, width: 1920 })
    );

    const status = await inspect();

    expect(status.ok ? status.data.artifact.approved : null).toBe(false);
    expect(status.ok ? status.data.problems.join("\n") : "").toContain("C02.mp4");
  });
});
