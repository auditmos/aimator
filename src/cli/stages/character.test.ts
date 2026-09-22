import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkCharacter } from "../../lib/character/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import { EPISODE, makeUpstream, PROJECT } from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 2 asked about on its own, and the first stage whose bill is a set.
 *
 * Three stages above this one buy exactly one text call, so their whole bill
 * is "one or none" and the number is almost a formality. Stage 2 draws a card,
 * eight views and a hero, and one command can buy several of them, which makes
 * the count the thing a person actually needs before clicking. So it is
 * reported the way stage 5 reports its own: how many billed image calls this
 * invocation is about, stated before anything is sent.
 *
 * The other claims are the ones every stage before it made: `--json` prints
 * the stage's own object plus `command` and `stage`, `check` and `approve`
 * answer for this stage alone when it is named, and nothing here writes or
 * spends, because `approve` runs with `--dry-run` and `generate` never leaves
 * the dry-run path.
 */

vi.mock("../../lib/env.js", () => ({ env: {} }));

const TRACK = "gpt-image";
const CHARACTER = "ewa";

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

function answer(): string {
  return JSON.stringify({
    clips: [
      { id: "C01", prompt: "Akcja klipu C01.", referenceIds: ["hero:ewa", "hero:tata", "R01"] },
      { id: "C02", prompt: "Akcja klipu C02.", referenceIds: ["hero:ewa", "hero:tata", "R01"] },
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
  root = await mkdtemp(join(tmpdir(), "aimator-cli-character-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-character-src-"));
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;

  await makeUpstream({ answer: answer(), approvePackage: true, root, scratch, workspace });
}, 60_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("check --stage character", () => {
  it("should print the stage's own object, plus the two fields that place it", async () => {
    const printed = await object(
      "check",
      PROJECT,
      CHARACTER,
      "--stage",
      "character",
      "--track",
      TRACK,
      "--json"
    );
    const stage = await checkCharacter({
      characterId: CHARACTER,
      projectId: PROJECT,
      track: TRACK,
      workspace,
    });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "character", ...stage.data });
  });

  it("should answer per track, because the two tracks are drawn separately", async () => {
    const one = await cli("check", PROJECT, CHARACTER, "--stage", "character", "--track", TRACK);
    const other = await cli(
      "check",
      PROJECT,
      CHARACTER,
      "--stage",
      "character",
      "--track",
      "seedream"
    );

    expect(one).toContain(`tor ${TRACK}`);
    expect(other).toContain("tor seedream");
  });
});

describe("approve --stage character", () => {
  it("should print the stage's own object under --json", async () => {
    const printed = await object(
      "approve",
      PROJECT,
      CHARACTER,
      "--stage",
      "character",
      "--track",
      TRACK,
      "--artifact",
      "hero",
      "--reviewer",
      "fixture",
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({ command: "approve", stage: "character" });
    expect(printed).toMatchSnapshot();
  });
});

describe("character generate --json", () => {
  it("should print the report this command returns, with every prompt in it", async () => {
    const printed = (await object(
      "character",
      "generate",
      PROJECT,
      CHARACTER,
      "--track",
      TRACK,
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run",
      "--json"
    )) as {
      artifacts: readonly { readonly prompt: string | null }[];
      command: string;
      stage: string;
    };

    expect(printed.command).toBe("generate");
    expect(printed.stage).toBe("character");
    expect(printed.artifacts.every((one) => one.prompt !== null)).toBe(true);
  });

  /**
   * The first bill on this screen that is a set rather than a coin flip.
   *
   * And it counts **images that would actually be bought**, not names somebody
   * typed: the eight views wait for an accepted card, so asking for the card
   * and a view at once is two artifacts and one purchase. A count of the names
   * would have promised a picture the gate refuses to draw.
   */
  it("should count the images it would buy, not the artifacts it was asked about", async () => {
    const named = (await object(
      "character",
      "generate",
      PROJECT,
      CHARACTER,
      "--track",
      TRACK,
      "--artifact",
      "card,front",
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run",
      "--json"
    )) as {
      artifacts: readonly { readonly artifact: string; readonly state: string }[];
      paidCalls: number;
    };
    const next = (await object(
      "character",
      "generate",
      PROJECT,
      CHARACTER,
      "--track",
      TRACK,
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run",
      "--json"
    )) as { paidCalls: number };

    expect(named.artifacts.map((one) => [one.artifact, one.state])).toEqual([
      ["card", "planned"],
      ["front", "blocked"],
    ]);
    expect(named.paidCalls).toBe(1);
    // Without `--artifact` the gates decide, and on a character with nothing
    // drawn what they allow is the one card the eight views come from.
    expect(next.paidCalls).toBe(1);
  });

  it("should say the same number in prose as it says in the object", async () => {
    const prose = await cli(
      "character",
      "generate",
      PROJECT,
      CHARACTER,
      "--track",
      TRACK,
      "--artifact",
      "card,front",
      "--model",
      "gpt-image-2.5-sunburst",
      "--dry-run"
    );

    expect(prose).toContain("płatnych wywołań do wykonania: 1");
  });
});

describe("--json on a stage that still has no object", () => {
  it("should refuse rather than print prose nobody asked for", async () => {
    const refused = await run([
      "check",
      PROJECT,
      EPISODE,
      // A stage whose object does not exist yet; the list shrinks as panels
      // arrive, and the flag has to refuse for what is left.
      "--stage",
      "sound-design",
      "--track",
      TRACK,
      "--json",
      "--workspace",
      root,
    ]);

    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error.name).toBe("UsageError");
  });
});
