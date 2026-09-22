import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkOpeningFrame } from "../../lib/opening-frame/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import { EPISODE, makeTrack, makeUpstream, PROJECT } from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 6 asked about on its own: one frame, per track, and no `--artifact`.
 *
 * The flag's absence is the whole shape of this stage and it is not a
 * relaxation of stage 5's rule. Stage 5 demands `--artifact` because it has
 * six candidates and accepting the wrong one buys an image; here the command
 * already says which stage and which track, and there is nothing else it could
 * mean. A flag with one legal value is ceremony standing where a decision used
 * to be, so the panel has none either.
 *
 * The gate is the other half: this frame waits for the references its manifest
 * entry names, accepted **on this track**, which is why the untouched track
 * answers zero and the finished one answers with the picture.
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
  root = await mkdtemp(join(tmpdir(), "aimator-cli-opening-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-opening-src-"));
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

describe("check --stage opening-frame", () => {
  it("should print the stage's own object, plus the two fields that place it", async () => {
    const printed = await object(
      "check",
      PROJECT,
      EPISODE,
      "--stage",
      "opening-frame",
      "--track",
      DRAWN,
      "--json"
    );
    const stage = await checkOpeningFrame({
      episodeId: EPISODE,
      projectId: PROJECT,
      track: DRAWN,
      workspace,
    });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "opening-frame", ...stage.data });
  });
});

describe("approve --stage opening-frame", () => {
  it("should print the stage's own object under --json, without naming an artifact", async () => {
    const printed = await object(
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "opening-frame",
      "--track",
      DRAWN,
      "--reviewer",
      "fixture",
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({
      artifact: { id: "opening-frame" },
      command: "approve",
      stage: "opening-frame",
    });
  });
});

describe("opening-frame generate --json", () => {
  it("should print the report this command returns, with the bill in it", async () => {
    const report = (await object(
      "opening-frame",
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
      artifact: { readonly note: string; readonly state: string };
      command: string;
      paidCalls: number;
      stage: string;
    };

    expect(report.command).toBe("generate");
    expect(report.stage).toBe("opening-frame");
    // Nothing is accepted on this track, and the frame is drawn from R01, so
    // the honest count is none and the note says which yes is missing.
    expect(report.paidCalls).toBe(0);
    expect(report.artifact.note).toContain("R01");
  });

  it("should say the same number in prose as it says in the object", async () => {
    const prose = await cli(
      "opening-frame",
      "generate",
      PROJECT,
      EPISODE,
      "--track",
      UNTOUCHED,
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run"
    );

    expect(prose).toContain("płatnych wywołań do wykonania: 0");
  });
});
