import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./index.js";

/**
 * What is in the workspace at all, which no other command answers.
 *
 * `status` answers "where is this episode", but it has to be told which
 * episode; the question before it, "what is here", had no command, so the only
 * way to answer it was to look in a file manager. That is the one thing a
 * navigation screen needs before it can show anything, and a screen able to
 * answer a question the terminal cannot is exactly the second, better road
 * this tool refuses to build.
 *
 * What this command promises, and what these tests hold it to:
 *
 * - **Ids, and nothing else.** A project is a directory under `projects/`
 *   whose name is a legal id, an episode a directory under its `episodes/`.
 *   Titles, settings and verdicts belong to the stages that own them, and
 *   `status` is one call away.
 * - **Order is alphabetical**, because `readdir` order is the filesystem's
 *   accident rather than anybody's decision.
 * - **An empty workspace is not a refusal.** Nothing here is a failure to
 *   read: a workspace with no projects yet is a state, and it is said in
 *   words rather than by an empty list.
 * - **A workspace nobody configured still is.** The refusal is `common.ts`'s
 *   own and stays in `Result`, with or without `--json`.
 *
 * Not tested here: what a project contains. That is every other command.
 */

let root = "";
let scratch = "";

async function cli(...argv: readonly string[]): Promise<{ ok: boolean; text: string }> {
  const result = await run([...argv, "--workspace", root]);

  return result.ok ? { ok: true, text: result.data } : { ok: false, text: result.error.message };
}

/** An episode needs a source file, and stage 0 reads its id off the name. */
async function episode(projectId: string, name: string): Promise<void> {
  const path = join(scratch, name);

  await writeFile(path, "Nigdy nie przyćmiewaj mistrza.\n", "utf8");
  await cli("episode", "add", projectId, "--source", path);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-list-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-list-src-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("list", () => {
  it("should name every project and every episode under it", async () => {
    await cli("project", "init", "ewa", "--title", "Ewa");
    await cli("project", "init", "alpaka", "--title", "Alpaka");
    await episode("ewa", "01-burza.md");
    await episode("ewa", "02-cisza.md");

    const result = await cli("list");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("alpaka");
    expect(result.text).toContain("ewa");
    expect(result.text).toContain("01-burza");
    expect(result.text).toContain("02-cisza");
  });

  it("should print the same listing as an object under --json", async () => {
    await cli("project", "init", "ewa", "--title", "Ewa");
    await cli("project", "init", "alpaka", "--title", "Alpaka");
    await episode("ewa", "01-burza.md");

    const result = await cli("list", "--json");

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.text)).toEqual({
      command: "list",
      projects: [
        { episodes: [], id: "alpaka" },
        { episodes: ["01-burza"], id: "ewa" },
      ],
      workspace: root,
    });
  });

  it("should say an untouched workspace is empty instead of refusing", async () => {
    const result = await cli("list");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("Brak projektów");
    expect(result.text).toContain("project init");
  });

  it("should keep an unconfigured workspace in Result, with the flag and without", async () => {
    const bare = await run(["list", "--workspace", "  "]);
    const asJson = await run(["list", "--json", "--workspace", "  "]);

    expect(bare.ok).toBe(false);
    expect(asJson.ok).toBe(false);
    expect(asJson.ok ? "" : asJson.error.name).toBe(bare.ok ? "" : bare.error.name);
    expect(asJson.ok ? "" : asJson.error.message).toContain("AIMATOR_WORKSPACE");
  });

  it("should skip a directory whose name could not be an id", async () => {
    await cli("project", "init", "ewa", "--title", "Ewa");
    await mkdir(join(root, "projects", ".DS_Store_dir"), { recursive: true });

    const result = await cli("list", "--json");
    const listing = JSON.parse(result.text) as { readonly projects: readonly { id: string }[] };

    expect(listing.projects.map((project) => project.id)).toEqual(["ewa"]);
  });
});
