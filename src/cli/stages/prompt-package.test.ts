import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkPromptPackage } from "../../lib/prompt-package/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import { EPISODE, makeUpstream, PROJECT } from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 4 asked about on its own, and the free preview of a send as an object.
 *
 * Two commands, two different claims:
 *
 * - `check`, `approve` and `generate` answer with the stage's own object, the
 *   way stages 0, 1 and 3 already do.
 * - `show` answers with the **send plan**, which is the one place rule 8 is
 *   visible before anything is sent: the attachments of one future paid call,
 *   in the order their bytes will travel, addressed by position. The panel
 *   arranges that list, so it has to arrive as an object rather than as the
 *   sentence a terminal prints.
 *
 * The one thing a printed plan cannot carry is the attachment's **bytes**, and
 * that is a property of JSON rather than a decision taken here: the plan holds
 * them for the stage that will POST them, and a reader of a plan is answered
 * by the id, the path, the role, the digest and the state. Everything else
 * travels unchanged.
 */

vi.mock("../../lib/env.js", () => ({ env: {} }));

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

/** A package with something in it: a reference, two clips and an entry frame. */
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
  root = await mkdtemp(join(tmpdir(), "aimator-cli-package-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-package-src-"));
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

describe("check --stage prompt-package", () => {
  it("should print the stage's own object, plus the two fields that place it", async () => {
    const printed = await object("check", PROJECT, EPISODE, "--stage", "prompt-package", "--json");
    const stage = await checkPromptPackage({ episodeId: EPISODE, projectId: PROJECT, workspace });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "prompt-package", ...stage.data });
  });

  it("should answer for stage 4 alone, not for the episode's whole text side", async () => {
    const narrow = await cli("check", PROJECT, EPISODE, "--stage", "prompt-package");
    const whole = await cli("check", PROJECT, EPISODE);

    expect(narrow).toContain(`Odcinek "${EPISODE}", etap 4:`);
    expect(whole).toContain(narrow);
    expect(narrow).not.toContain("etap 3");
  });
});

describe("approve --stage prompt-package", () => {
  it("should print the stage's own object under --json", async () => {
    const printed = await object(
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "prompt-package",
      "--reviewer",
      "fixture",
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({ command: "approve", stage: "prompt-package" });
  });
});

describe("prompt-package generate --json", () => {
  it("should print the report this command returns, with the bill in it", async () => {
    const printed = (await object(
      "prompt-package",
      "generate",
      PROJECT,
      EPISODE,
      "--model",
      "gpt-6-astra",
      "--regenerate",
      "--dry-run",
      "--json"
    )) as { command: string; paidCalls: number; prompt: string; stage: string };

    expect(printed.command).toBe("generate");
    expect(printed.stage).toBe("prompt-package");
    expect(printed.paidCalls).toBe(1);
    expect(printed.prompt).toContain("# Task");
  });

  it("should say the same number in prose as it says in the object", async () => {
    const prose = await cli(
      "prompt-package",
      "generate",
      PROJECT,
      EPISODE,
      "--model",
      "gpt-6-astra",
      "--regenerate",
      "--dry-run"
    );

    expect(prose).toContain("płatnych wywołań do wykonania: 1");
  });
});

describe("prompt-package show --json", () => {
  it("should print the send plan of one track, attachments in the order they travel", async () => {
    const plan = (await object(
      "prompt-package",
      "show",
      PROJECT,
      EPISODE,
      "--track",
      "gpt-image",
      "--json"
    )) as {
      artifacts: readonly {
        readonly attachments: readonly { readonly id: string; readonly role: string }[];
        readonly name: string;
      }[];
      command: string;
      limit: number;
      stage: string;
      track: string;
    };

    expect(plan.command).toBe("show");
    expect(plan.stage).toBe("prompt-package");
    expect(plan.track).toBe("gpt-image");
    expect(plan.limit).toBeGreaterThan(0);
    expect(plan.artifacts.map((one) => one.name)).toEqual([
      "R01",
      "opening-frame",
      "C01",
      "entry:C02",
      "C02",
    ]);
    expect(plan.artifacts[0]?.attachments.every((one) => one.role !== "")).toBe(true);
  });

  /**
   * The bytes are the one field a printed plan cannot carry, and must not.
   *
   * They exist so the sending stage can POST the file; a JSON document has no
   * bytes, and serialising a Buffer would put a megabyte of decimal numbers
   * into a plan somebody asked to read. The digest is what identifies the file
   * here, exactly as it does everywhere else in this pipeline.
   */
  it("should leave the attachment's bytes out, and keep its digest", async () => {
    const printed = await cli(
      "prompt-package",
      "show",
      PROJECT,
      EPISODE,
      "--track",
      "gpt-image",
      "--json"
    );
    const plan = JSON.parse(printed) as {
      artifacts: readonly {
        readonly attachments: readonly { readonly sha256: string | null }[];
      }[];
    };

    expect(printed).not.toContain('"bytes"');
    expect(
      plan.artifacts.flatMap((one) => one.attachments).some((one) => one.sha256 !== null)
    ).toBe(true);
  });

  it("should compose the whole text of the artifact it is asked about", async () => {
    const plan = (await object(
      "prompt-package",
      "show",
      PROJECT,
      EPISODE,
      "--track",
      "gpt-image",
      "--artifact",
      "opening-frame",
      "--json"
    )) as { artifacts: readonly { readonly name: string; readonly text: string | null }[] };
    const composed = plan.artifacts.find((one) => one.name === "opening-frame");

    expect(composed?.text).toContain("Image 1 =");
  });
});
