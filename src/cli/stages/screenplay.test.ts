import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkScreenplay } from "../../lib/screenplay/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import { EPISODE, makeUpstream, PROJECT } from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 1 asked about on its own, and answered as an object.
 *
 * `check <id> <episode-id>` reads the episode's whole text side, which is the
 * right question for a person at a terminal and the wrong one for anything
 * that wants stage 1's verdict: four stages rendered into one string cannot be
 * read back apart. So the stage gets named, exactly as `approve` already names
 * it, and the answer is the object `checkScreenplay` returns, with one field
 * saying which command wrote it.
 *
 * Assumptions this file encodes, stated before the first test rather than
 * discovered by it:
 *
 * - **`--json` prints the stage's own object, unchanged.** No second format is
 *   designed here: what the browser reads is what the module returned, plus
 *   `command` and `stage`, which is the shape `status` and `list` already set.
 * - **`--json` without a stage it can answer is a usage error**, not an empty
 *   object and not the text. A flag that silently does nothing on eleven of
 *   twelve paths is a promise the usage text would be making falsely; the
 *   refusal names the one spelling that works.
 * - **The narrow check is the wide one's stage-1 half, to the character.** Two
 *   renderings of one verdict would drift at the first correction, so the
 *   claim is textual identity rather than "says something similar".
 * - **Nothing here writes or spends.** `approve` runs with `--dry-run`, which
 *   by contract records nothing, so the fixture's stage 1 stays as it was.
 *
 * Not tested here: the screenplay's own verdict, which is proved in
 * `lib/screenplay`, and the ladder that carries this object as a cell, which is
 * proved in `cli/status.test.ts`.
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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-cli-screenplay-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-screenplay-src-"));
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

describe("check --stage screenplay", () => {
  it("should answer with the stage-1 half of the episode's check, unchanged", async () => {
    const narrow = await cli("check", PROJECT, EPISODE, "--stage", "screenplay");
    const whole = await cli("check", PROJECT, EPISODE);

    expect(narrow).toContain(`Odcinek "${EPISODE}", etap 1:`);
    expect(whole).toContain(narrow);
    expect(narrow).not.toContain("etap 3");
  });

  it("should print the stage's own object under --json, plus the command", async () => {
    const printed: unknown = JSON.parse(
      await cli("check", PROJECT, EPISODE, "--stage", "screenplay", "--json")
    );
    const stage = await checkScreenplay({ episodeId: EPISODE, projectId: PROJECT, workspace });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "screenplay", ...stage.data });
  });
});

describe("approve --stage screenplay", () => {
  it("should print the stage's own object under --json, plus the command", async () => {
    const printed: unknown = JSON.parse(
      await cli(
        "approve",
        PROJECT,
        EPISODE,
        "--stage",
        "screenplay",
        "--reviewer",
        "fixture",
        "--dry-run",
        "--json"
      )
    );
    const stage = await checkScreenplay({ episodeId: EPISODE, projectId: PROJECT, workspace });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "approve", stage: "screenplay", ...stage.data });
  });
});

describe("--json on a stage that has no object yet", () => {
  it("should refuse rather than print prose nobody asked for", async () => {
    const refused = await run(["check", PROJECT, EPISODE, "--json", "--workspace", root]);

    expect(refused.ok).toBe(false);

    if (refused.ok) {
      return;
    }

    expect(refused.error.name).toBe("UsageError");
    expect(refused.error.message).toContain("--stage screenplay");
  });

  it("should refuse an approval the same way", async () => {
    const refused = await run([
      "approve",
      PROJECT,
      EPISODE,
      // A stage whose object does not exist yet. The list shrinks as panels
      // arrive, which is exactly what this test is watching: the flag refuses
      // for what is left rather than quietly printing prose.
      "--stage",
      "assembly",
      "--json",
      "--dry-run",
      "--workspace",
      root,
    ]);

    expect(refused.ok).toBe(false);

    if (refused.ok) {
      return;
    }

    expect(refused.error.name).toBe("UsageError");
    expect(refused.error.message).toContain("--stage screenplay");
  });
});
