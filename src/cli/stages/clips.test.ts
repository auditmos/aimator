import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkClips } from "../../lib/clips/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import { EPISODE, makeTrack, makeUpstream, PROJECT } from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 7 asked about on its own: two media in one command, and one chain.
 *
 * The object this stage prints is the first whose bill is **two numbers**, and
 * that is the whole reason the flag is worth having here. An image and a video
 * cost differently by an order of magnitude, so a caller reading one total
 * would be reading a number nobody is billed. Both travel, under the stage's
 * own field names, because `--json` prints the report the module already
 * returns rather than a format designed for a screen.
 *
 * The other half is the chain. The untouched track has no accepted opening
 * frame, so every link is closed and the honest bill is zero twice over, with
 * the reason in the artifact's own note. That is what a panel renders and what
 * an agent reads, out of one answer.
 */

vi.mock("../../lib/env.js", () => ({ env: {} }));

const DRAWN = "gpt-image";
const UNTOUCHED = "seedream";

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

function answer(clipIds: readonly string[] = ["C01", "C02"]): string {
  return JSON.stringify({
    clips: clipIds.map((id) => ({
      id,
      prompt: `Akcja klipu ${id}.`,
      referenceIds: ["hero:ewa", "hero:tata", "R01"],
    })),
    entryFrames: clipIds
      .slice(1)
      .map((id) => ({ clipId: id, prompt: `Pierwsza chwila klipu ${id}.` })),
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
  root = await mkdtemp(join(tmpdir(), "aimator-cli-clips-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-clips-src-"));
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;

  await makeUpstream({ answer: answer(), approvePackage: true, root, scratch, workspace });
  await makeTrack({ root, track: DRAWN, workspace });
}, 120_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("check --stage clips", () => {
  it("should print the stage's own object, plus the two fields that place it", async () => {
    const printed = await object(
      "check",
      PROJECT,
      EPISODE,
      "--stage",
      "clips",
      "--track",
      DRAWN,
      "--json"
    );
    const stage = await checkClips({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: DRAWN,
      workspace,
    });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "clips", ...stage.data });
  });

  /**
   * Both media in one list, each saying which it is.
   *
   * A clip and the frame it starts on are two purchases and one review, so
   * they are one list with a `kind` rather than two lists that a reader would
   * have to put back in the chain's order.
   */
  it("should carry both media of the chain, each under its own kind", async () => {
    const printed = (await object(
      "check",
      PROJECT,
      EPISODE,
      "--stage",
      "clips",
      "--track",
      DRAWN,
      "--json"
    )) as { artifacts: readonly { id: string; kind: string }[] };

    expect(printed.artifacts.map((one) => [one.id, one.kind])).toEqual([
      ["C01", "clip"],
      ["entry:C02", "entry-frame"],
      ["C02", "clip"],
    ]);
  });
});

describe("approve --stage clips", () => {
  it("should print the stage's own object under --json, over the artifacts it names", async () => {
    const printed = await object(
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "clips",
      "--track",
      DRAWN,
      "--artifact",
      "C01,entry:C02",
      "--checks",
      "all",
      "--reviewer",
      "fixture",
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({ command: "approve", stage: "clips", track: DRAWN });
  });
});

/**
 * An entry frame is a frame ready for animation, so it is accepted against the
 * QC checklist like the opening frame; a clip is not. Assumptions: one
 * `--checks` covers every entry frame `--artifact` names; every frame here
 * attaches `hero:ewa`, so all five criteria apply; a clip ignores the flag.
 * Three clips, because two entry frames are what "each of them" needs.
 */
describe("approve --stage clips --checks", () => {
  let chain = "";

  beforeAll(async () => {
    chain = await mkdtemp(join(tmpdir(), "aimator-cli-clips-chain-"));
    const sources = await mkdtemp(join(tmpdir(), "aimator-cli-clips-chain-src-"));
    const resolved = resolveWorkspace(chain);

    if (!resolved.ok) {
      throw resolved.error;
    }

    await makeUpstream({
      answer: answer(["C01", "C02", "C03"]),
      approvePackage: true,
      root: chain,
      scratch: sources,
      shotList: "three-clips",
      workspace: resolved.data,
    });
    await makeTrack({ root: chain, track: DRAWN, workspace: resolved.data });
    await rm(sources, { force: true, recursive: true });
  }, 120_000);

  afterAll(async () => {
    await rm(chain, { force: true, recursive: true });
  });

  async function records(): Promise<
    Partial<Record<string, { review: { checks?: readonly string[]; reviewer: string } }>>
  > {
    const path = join(chain, "projects", PROJECT, "episodes", EPISODE, DRAWN, "clips.stage.json");

    return JSON.parse(await readFile(path, "utf8")).artifacts;
  }

  function approve(...flags: readonly string[]) {
    return run([
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "clips",
      "--track",
      DRAWN,
      ...flags,
      "--workspace",
      chain,
    ]);
  }

  it("should record the checklist on every entry frame it names", async () => {
    const result = await approve(
      "--artifact",
      "entry:C02,entry:C03",
      "--checks",
      "all",
      "--reviewer",
      "qc"
    );

    expect(result.ok ? null : result.error.message).toBeNull();

    const artifacts = await records();

    for (const id of ["entry:C02", "entry:C03"]) {
      expect(artifacts[id]?.review).toMatchObject({
        checks: ["anatomy", "master", "style", "continuity", "props"],
        reviewer: "qc",
      });
    }
  });

  it("should refuse an entry frame without --checks, naming the criteria", async () => {
    const result = await approve("--artifact", "C01,entry:C02");

    expect(result.ok ? null : result.error.message).toContain(
      "entry:C02 (gpt-image): zatwierdzenie wymaga --checks z kryteriami: anatomy, master, style, continuity, props"
    );
  });

  it("should accept a clip without --checks, as before, and record none", async () => {
    const result = await approve("--artifact", "C01", "--reviewer", "clip-only");

    expect(result.ok ? null : result.error.message).toBeNull();

    const clip = (await records()).C01;

    expect(clip?.review.reviewer).toBe("clip-only");
    expect(clip?.review.checks).toBeUndefined();
  });
});

describe("clip generate --json", () => {
  /**
   * The first report in this tool whose bill is two numbers.
   *
   * They are counted apart because they cost apart, so a panel that summed
   * them would be putting a number beside a button that nobody is billed.
   */
  it("should print the report this command returns, with both bills in it", async () => {
    const report = (await object(
      "clip",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      UNTOUCHED,
      "--image-model",
      "gpt-image-2.5-sunburst",
      "--video-model",
      "dreamina-seedance-2-5-260628",
      "--dry-run",
      "--json"
    )) as {
      command: string;
      paidImages: number;
      paidVideos: number;
      stage: string;
    };

    expect(report.command).toBe("generate");
    expect(report.stage).toBe("clips");
    // Nothing is accepted on this track, so the chain is closed at its first
    // link and the honest bill is zero in both currencies.
    expect([report.paidImages, report.paidVideos]).toEqual([0, 0]);
  });

  /**
   * Naming a blocked link is the other question: why not that one yet.
   *
   * Without `--artifact` the command buys whatever the chain allows, which on
   * an untouched track is nothing, so there is no artifact to ask about. Named,
   * the target is planned and carries its own obstacle, which is the sentence
   * the panel puts under the clip rather than the word "blocked".
   */
  it("should answer why a named link cannot be bought yet", async () => {
    const report = (await object(
      "clip",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      UNTOUCHED,
      "--artifact",
      "C01",
      "--image-model",
      "gpt-image-2.5-sunburst",
      "--video-model",
      "dreamina-seedance-2-5-260628",
      "--dry-run",
      "--json"
    )) as {
      artifacts: readonly { readonly id: string; readonly kind: string; readonly note: string }[];
      paidVideos: number;
    };

    expect(report.paidVideos).toBe(0);
    expect(report.artifacts.map((one) => [one.id, one.kind])).toEqual([["C01", "clip"]]);
    expect(report.artifacts[0]?.note).toContain("opening-frame");
  });

  it("should say the same numbers in prose as it says in the object", async () => {
    const prose = await cli(
      "clip",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      UNTOUCHED,
      "--image-model",
      "gpt-image-2.5-sunburst",
      "--video-model",
      "dreamina-seedance-2-5-260628",
      "--dry-run"
    );

    expect(prose).toContain("płatnych wywołań do wykonania, obrazów: 0, wideo: 0");
  });

  /**
   * A clip re-rendered by another model than the track's accepted ones is a
   * notice, `·`, never a refusal, `!`: the purchase is legal, and the person
   * only has to know that stage 8 will wait until the track is on one model.
   */
  it("should print a model the track's accepted clips do not share as a notice", async () => {
    const argv = [
      "clip",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      DRAWN,
      "--artifact",
      "C02",
      "--regenerate",
      "--video-model",
      "kling-3.0",
      "--dry-run",
    ] as const;
    const prose = await cli(...argv);
    const report = (await object(...argv, "--json")) as {
      notices: readonly string[];
      paidVideos: number;
    };

    expect(prose).toContain(
      "  · zatwierdzone klipy toru gpt-image pochodzą z innego modelu: C01 (dreamina-seedance-2-5-260628)"
    );
    expect(report.notices.join("\n")).toContain("C01 (dreamina-seedance-2-5-260628)");
    expect(report.paidVideos).toBe(1);
  });
});
