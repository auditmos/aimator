import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkStyle } from "../../lib/style/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import { makeUpstream, PROJECT, RULES } from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Generated style frames, through the terminal: the paid command, its check and
 * its approval. Under `--json` each prints the module's object plus `command`
 * and `stage`, as every other stage does; nothing here spends, because the only
 * command that would is run with `--dry-run`.
 */

vi.mock("../../lib/env.js", () => ({ env: {} }));

const TRACK = "gpt-image";
const BIBLE = `${RULES}\n## Style Bible\n\n- Style line: flat 2D cutout.\n- Palette: #1B2A41, #FDF6EC.\n- Linework rule: 4 px outer line.\n- Always / never: none.\n`;

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
    opening: { prompt: "Ewa centralnie.", referenceIds: ["hero:ewa", "R01"] },
    references: [
      {
        dependsOn: ["hero:ewa"],
        id: "R01",
        kind: "location",
        prompt: "Salon z niską kanapą.",
        subject: "Living room, evening",
      },
    ],
    review: "Do rozstrzygnięcia: nic.",
  });
}

async function cli(...argv: readonly string[]): Promise<string> {
  const result = await run([...argv, "--workspace", root]);

  if (!result.ok) {
    throw result.error;
  }

  return result.data;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-style-"));
  root = join(scratch, "workspace");
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;

  await makeUpstream({
    answer: answer(),
    approvePackage: true,
    root,
    rules: BIBLE,
    scratch,
    style: { generated: 2 },
    workspace,
  });
}, 60_000);

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("style generate --dry-run", () => {
  it("should state the bill and print every prompt in full", async () => {
    const text = await cli(
      "style",
      "generate",
      PROJECT,
      "--track",
      TRACK,
      "--model",
      "m",
      "--dry-run"
    );

    expect(text).toContain("płatnych wywołań do wykonania: 2");
    expect(text).toContain("--- prompt dla S01 (dokładnie ten tekst) ---");
    expect(text).toContain("style frame 2 of 2");
  });

  it("should print the module's report under --json, placed by command and stage", async () => {
    const printed = JSON.parse(
      await cli(
        "style",
        "generate",
        PROJECT,
        "--track",
        TRACK,
        "--model",
        "m",
        "--dry-run",
        "--json"
      )
    );

    expect(printed).toMatchObject({ command: "generate", paidCalls: 2, stage: "style" });
  });
});

describe("check --stage style", () => {
  it("should print the stage's own object, plus the two fields that place it", async () => {
    const printed = JSON.parse(
      await cli("check", PROJECT, "--stage", "style", "--track", TRACK, "--json")
    );
    const stage = await checkStyle({ projectId: PROJECT, track: TRACK, workspace });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "style", ...stage.data });
  });
});

describe("approve --stage style", () => {
  it("should refuse without --artifact, because each image is its own judgement", async () => {
    const result = await run([
      "approve",
      PROJECT,
      "--stage",
      "style",
      "--track",
      TRACK,
      "--reviewer",
      "t",
      "--workspace",
      root,
    ]);

    expect(result.ok ? null : result.error.message).toContain("--artifact");
  });
});
