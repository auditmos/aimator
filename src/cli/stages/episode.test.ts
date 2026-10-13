import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkStage0 } from "../../lib/project/index.js";
import { checkScreenplay } from "../../lib/screenplay/index.js";
import {
  type EpisodePaths,
  episodePaths,
  projectPaths,
  resolveWorkspace,
  type Workspace,
} from "../../lib/workspace.js";
import { EPISODE, makeUpstream, PROJECT } from "../../test/fixture.js";
import { run } from "../index.js";

/**
 * `episode lip-sync`: which language the mouths move in, an episode decision
 * that lives in a file of its own. It is an input of the second-language script
 * and of stage 12 alone, so recording it must lapse nothing above them: not
 * stage 0, whose `episode.json` it deliberately stays out of, and not the
 * screenplay, which reads that file.
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

function episode(): EpisodePaths {
  const project = projectPaths(workspace, PROJECT);
  const paths = project.ok ? episodePaths(project.data, EPISODE) : null;

  if (!paths?.ok) {
    throw new Error("nie ma ścieżek odcinka");
  }

  return paths.data;
}

function lipSync(...flags: readonly string[]) {
  return run(["episode", "lip-sync", PROJECT, EPISODE, ...flags, "--workspace", root]);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aimator-cli-episode-"));
  scratch = await mkdtemp(join(tmpdir(), "aimator-cli-episode-src-"));
  const resolved = resolveWorkspace(root);

  if (!resolved.ok) {
    throw resolved.error;
  }

  workspace = resolved.data;

  await makeUpstream({
    answer: answer(),
    approvePackage: true,
    dialogue: true,
    root,
    scratch,
    workspace,
  });
}, 60_000);

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
  await rm(scratch, { force: true, recursive: true });
});

describe("episode lip-sync", () => {
  it("should record the language of the mouths and lapse neither stage 0 nor the screenplay", async () => {
    const result = await lipSync("--language", "en", "--json");
    const stage0 = await checkStage0({ projectId: PROJECT, workspace });
    const screenplay = await checkScreenplay({ episodeId: EPISODE, projectId: PROJECT, workspace });

    expect(result.ok ? JSON.parse(result.data) : result.error.message).toMatchObject({
      command: "episode lip-sync",
      language: "en",
    });
    expect(JSON.parse(await readFile(episode().lipSync, "utf8"))).toEqual({
      language: "en",
      schemaVersion: 1,
    });
    expect(stage0.ok ? stage0.data.approved : stage0.error.message).toBe(true);
    expect(screenplay.ok ? screenplay.data.approved : screenplay.error.message).toBe(true);
  });

  it("should refuse the film's own language, which no mouth has to be moved for", async () => {
    const result = await lipSync("--language", "pl");

    expect(result.ok ? null : result.error.message).toContain("językiem filmu");
  });

  it("should record a deliberate no, which is not the same as nobody deciding", async () => {
    const result = await lipSync("--none");

    expect(result.ok ? result.data : result.error.message).toContain("none");
    expect(JSON.parse(await readFile(episode().lipSync, "utf8"))).toEqual({
      language: "none",
      schemaVersion: 1,
    });
  });

  it("should take exactly one answer", async () => {
    const neither = await lipSync();
    const both = await lipSync("--language", "en", "--none");

    expect(neither.ok ? null : neither.error.message).toContain("--language <kod> albo --none");
    expect(both.ok ? null : both.error.message).toContain("--language <kod> albo --none");
  });

  it("should write nothing under --dry-run", async () => {
    const before = await readFile(episode().lipSync, "utf8");
    const result = await lipSync("--language", "de", "--dry-run");

    expect(result.ok ? result.data : result.error.message).toContain("Próba na sucho");
    expect(await readFile(episode().lipSync, "utf8")).toBe(before);
  });
});
