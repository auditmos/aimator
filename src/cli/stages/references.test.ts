import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkReferences } from "../../lib/references/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import { EPISODE, makeTrack, makeUpstream, PROJECT } from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 5 asked about on its own, and the first stage whose gate is a graph.
 *
 * Everything above it waits on a stage; this one waits on a **sibling**, and
 * on this track alone: R02 is drawn from R01, so it cannot be bought until a
 * person has accepted R01 here, and accepting it on the other track says
 * nothing. That is the reason the blocked case is tested on the untouched
 * track rather than invented: the refusal has to name the reference it is
 * waiting for, because that is the decision somebody has to make next.
 *
 * The rest is what stages 0 to 4 already established: `--json` prints the
 * stage's own object plus `command` and `stage`, the bill is stated before
 * anything is sent, and nothing here writes or spends.
 */

vi.mock("../../lib/env.js", () => ({ env: {} }));

const DRAWN = "gpt-image";
const UNTOUCHED = "seedream";

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** A package with a dependent reference in it: R02 is drawn from R01. */
function answer(): string {
  return JSON.stringify({
    // C02 reaches for R02, because a reference nothing reaches for is refused:
    // stage 5 would pay for an image nobody uses.
    clips: [
      { id: "C01", prompt: "Akcja klipu C01.", referenceIds: ["hero:ewa", "hero:tata", "R01"] },
      {
        id: "C02",
        prompt: "Akcja klipu C02.",
        referenceIds: ["hero:ewa", "hero:tata", "R01", "R02"],
      },
    ],
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
      {
        dependsOn: ["R01"],
        id: "R02",
        kind: "prop",
        prompt: "Niska kanapa z tego salonu, sama.",
        subject: "Low sofa, evening",
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
  root = await mkdtemp(join(tmpdir(), "aimator-cli-references-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-references-src-"));
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

describe("check --stage references", () => {
  it("should print the stage's own object, plus the two fields that place it", async () => {
    const printed = await object(
      "check",
      PROJECT,
      EPISODE,
      "--stage",
      "references",
      "--track",
      DRAWN,
      "--json"
    );
    const stage = await checkReferences({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: DRAWN,
      workspace,
    });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "references", ...stage.data });
  });
});

describe("approve --stage references", () => {
  it("should print the stage's own object under --json", async () => {
    const printed = await object(
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "references",
      "--track",
      DRAWN,
      "--artifact",
      "R01",
      "--reviewer",
      "fixture",
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({ command: "approve", stage: "references" });
  });
});

describe("reference generate --json", () => {
  /**
   * The graph gate, said as a number and as a sentence.
   *
   * On a track where nothing has been accepted yet, R01 can be drawn and R02
   * cannot: it is composed from R01, so buying it before a person has accepted
   * R01 would be paying for a picture drawn from one nobody wanted. The bill
   * therefore says one rather than two, and the refusal **names R01**, because
   * that is the decision standing between somebody and the second image.
   */
  it("should count only what the graph allows, and name what the rest waits for", async () => {
    const whatever = (await object(
      "reference",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      UNTOUCHED,
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run",
      "--json"
    )) as {
      artifacts: readonly { readonly id: string; readonly state: string }[];
      command: string;
      paidCalls: number;
      stage: string;
    };
    // Asked about R02 by name, the stage says why it will not draw it. Without
    // a name it simply draws what it can, which is the ordinary call and the
    // reason the refusal has to be askable for.
    const asked = (await object(
      "reference",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      UNTOUCHED,
      "--artifact",
      "R02",
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run",
      "--json"
    )) as {
      artifacts: readonly { readonly id: string; readonly note: string; readonly state: string }[];
      paidCalls: number;
    };

    expect(whatever.command).toBe("generate");
    expect(whatever.stage).toBe("references");
    expect(whatever.paidCalls).toBe(1);
    expect(whatever.artifacts.map((one) => [one.id, one.state])).toEqual([["R01", "planned"]]);
    expect(asked.paidCalls).toBe(0);
    expect(asked.artifacts[0]?.state).toBe("blocked");
    expect(asked.artifacts[0]?.note).toContain("R01");
  });

  /**
   * The same blockade, in the object the ladder carries.
   *
   * The panel lists every reference of the track, so what it needs is not the
   * preview's runnable set but the stage's verdict on all of them, and the
   * reason a dependent one is waiting has to be in it: a cell that says
   * "blocked" without naming R01 leaves a person with no next move.
   */
  it("should name the reference a dependent one waits for, in the check object", async () => {
    const status = (await object(
      "check",
      PROJECT,
      EPISODE,
      "--stage",
      "references",
      "--track",
      UNTOUCHED,
      "--json"
    )) as { artifacts: readonly { readonly id: string; readonly note: string }[] };

    expect(status.artifacts.find((one) => one.id === "R02")?.note).toContain("R01");
  });

  it("should say the same number in prose as it says in the object", async () => {
    const prose = await cli(
      "reference",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      UNTOUCHED,
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run"
    );

    expect(prose).toContain("płatnych wywołań do wykonania: 1");
  });
});
