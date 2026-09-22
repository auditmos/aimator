import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkShotList } from "../../lib/shot-list/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import { EPISODE, makeUpstream, PROJECT } from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 3 asked about on its own, and answered as an object.
 *
 * The claims are stage 1's, one row down, and they are worth restating because
 * the panel that reads them is the same shape:
 *
 * - **`--json` prints the stage's own object, unchanged**, plus `command` and
 *   `stage`. No second format is designed here and none may be.
 * - **`--stage shot-list` narrows `check` to stage 3.** The wide check glues
 *   four verdicts into one string that cannot be read back apart.
 * - **The bill stands as a number before anything is sent.** Stage 3 buys
 *   exactly one text call, so `paidCalls` is one or zero, and zero is the
 *   answer a blocked gate gives: the panel puts it beside the button that
 *   would spend it rather than leaving a person to find it in a sentence.
 * - **Nothing here writes or spends.** `approve` runs with `--dry-run` and
 *   `generate` never leaves the dry-run path.
 */

vi.mock("../../lib/env.js", () => ({ env: {} }));

let root = "";
let scratch = "";
let workspace: Workspace = { root: "" };

function answer(): string {
  return JSON.stringify({
    clips: [{ id: "C01", prompt: "Akcja klipu C01.", referenceIds: ["hero:ewa"] }],
    entryFrames: [],
    opening: { prompt: "Ewa centralnie, burza za oknem.", referenceIds: ["hero:ewa"] },
    references: [],
    review: "Do rozstrzygnięcia: skala alpaki.",
  });
}

/** What the terminal would print, or the error it would print instead. */
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
  root = await mkdtemp(join(tmpdir(), "aimator-cli-shot-list-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-shot-list-src-"));
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;

  await makeUpstream({ answer: answer(), approvePackage: true, root, scratch, workspace });
  // A second episode, so this file has one stage 3 refuses about: it carries no
  // approved screenplay, which is exactly the gate this stage waits at.
  await writeFile(join(scratch, "02-Slonce.md"), "# Słońce\n\nEwa czeka na słońce.\n", "utf8");
}, 60_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("check --stage shot-list", () => {
  it("should print the stage's own object, plus the two fields that place it", async () => {
    const printed = await object("check", PROJECT, EPISODE, "--stage", "shot-list", "--json");
    const stage = await checkShotList({ episodeId: EPISODE, projectId: PROJECT, workspace });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "shot-list", ...stage.data });
  });

  it("should answer for stage 3 alone, not for the episode's whole text side", async () => {
    const narrow = await cli("check", PROJECT, EPISODE, "--stage", "shot-list");
    const whole = await cli("check", PROJECT, EPISODE);

    expect(narrow).toContain(`Odcinek "${EPISODE}", etap 3:`);
    expect(whole).toContain(narrow);
    expect(narrow).not.toContain("etap 1");
  });
});

describe("approve --stage shot-list", () => {
  it("should print the stage's own object under --json", async () => {
    const printed = await object(
      "approve",
      PROJECT,
      EPISODE,
      "--stage",
      "shot-list",
      "--reviewer",
      "fixture",
      "--dry-run",
      "--json"
    );

    expect(printed).toMatchObject({ command: "approve", stage: "shot-list" });
    expect(printed).toMatchSnapshot();
  });
});

describe("shot-list generate --json", () => {
  it("should print the report this command returns, with the bill in it", async () => {
    const printed = (await object(
      "shot-list",
      "generate",
      PROJECT,
      EPISODE,
      "--model",
      "gpt-6-astra",
      "--dry-run",
      "--json"
    )) as { command: string; paidCalls: number; prompt: string; stage: string };

    expect(printed.command).toBe("generate");
    expect(printed.stage).toBe("shot-list");
    expect(printed.prompt).toContain("# Task");
  });

  /**
   * The bill is the one number that has to be right before a click spends.
   *
   * Stage 3 buys one text call and never more, so the whole range is one and
   * zero, and zero is the answer a blocked gate gives. The second episode is
   * what produces one honestly: it has no approved screenplay, which is the
   * gate this stage refuses at, so the count is the refusal said as a number.
   */
  it("should count the call it would make, and count none when it would refuse", async () => {
    const ready = (await object(
      "shot-list",
      "generate",
      PROJECT,
      EPISODE,
      "--model",
      "gpt-6-astra",
      "--regenerate",
      "--dry-run",
      "--json"
    )) as { paidCalls: number };

    await cli("episode", "add", PROJECT, "--source", join(scratch, "02-Slonce.md"));
    await cli(
      "episode",
      "set",
      PROJECT,
      "02-slonce",
      "--duration",
      "30",
      "--audio",
      "narration",
      "--language",
      "pl",
      "--subtitles",
      "none",
      "--nature",
      "law-or-idea",
      "--max-clip",
      "15"
    );

    const blocked = (await object(
      "shot-list",
      "generate",
      PROJECT,
      "02-slonce",
      "--model",
      "gpt-6-astra",
      "--dry-run",
      "--json"
    )) as { paidCalls: number; problems: readonly string[] };

    expect(ready.paidCalls).toBe(1);
    expect(blocked.problems.length).toBeGreaterThan(0);
    expect(blocked.paidCalls).toBe(0);
  });

  it("should say the same number in prose as it says in the object", async () => {
    const prose = await cli(
      "shot-list",
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
