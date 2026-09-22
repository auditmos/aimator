import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkAssembly } from "../../lib/assembly/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import { EPISODE, makeCut, makeUpstream, PROJECT } from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 8 asked about on its own: the first object with **no bill in it**.
 *
 * Every `--json` above this one carries a count of what a command would spend,
 * because every stage above this one spends. This one carries an arithmetic
 * instead: what the approved plan ordered, what the clips actually run, and
 * the difference nothing here trims away. A panel reading this report has no
 * number to put beside a "Kup" button, which is the honest shape of a stage
 * that buys nothing rather than a field somebody forgot.
 *
 * The other half is the engine. `AIMATOR_FFMPEG` is pointed at a path no
 * machine has, exactly as the usage freeze points it, so what this stage says
 * about a missing engine is the same sentence wherever the test runs, and the
 * same sentence in the object as in the prose, which is the whole promise the
 * flag makes.
 */

vi.mock("../../lib/env.js", () => ({ env: { AIMATOR_FFMPEG: "/nonexistent/aimator-ffmpeg" } }));

const TRACK = "gpt-image";
/** The track nothing was ever drawn on, so the gate is shut at its first link. */
const UNTOUCHED = "seedream";

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

function answer(): string {
  return JSON.stringify({
    clips: ["C01", "C02"].map((id) => ({
      id,
      prompt: `Akcja klipu ${id}.`,
      referenceIds: ["hero:ewa", "hero:tata", "R01"],
    })),
    entryFrames: [{ clipId: "C02", prompt: "Pierwsza chwila klipu C02." }],
    opening: { prompt: "Ewa centralnie, burza za oknem.", referenceIds: ["hero:ewa", "R01"] },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        prompt: "Salon z niską kanapą.",
        subject: "Living room, evening",
      },
    ],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

async function cli(...argv: readonly string[]): Promise<string> {
  const result = await run([...argv, "--workspace", root]);

  if (!result.ok) {
    throw result.error;
  }

  return result.data;
}

async function object(...argv: readonly string[]): Promise<unknown> {
  return JSON.parse(await cli(...argv));
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-cli-assembly-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-assembly-src-"));
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;

  await makeUpstream({ answer: answer(), approvePackage: true, root, scratch, workspace });
  await makeCut({ root, track: TRACK, workspace });
}, 120_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("check --stage assembly", () => {
  it("should print the stage's own object, plus the two fields that place it", async () => {
    const printed = await object(
      "check",
      PROJECT,
      EPISODE,
      "--stage",
      "assembly",
      "--track",
      TRACK,
      "--json"
    );
    const stage = await checkAssembly({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: TRACK,
      workspace,
    });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "assembly", ...stage.data });
  });

  /**
   * Silence is a notice and never a problem, and the object has to keep them
   * apart. The ladder calls a cell blocked off `problems` alone, so a cut that
   * is finished, accepted and simply soundless must not look like a refusal.
   */
  it("should carry the silent cut as a notice rather than an obstacle", async () => {
    const printed = (await object(
      "check",
      PROJECT,
      EPISODE,
      "--stage",
      "assembly",
      "--track",
      TRACK,
      "--json"
    )) as { notices: readonly string[]; problems: readonly string[] };

    expect(printed.problems).toEqual([]);
    expect(printed.notices.join("\n")).toContain("episode.mp4 jest niemy");
  });
});

describe("approve --stage assembly", () => {
  it("should print the stage's own object under --json", async () => {
    const printed = await object(
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "assembly",
      "--track",
      TRACK,
      "--reviewer",
      "fixture",
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({ command: "approve", stage: "assembly", track: TRACK });
  });
});

describe("assembly generate --json", () => {
  /**
   * The cut plan, in the object, derived rather than stored.
   *
   * There is no `edit-plan.json` and there never will be: the order, the
   * seconds and the tiling are in the approved shot list already. So a panel
   * that wants to show what would be cut reads this array, which is the plan
   * the stage derived for this run and nothing anybody could hand-correct into
   * a second truth.
   */
  it("should print the cut derived from the approved shot list, clip by clip", async () => {
    const report = (await object(
      "assembly",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      TRACK,
      "--dry-run",
      "--json"
    )) as {
      actualSeconds: number;
      command: string;
      cut: readonly { id: string; plannedSeconds: number; seconds: number | null }[];
      plannedSeconds: number;
      stage: string;
    };

    expect(report.command).toBe("generate");
    expect(report.stage).toBe("assembly");
    expect(report.cut.map((one) => one.id)).toEqual(["C01", "C02"]);
    expect(report.plannedSeconds).toBe(30);
    expect(report.actualSeconds).toBe(30);
  });

  /** A stage that buys nothing prints no bill; there is no number to spend. */
  it("should carry no count of paid calls at all", async () => {
    const report = (await object(
      "assembly",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      TRACK,
      "--dry-run",
      "--json"
    )) as Record<string, unknown>;

    expect(Object.keys(report)).not.toContain("paidCalls");
    expect(Object.keys(report)).not.toContain("paidImages");
    expect(Object.keys(report)).not.toContain("paidVideos");
  });

  it("should say the same thing about a missing engine as it says in prose", async () => {
    const [report, prose] = await Promise.all([
      object(
        "assembly",
        "generate",
        PROJECT,
        EPISODE,
        "--track",
        TRACK,
        "--dry-run",
        "--json"
      ) as Promise<{ engine: string | null; problems: readonly string[] }>,
      cli("assembly", "generate", PROJECT, EPISODE, "--track", TRACK, "--dry-run"),
    ]);

    expect(report.engine).toBeNull();
    expect(report.problems).toHaveLength(1);
    expect(prose).toContain(report.problems[0] ?? "nie ma takiego zdania");
  });

  /**
   * The gate, said in the object the same way the ladder reads it: an
   * untouched track has no accepted clip, so the cut is blocked and the reason
   * names the stage below rather than the word "blocked".
   */
  it("should answer why a track with no accepted clips cannot be cut", async () => {
    const report = (await object(
      "assembly",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      UNTOUCHED,
      "--dry-run",
      "--json"
    )) as { artifact: { state: string }; ready: boolean };

    expect(report.ready).toBe(false);
    expect(report.artifact.state).toBe("blocked");
  });
});
