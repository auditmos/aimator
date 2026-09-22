import { mkdtemp, rm } from "node:fs/promises";
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
      "--reviewer",
      "fixture",
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({ command: "approve", stage: "clips", track: DRAWN });
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
});
