import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkStage0 } from "../../lib/project/index.js";
import { resolveWorkspace, type Workspace } from "../../lib/workspace.js";
import { png } from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * Stage 0 answered as an object, by all seven commands that write it.
 *
 * It is one test file for three CLI files, and that is the stage rather than a
 * shortcut: `project`, `episode` and `character` are three grammars writing one
 * artifact, so what is being proved here, **every stage-0 command prints the
 * same report under `--json`**, is a claim about the stage and cannot be made
 * in any one of them. The split of `src/cli` is by command because a command is
 * what the parser dispatches on; the split of a stage's contract is by stage.
 *
 * Assumptions this file encodes, stated before the first test rather than
 * discovered by it:
 *
 * - **Every stage-0 command prints `Stage0Report`, unchanged.** The seven of
 *   them already share one renderer, so they share one object; no second format
 *   is designed here and none may be.
 * - **`command` is two words for stage 0**, because `character add` and
 *   `episode add` are different commands writing the same stage, and a field
 *   that said `add` for both would answer "which command wrote this" with a
 *   guess.
 * - **`--stage prepare` narrows `check` to stage 0**, exactly as
 *   `--stage screenplay` narrows it to stage 1, even when an episode is named.
 *   The wide check glues four verdicts into one string that cannot be read back
 *   apart, which is the right answer for a person and the wrong one for a panel.
 * - **A source path travels to the archive unchanged.** The browser types a
 *   path and the CLI copies the file, so `originPath` has to be the path that
 *   was typed: an upload would have recorded a temporary directory, which is
 *   why the PRD refused one.
 * - **Nothing here needs a fixture.** The whole point is the empty workspace: a
 *   person opening this tool for the first time has one, and stage 0 is what
 *   they do in it.
 */

vi.mock("../../lib/env.js", () => ({ env: {} }));

const PROJECT = "dzielna-ewa";
const EPISODE = "01-burza";

/** Every stage-0 command, in the words `--help` spells them. */
const COMMANDS = [
  "project init",
  "project voice",
  "character new",
  "character add",
  "character describe",
  "episode add",
  "episode set",
  "check",
  "approve",
] as const;

let root = "";
let scratch = "";
let source = "";
let workspace: Workspace = { root: "" };

const reports = new Map<string, unknown>();

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
  root = await mkdtemp(join(tmpdir(), "aimator-cli-prepare-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-prepare-src-"));
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;
  source = join(scratch, "01-Burza.md");

  const photo = join(scratch, "ewa.png");

  await writeFile(source, "# Burza\n\nEwa boi się burzy.\n", "utf8");
  await writeFile(photo, png(64, 64));

  // The whole ladder of stage 0, climbed through `run` and nothing else, in
  // the order a person climbs it: the project, its cast, its narrator, the
  // episode, its five settings, and only then the yes.
  reports.set(
    "project init",
    await object(
      "project",
      "init",
      PROJECT,
      "--title",
      "Dzielna Ewa",
      "--aspect-ratio",
      "16:9",
      "--json"
    )
  );
  await writeFile(
    join(root, "projects", PROJECT, "project.md"),
    "# Dzielna Ewa, zasady wspólne\n\nPłaskie 2D. Paleta dziesięciu barw.\n",
    "utf8"
  );
  reports.set(
    "character new",
    await object("character", "new", PROJECT, "ewa", "--name", "Ewa", "--json")
  );
  await cli("character", "new", PROJECT, "tata", "--name", "Tata");
  reports.set(
    "character add",
    await object("character", "add", PROJECT, "ewa", "--source", photo, "--json")
  );
  reports.set(
    "character describe",
    await object("character", "describe", PROJECT, "tata", "--json")
  );
  reports.set(
    "project voice",
    await object("project", "voice", PROJECT, "--voice-id", "voice-1", "--json")
  );
  reports.set("episode add", await object("episode", "add", PROJECT, "--source", source, "--json"));
  reports.set(
    "episode set",
    await object(
      "episode",
      "set",
      PROJECT,
      EPISODE,
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
      "15",
      "--json"
    )
  );
  reports.set("check", await object("check", PROJECT, "--stage", "prepare", "--json"));
  reports.set(
    "approve",
    await object("approve", PROJECT, "--stage", "prepare", "--reviewer", "fixture", "--json")
  );
}, 60_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("every stage-0 command under --json", () => {
  it.each(COMMANDS)("should print the stage's report for %s", (command) => {
    expect(reports.get(command)).toMatchSnapshot();
  });

  it("should say which command wrote the object, and which stage", () => {
    for (const command of COMMANDS) {
      expect(reports.get(command)).toMatchObject({ command, stage: "prepare" });
    }
  });
});

describe("check --stage prepare", () => {
  it("should print the stage's own object, plus the two fields that place it", async () => {
    const printed = await object("check", PROJECT, "--stage", "prepare", "--json");
    const stage = await checkStage0({ projectId: PROJECT, workspace });

    if (!stage.ok) {
      throw stage.error;
    }

    expect(printed).toEqual({ command: "check", stage: "prepare", ...stage.data });
  });

  /**
   * Naming the stage narrows the question, even when an episode is named too.
   *
   * The wide check reads the episode's whole text side and glues four verdicts
   * into one string. That is the right answer for a person at a terminal and an
   * unreadable one for anything that wants stage 0's verdict, which is exactly
   * why `--stage` exists.
   */
  it("should answer for stage 0 alone when an episode is named as well", async () => {
    const narrow = await cli("check", PROJECT, EPISODE, "--stage", "prepare");
    const whole = await cli("check", PROJECT, EPISODE);

    expect(whole).toContain(narrow);
    expect(narrow).not.toContain("etap 1");
  });
});

describe("the path a person types", () => {
  /**
   * The archive records where a file came from, so the path has to survive.
   *
   * This is the whole reason the PRD refused an upload: a browser handing over
   * bytes would have made the recorded origin a temporary directory, and
   * "skąd to jest" would have become unanswerable from the file itself.
   */
  it("should reach the episode's archive exactly as it was given", async () => {
    const episode: unknown = JSON.parse(
      await readFile(join(root, "projects", PROJECT, "episodes", EPISODE, "episode.json"), "utf8")
    );

    expect(episode).toMatchObject({ source: { originPath: source } });
  });
});
